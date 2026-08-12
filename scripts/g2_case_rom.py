#!/usr/bin/env python3
"""Safety-scoped STM32 ROM-loader primitives for the Even G2 charging case.

Only the immutable ROM operations needed by the volatile pogo bridge are
implemented: identify, read SRAM, write allowlisted SRAM, and execute SRAM.
There is intentionally no flash erase, flash write, option-byte write, or
protection command.
"""

from __future__ import annotations

import re
import time

import serial


ACK = 0x79
NACK = 0x1F
SYNC = 0x7F
GET = 0x00
GET_ID = 0x02
READ_MEMORY = 0x11
GO = 0x21
WRITE_MEMORY = 0x31

EXPECTED_PROTOCOL_VERSION = 0x31
EXPECTED_PRODUCT_ID = 0x0467
EXPECTED_COMMANDS = frozenset(
    (0x00, 0x01, 0x02, 0x11, 0x21, 0x31, 0x44, 0x63, 0x73, 0x82, 0x92)
)
SRAM_ADDRESS = 0x20010000


class BootloaderError(RuntimeError):
    """The immutable STM32 ROM loader rejected or truncated an operation."""


def read_exact(port: serial.Serial, count: int, what: str) -> bytes:
    result = bytearray()
    while len(result) < count:
        chunk = port.read(count - len(result))
        if not chunk:
            raise BootloaderError(
                f"timeout reading {what}: got {len(result)} of {count} bytes"
            )
        result.extend(chunk)
    return bytes(result)


def expect_ack(port: serial.Serial, what: str) -> None:
    response = read_exact(port, 1, what)[0]
    if response == NACK:
        raise BootloaderError(f"NACK while waiting for {what}")
    if response != ACK:
        raise BootloaderError(
            f"unexpected 0x{response:02x} while waiting for {what}"
        )


def send_command(port: serial.Serial, command: int, what: str) -> None:
    port.write(bytes((command, command ^ 0xFF)))
    port.flush()
    expect_ack(port, f"{what} command ACK")


def open_rom_loader(device: str) -> serial.Serial:
    """Reset the case into its immutable USART ROM loader.

    On the observed CH340/case wiring, DTR low selects system memory and RTS
    asserts reset.
    """
    port = serial.Serial()
    port.port = device
    port.baudrate = 115_200
    port.bytesize = serial.EIGHTBITS
    port.parity = serial.PARITY_EVEN
    port.stopbits = serial.STOPBITS_ONE
    port.timeout = 3.0
    port.write_timeout = 3.0
    port.dtr = False
    port.rts = True
    port.open()
    try:
        time.sleep(0.05)
        port.rts = False
        time.sleep(0.15)
        port.reset_input_buffer()
        port.write(bytes((SYNC,)))
        port.flush()
        expect_ack(port, "bootloader sync ACK")
        return port
    except Exception:
        port.close()
        raise


def get_commands(port: serial.Serial) -> tuple[int, set[int]]:
    send_command(port, GET, "Get")
    following_minus_one = read_exact(port, 1, "Get response length")[0]
    response = read_exact(
        port, following_minus_one + 1, "Get version and command table"
    )
    expect_ack(port, "Get final ACK")
    if not response:
        raise BootloaderError("Get returned no bootloader version")
    return response[0], set(response[1:])


def get_product_id(port: serial.Serial) -> int:
    send_command(port, GET_ID, "Get ID")
    following_minus_one = read_exact(port, 1, "Get ID response length")[0]
    raw_id = read_exact(port, following_minus_one + 1, "Get ID value")
    expect_ack(port, "Get ID final ACK")
    if len(raw_id) != 2:
        raise BootloaderError(
            f"expected a two-byte product ID, got {len(raw_id)}"
        )
    return int.from_bytes(raw_id, "big")


def require_expected_identity(port: serial.Serial) -> None:
    version, commands = get_commands(port)
    product_id = get_product_id(port)
    if (
        version != EXPECTED_PROTOCOL_VERSION
        or product_id != EXPECTED_PRODUCT_ID
    ):
        raise BootloaderError(
            "unexpected case ROM identity "
            f"protocol=0x{version:02x}, product=0x{product_id:04x}"
        )
    if commands != EXPECTED_COMMANDS:
        missing = EXPECTED_COMMANDS - commands
        extra = commands - EXPECTED_COMMANDS
        raise BootloaderError(
            "case ROM command table differs from the reviewed device "
            f"(missing={sorted(missing)}, extra={sorted(extra)})"
        )


def _read_memory_once(port: serial.Serial, address: int, size: int) -> bytes:
    if not 1 <= size <= 256:
        raise ValueError("STM32 ROM reads must be between 1 and 256 bytes")
    send_command(port, READ_MEMORY, "Read Memory")
    address_bytes = address.to_bytes(4, "big")
    checksum = (
        address_bytes[0]
        ^ address_bytes[1]
        ^ address_bytes[2]
        ^ address_bytes[3]
    )
    port.write(address_bytes + bytes((checksum,)))
    port.flush()
    expect_ack(port, "Read Memory address ACK")
    encoded_size = size - 1
    port.write(bytes((encoded_size, encoded_size ^ 0xFF)))
    port.flush()
    expect_ack(port, "Read Memory length ACK")
    return read_exact(port, size, f"memory at 0x{address:08x}")


def _resynchronize_rom_loader(port: serial.Serial) -> None:
    """Re-enter and re-identify ROM after a truncated CH340 response."""

    if port.is_open:
        port.close()
    port.dtr = False
    port.rts = True
    port.open()
    time.sleep(0.05)
    port.rts = False
    time.sleep(0.15)
    port.reset_input_buffer()
    port.write(bytes((SYNC,)))
    port.flush()
    expect_ack(port, "bootloader resynchronization ACK")
    require_expected_identity(port)


def read_memory(
    port: serial.Serial,
    address: int,
    size: int,
    *,
    attempts: int = 5,
) -> bytes:
    """Read one exact block, restarting the ROM session after a short reply.

    The STM32 has already completed the command when a CH340 USB transfer is
    truncated. Continuing the partial prefix would desynchronize the next ACK,
    so discard it and reread the complete address in a newly identified loader
    session. Only read-only commands are repeated.
    """

    if attempts < 1:
        raise ValueError("read attempts must be positive")
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return _read_memory_once(port, address, size)
        except (BootloaderError, OSError, serial.SerialException) as error:
            last_error = error
            if attempt == attempts:
                break
            _resynchronize_rom_loader(port)
    raise BootloaderError(
        f"{attempts} read-only ROM sessions failed at 0x{address:08x}: "
        f"{last_error}"
    ) from last_error


def write_sram(port: serial.Serial, address: int, data: bytes) -> None:
    """Write one aligned SRAM block.

    Callers must apply their own exact address+content allowlist first.
    """
    if (
        not data
        or len(data) > 256
        or len(data) % 4
        or address < SRAM_ADDRESS
        or address % 4
    ):
        raise BootloaderError("invalid STM32 SRAM write bounds/alignment")
    send_command(port, WRITE_MEMORY, "Write Memory")
    address_bytes = address.to_bytes(4, "big")
    address_checksum = (
        address_bytes[0]
        ^ address_bytes[1]
        ^ address_bytes[2]
        ^ address_bytes[3]
    )
    port.write(address_bytes + bytes((address_checksum,)))
    port.flush()
    expect_ack(port, "Write Memory SRAM address ACK")
    encoded_size = len(data) - 1
    checksum = encoded_size
    for value in data:
        checksum ^= value
    port.write(bytes((encoded_size,)) + data + bytes((checksum,)))
    port.flush()
    expect_ack(port, "Write Memory SRAM data ACK")


def go_sram(port: serial.Serial) -> None:
    send_command(port, GO, "Go")
    address = SRAM_ADDRESS.to_bytes(4, "big")
    checksum = address[0] ^ address[1] ^ address[2] ^ address[3]
    port.write(address + bytes((checksum,)))
    port.flush()
    expect_ack(port, "Go SRAM address ACK")


def restore_application(
    device: str,
    *,
    expected_version: str | None = None,
    timeout: float = 5.0,
) -> str:
    """Reset into normal flash and require the case startup banner."""
    port = serial.Serial()
    port.port = device
    port.baudrate = 1_000_000
    port.bytesize = serial.EIGHTBITS
    port.parity = serial.PARITY_NONE
    port.stopbits = serial.STOPBITS_ONE
    port.timeout = 0.2
    port.write_timeout = 1.0
    port.dtr = True
    port.rts = True
    port.open()
    try:
        time.sleep(0.05)
        port.rts = False
        deadline = time.monotonic() + timeout
        captured = bytearray()
        while time.monotonic() < deadline:
            captured.extend(port.read(4096))
            match = re.search(rb"\*{6} B200 ([0-9.]+) ", captured)
            if match and b"Power up..." in captured:
                version = match.group(1).decode("ascii", errors="replace")
                if expected_version is not None and version != expected_version:
                    raise BootloaderError(
                        f"case application is {version}, expected "
                        f"{expected_version}"
                    )
                return version
        raise BootloaderError("normal case application banner was not observed")
    finally:
        port.close()

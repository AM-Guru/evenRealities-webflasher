#!/usr/bin/env python3
"""Fail-closed Even Realities G2 main-firmware flasher for the pogo UART.

This tool implements the running temple application's recovered product-test
OTA wrapper (commands 0x52 through 0x55).  It deliberately supports only the
Apollo main component from a complete, validated EVENOTA package.

The serial transport must expose the *raw temple UART* at 1,000,000 baud,
8N1.  The stock charging-case CH340 console is not such an endpoint; use the
sibling ``g2_case_pogo_flasher.py`` tool for the reviewed volatile case-to-pogo
transport.

Examples:

  python3 g2_pogo_flasher.py inspect firmware.bin
  python3 g2_pogo_flasher.py preflight --device /dev/cu.usbserial-X \
      --direct-temple-uart-confirmed
  python3 g2_pogo_flasher.py flash firmware.bin \
      --device /dev/cu.usbserial-X \
      --direct-temple-uart-confirmed \
      --execute-main-ota \
      --accept-single-slot-risk \
      --confirm-image-sha256 <sha256>

The bootloader component is always rejected.  A 0x55 success response is not
proof that a bootloader MRAM copy succeeded, and no independent dead-device
recovery path has been proven on retail G2 hardware.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import time
import zlib
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol

import serial

from g2_pogo_protocol import (
    COMPONENT_HEADER_SIZE,
    DEFERRED_BATCH_SIZE,
    Component,
    build_response,
    component_wire_summary,
    crc32c_msb,
    iter_component_data_requests,
    parse_evenota,
    parse_response,
    production_ota_finish_request,
    production_ota_header_request,
    production_ota_start_request,
    version_request,
)


EXPECTED_TYPE_ORDER = (4, 5, 3, 6, 1, 0)
EXPECTED_FILENAME_ORDER = (
    "firmware/codec.bin",
    "firmware/ble_em9305.bin",
    "firmware/touch.bin",
    "firmware/box.bin",
    "ota/s200_bootloader.bin",
    "ota/s200_firmware_ota.bin",
)
TOC_TRAILER = b"evenota\0" + b"\0" * 8
MAIN_TYPE_ID = 0
MAIN_FILENAME = "ota/s200_firmware_ota.bin"
MAIN_RUN_BASE = 0x00438000
MAIN_FLAG_ADDRESS = 0x007FE000
MAIN_DATA_TYPE = 0xCB
VERSION_RE = re.compile(r"^s200_v(\d+\.\d+\.\d+\.\d+)$")
FINAL_RESTORE_REQUIREMENT = (
    "After a raw-UART transfer, restore through the Case and make the traced "
    "DEB0 bilateral reset the final temple mutation, then verify both selected "
    "contacts and checksum-valid version liveness."
)


def ota_transition_recovery_guidance(command: int) -> str:
    """Return the fail-closed operator action for a non-idempotent transition."""
    if command == 0x52:
        return (
            "Do not replay START in this session or loop fresh wired attempts. "
            "After the fixture/Case route is verified restored, issue the "
            "bilateral DEB0 reset. If the temple still advertises, use a fresh "
            "BLE connection to install the complete six-component hash-pinned "
            "package, then finish with DEB0 and read-only bilateral liveness."
        )
    if command == 0x53:
        return (
            "Do not replay HEADER in this session. Preserve the audit, verify "
            "fixture/Case route cleanup, issue the bilateral DEB0 reset, and "
            "begin any retry as a completely fresh recovery session."
        )
    return (
        "Do not replay FINISH. Preserve the audit as failed or uncertain, "
        "restore the fixture/Case route, issue the bilateral DEB0 reset, and "
        "use read-only liveness plus the next fresh recovery session to decide "
        "whether the complete package must be reinstalled."
    )


class FlasherError(RuntimeError):
    """Base class for controlled flasher failures."""


class SafetyError(FlasherError):
    """The requested operation violates a fail-closed safety invariant."""


class TransportTimeout(FlasherError):
    """A serial response did not arrive within the bounded timeout."""


class ProtocolError(FlasherError):
    """A response or package does not match the recovered protocol."""


class DeviceRejected(FlasherError):
    """The temple returned a nonzero product-OTA status."""


class NonIdempotentOtaError(SafetyError):
    """A START, HEADER, or FINISH result became uncertain and must not replay."""

    def __init__(self, stage: str, command: int, cause: Exception) -> None:
        self.stage = stage
        self.command = command
        self.recovery_recommendation = ota_transition_recovery_guidance(command)
        super().__init__(
            f"{stage} (0x{command:02x}) failed and was not replayed: {cause}. "
            f"{self.recovery_recommendation}"
        )


@dataclass(frozen=True)
class PackagePlan:
    image_path: str
    image_bytes: int
    image_sha256: str
    package_version: str
    expected_device_version: str
    build_date: str
    build_time: str
    main_payload_bytes: int
    main_payload_sha256: str
    main_record_count: int
    main_installed_bytes: int
    main_installed_end: str


@dataclass(frozen=True)
class DeviceVersion:
    firmware: str
    hardware: int


@dataclass(frozen=True)
class FlashResult:
    records_sent: int
    payload_bytes_sent: int
    data_retries: int
    finish_ack_received: bool


class TempleTransport(Protocol):
    def transact(self, request: bytes, timeout: float) -> bytes:
        """Send one temple request and return one complete framed response."""

    def drain_input(self) -> None:
        """Discard stale input before a new, independent transaction."""

    def close(self) -> None:
        """Release the transport."""


def _c_string(data: bytes, start: int, end: int) -> str:
    raw = data[start:end].split(b"\0", 1)[0]
    return raw.decode("ascii", errors="strict")


def _u32(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise ProtocolError(f"word at 0x{offset:x} exceeds input")
    return struct.unpack_from("<I", data, offset)[0]


def _validate_outer_layout(image: bytes, components: list[Component]) -> None:
    if len(components) != len(EXPECTED_TYPE_ORDER):
        raise SafetyError(
            f"expected six components, observed {len(components)}"
        )
    observed_types = tuple(component.type_id for component in components)
    observed_names = tuple(component.filename for component in components)
    if observed_types != EXPECTED_TYPE_ORDER:
        raise SafetyError(
            f"unexpected component type order: {observed_types!r}"
        )
    if observed_names != EXPECTED_FILENAME_ORDER:
        raise SafetyError(
            f"unexpected component filename order: {observed_names!r}"
        )
    if any(component.storage_type != 3 for component in components):
        raise SafetyError("all reviewed components must use storage type 3")

    count = _u32(image, 8)
    toc_end = 0x40 + count * 0x10
    entries = [
        struct.unpack_from("<IIII", image, 0x40 + index * 0x10)
        for index in range(count)
    ]
    first_offset = entries[0][1]
    if image[toc_end:first_offset] != TOC_TRAILER:
        raise SafetyError("EVENOTA TOC trailer or first-entry offset changed")
    for index, (_, offset, size, _) in enumerate(entries):
        if index and entries[index - 1][1] + entries[index - 1][2] != offset:
            raise SafetyError("EVENOTA components are not contiguous")
        if offset + size > len(image):
            raise SafetyError("EVENOTA component exceeds the package")
    if entries[-1][1] + entries[-1][2] != len(image):
        raise SafetyError("EVENOTA package does not close exactly at EOF")


def validate_main_component(component: Component) -> tuple[int, int]:
    """Validate the nested Even main-image format and return installed span."""
    if component.type_id != MAIN_TYPE_ID or component.filename != MAIN_FILENAME:
        raise SafetyError("only the Apollo main component is flashable")
    if component.storage_type != 3:
        raise SafetyError("main component must stage through storage type 3")
    if len(component.header) != COMPONENT_HEADER_SIZE:
        raise SafetyError("main component header is not exactly 128 bytes")

    payload = component.payload
    header = component.header
    if _u32(header, 8) != len(payload):
        raise SafetyError("main component header payload length is invalid")
    if _u32(header, 12) != crc32c_msb(payload):
        raise SafetyError("main component header CRC-32C is invalid")
    if _u32(header, 0x24) != MAIN_TYPE_ID:
        raise SafetyError("main component header type is not zero")
    if _u32(header, 0x28) != 3:
        raise SafetyError("main component header storage type is not three")
    if _c_string(header, 0x30, COMPONENT_HEADER_SIZE) != MAIN_FILENAME:
        raise SafetyError("main component header filename is unexpected")

    if len(payload) < 0x28:
        raise SafetyError("main payload is too short for its OTA preamble")
    preamble_word = _u32(payload, 0)
    declared_size = preamble_word & 0x00FFFFFF
    flags = preamble_word >> 24
    if declared_size != len(payload) or flags != 0x04:
        raise SafetyError(
            "main preamble size/flags differ from the reviewed format"
        )
    if any(_u32(payload, offset) != 0 for offset in (0x08, 0x0C, 0x18, 0x1C)):
        raise SafetyError("main preamble reserved words are nonzero")
    if _u32(payload, 0x10) != MAIN_DATA_TYPE:
        raise SafetyError("main firmware data type is not 0xCB")
    if _u32(payload, 0x14) != MAIN_RUN_BASE:
        raise SafetyError("main firmware run base is not 0x00438000")

    stored_crc = _u32(payload, 4)
    calculated_crc = zlib.crc32(payload[8:]) & 0xFFFFFFFF
    if stored_crc != calculated_crc:
        raise SafetyError("main nested reflected CRC-32 is invalid")

    installed_size = len(payload) - 0x20
    installed_end = MAIN_RUN_BASE + installed_size
    if installed_size <= 0 or installed_end > MAIN_FLAG_ADDRESS:
        raise SafetyError("main installed image overlaps the update flag")
    initial_sp = _u32(payload, 0x20)
    reset_handler = _u32(payload, 0x24)
    if not 0x20000000 <= initial_sp <= 0x20080000:
        raise SafetyError("main initial stack pointer is implausible")
    if (
        reset_handler & 1 == 0
        or not MAIN_RUN_BASE <= (reset_handler & ~1) < installed_end
    ):
        raise SafetyError("main reset vector is outside the installed image")
    return installed_size, installed_end


def build_package_plan(path: Path) -> tuple[PackagePlan, Component]:
    image = path.read_bytes()
    components = parse_evenota(path)
    _validate_outer_layout(image, components)

    package_version = _c_string(image, 0x30, 0x40)
    version_match = VERSION_RE.fullmatch(package_version)
    if version_match is None:
        raise SafetyError(
            f"unexpected package version format: {package_version!r}"
        )
    main_components = [
        component
        for component in components
        if component.type_id == MAIN_TYPE_ID
        and component.filename == MAIN_FILENAME
    ]
    if len(main_components) != 1:
        raise SafetyError("package must contain exactly one Apollo main component")
    main = main_components[0]
    installed_size, installed_end = validate_main_component(main)
    wire = component_wire_summary(main)
    plan = PackagePlan(
        image_path=str(path.resolve()),
        image_bytes=len(image),
        image_sha256=hashlib.sha256(image).hexdigest(),
        package_version=package_version,
        expected_device_version=version_match.group(1),
        build_date=_c_string(image, 0x10, 0x20),
        build_time=_c_string(image, 0x20, 0x30),
        main_payload_bytes=len(main.payload),
        main_payload_sha256=hashlib.sha256(main.payload).hexdigest(),
        main_record_count=int(wire["data_record_count"]),
        main_installed_bytes=installed_size,
        main_installed_end=f"0x{installed_end:08x}",
    )
    return plan, main


def require_ota_ack(frame: bytes, expected_command: int) -> None:
    try:
        parsed = parse_response(frame)
    except ValueError as error:
        raise ProtocolError(str(error)) from error
    if not parsed.checksum_valid:
        raise ProtocolError("temple response checksum is invalid")
    if parsed.command != expected_command:
        raise ProtocolError(
            f"expected command 0x{expected_command:02x} reply, "
            f"received {parsed.command!r}"
        )
    if parsed.status is None:
        raise ProtocolError("temple OTA reply has an unexpected payload shape")
    if parsed.status != 0:
        raise DeviceRejected(
            f"temple rejected command 0x{expected_command:02x} "
            f"with status {parsed.status}"
        )


def decode_version_response(frame: bytes) -> DeviceVersion:
    try:
        parsed = parse_response(frame)
    except ValueError as error:
        raise ProtocolError(str(error)) from error
    if not parsed.checksum_valid:
        raise ProtocolError("version response checksum is invalid")
    payload = parsed.payload
    if (
        len(payload) != 9
        or payload[0] != 0x24
        or payload[1:4] != bytes((1, 3, 5))
    ):
        raise ProtocolError(
            f"unexpected version response payload: {payload.hex()}"
        )
    return DeviceVersion(
        firmware=".".join(str(value) for value in payload[4:8]),
        hardware=payload[8],
    )


class DirectSerialTempleTransport:
    """Raw 1-Mbaud, 8N1 serial endpoint connected to one temple UART."""

    def __init__(
        self,
        device: str,
        *,
        baud: int = 1_000_000,
        write_timeout: float = 5.0,
    ) -> None:
        self.device = device
        self.port = serial.Serial(
            port=device,
            baudrate=baud,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=0.1,
            write_timeout=write_timeout,
            xonxoff=False,
            rtscts=False,
            dsrdtr=False,
        )

    def drain_input(self) -> None:
        self.port.reset_input_buffer()

    def _read_exact_until(self, size: int, deadline: float) -> bytes:
        result = bytearray()
        while len(result) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TransportTimeout(
                    f"timed out after receiving {len(result)}/{size} bytes"
                )
            self.port.timeout = min(0.1, remaining)
            chunk = self.port.read(size - len(result))
            if chunk:
                result.extend(chunk)
        return bytes(result)

    def _read_frame(self, timeout: float) -> bytes:
        deadline = time.monotonic() + timeout
        prefix = bytearray()
        while True:
            byte = self._read_exact_until(1, deadline)
            prefix.extend(byte)
            if len(prefix) > 3:
                del prefix[:-3]
            if prefix == b"\x5a\xa5\xff":
                break
        payload_length = self._read_exact_until(1, deadline)[0]
        if payload_length > 64:
            raise ProtocolError(
                f"temple response declares implausible length {payload_length}"
            )
        tail = self._read_exact_until(payload_length + 1, deadline)
        return b"\x5a\xa5\xff" + bytes((payload_length,)) + tail

    def transact(self, request: bytes, timeout: float) -> bytes:
        if not request:
            raise ProtocolError("refusing to send an empty temple request")
        written = self.port.write(request)
        self.port.flush()
        if written != len(request):
            raise ProtocolError(
                f"serial write accepted {written}/{len(request)} bytes"
            )
        return self._read_frame(timeout)

    def close(self) -> None:
        if self.port.is_open:
            self.port.close()


class MainFirmwareFlasher:
    def __init__(
        self,
        transport: TempleTransport,
        *,
        response_timeout: float = 5.0,
        finish_timeout: float = 60.0,
        data_retries: int = 0,
        retry_backoff_seconds: float = 30.0,
        deferred_batch_size: int = DEFERRED_BATCH_SIZE,
        batch_settle_seconds: float = 0.100,
        late_batch_settle_seconds: float | None = None,
        late_batch_threshold: float = 0.75,
        final_settle_seconds: float | None = None,
        sleeper: Callable[[float], None] = time.sleep,
        progress: Callable[[int, int], None] | None = None,
    ) -> None:
        if data_retries not in (0, 1):
            raise ValueError("data_retries must be 0 or 1")
        if retry_backoff_seconds < 0:
            raise ValueError("retry_backoff_seconds cannot be negative")
        if (
            deferred_batch_size < 1000
            or deferred_batch_size % 1000 != 0
        ):
            raise ValueError(
                "deferred_batch_size must be a positive multiple of 1000"
            )
        if batch_settle_seconds < 0:
            raise ValueError("batch_settle_seconds cannot be negative")
        if late_batch_settle_seconds is None:
            late_batch_settle_seconds = batch_settle_seconds
        if late_batch_settle_seconds < 0:
            raise ValueError("late_batch_settle_seconds cannot be negative")
        if not 0 < late_batch_threshold <= 1:
            raise ValueError("late_batch_threshold must be in (0, 1]")
        if final_settle_seconds is None:
            final_settle_seconds = late_batch_settle_seconds
        if final_settle_seconds < 0:
            raise ValueError("final_settle_seconds cannot be negative")
        self.transport = transport
        self.response_timeout = response_timeout
        self.finish_timeout = finish_timeout
        self.data_retries = data_retries
        self.retry_backoff_seconds = retry_backoff_seconds
        self.deferred_batch_size = deferred_batch_size
        self.batch_settle_seconds = batch_settle_seconds
        self.late_batch_settle_seconds = late_batch_settle_seconds
        self.late_batch_threshold = late_batch_threshold
        self.final_settle_seconds = final_settle_seconds
        self.sleeper = sleeper
        self.progress = progress

    def read_version(self) -> DeviceVersion:
        frame = self.transport.transact(
            version_request(), self.response_timeout
        )
        return decode_version_response(frame)

    def _send_acknowledged(self, request: bytes, timeout: float) -> None:
        frame = self.transport.transact(request, timeout)
        require_ota_ack(frame, request[0])

    def _send_non_idempotent(
        self,
        request: bytes,
        timeout: float,
        stage: str,
    ) -> None:
        try:
            self._send_acknowledged(request, timeout)
        except (TransportTimeout, ProtocolError, DeviceRejected) as error:
            raise NonIdempotentOtaError(stage, request[0], error) from error

    def _settle_storage(self, seconds: float) -> None:
        stress_host_receive = getattr(
            self.transport, "stress_host_receive", None
        )
        if stress_host_receive is None or seconds <= 5.0:
            self.sleeper(seconds)
            return
        remaining = seconds
        while remaining > 5.0:
            self.sleeper(5.0)
            remaining -= 5.0
            stress_host_receive(1)
        if remaining:
            self.sleeper(remaining)

    def flash_main(self, component: Component) -> FlashResult:
        validate_main_component(component)
        records = list(iter_component_data_requests(component.payload))
        total_records = len(records)
        retries_used = 0
        payload_bytes_sent = 0

        # Start and header are not treated as idempotent.  An uncertain reply
        # aborts the operation rather than replaying state transitions.
        self._send_non_idempotent(
            production_ota_start_request(), self.response_timeout, "START"
        )
        self._send_non_idempotent(
            production_ota_header_request(component.header),
            self.response_timeout,
            "HEADER",
        )

        for index, request in enumerate(records):
            final = bool(request[5])
            data_length = struct.unpack_from("<H", request, 3)[0] - 4
            for attempt in range(self.data_retries + 1):
                try:
                    self._send_acknowledged(
                        request, self.response_timeout
                    )
                    break
                except DeviceRejected:
                    if attempt >= self.data_retries:
                        raise
                    retries_used += 1
                    # Only an explicit rejection proves that the expected
                    # sequence did not advance. Missing or malformed replies
                    # remain uncertain and are never replayed. The temple can
                    # remain busy after deferred C1 storage, so permit one
                    # delayed retry of this exact CRC-protected record.
                    self._settle_storage(
                        self.retry_backoff_seconds * (attempt + 1)
                    )
            payload_bytes_sent += data_length
            if self.progress is not None:
                self.progress(index + 1, total_records)

            if (
                payload_bytes_sent % self.deferred_batch_size == 0
                or final
            ):
                # The 0x54 reply precedes deferred C1 parsing/storage.  There
                # is no second durable-write acknowledgement, so leave a
                # conservative settling interval at each configured boundary and
                # increase it late in the image, where hardware runs have
                # exposed receiver back-pressure.
                settle_seconds = self.batch_settle_seconds
                if final:
                    settle_seconds = self.final_settle_seconds
                elif (
                    payload_bytes_sent / len(component.payload)
                    >= self.late_batch_threshold
                ):
                    settle_seconds = self.late_batch_settle_seconds
                self._settle_storage(settle_seconds)

        # Current reviewed CFW reports 2.2.6.11 while its Stock base reports
        # 2.2.6.10. Version remains only an identity gate, not byte provenance:
        # require the checksum-valid zero-status 0x55 response instead of
        # accepting a reset-raced timeout as success.
        self._send_non_idempotent(
            production_ota_finish_request(), self.finish_timeout, "FINISH"
        )

        return FlashResult(
            records_sent=total_records,
            payload_bytes_sent=payload_bytes_sent,
            data_retries=retries_used,
            finish_ack_received=True,
        )


def poll_for_version(
    flasher: MainFirmwareFlasher,
    expected_version: str,
    *,
    timeout: float,
    interval: float,
) -> DeviceVersion:
    deadline = time.monotonic() + timeout
    last_version: DeviceVersion | None = None
    while time.monotonic() < deadline:
        flasher.sleeper(interval)
        try:
            flasher.transport.drain_input()
            observed = flasher.read_version()
            last_version = observed
            if observed.firmware == expected_version:
                return observed
        except (TransportTimeout, ProtocolError, serial.SerialException):
            continue
    if last_version is not None:
        raise ProtocolError(
            f"temple returned firmware {last_version.firmware}, expected "
            f"{expected_version}"
        )
    raise TransportTimeout(
        f"no valid post-reboot version response within {timeout:.1f} seconds"
    )


def _print_plan(plan: PackagePlan, *, json_output: bool) -> None:
    report = {
        "schema_version": 1,
        "mode": "offline_inspection_no_hardware_writes",
        "flashable_component": "Apollo main only",
        "bootloader_component_allowed": False,
        "transport_requirement": (
            "raw temple UART at 1,000,000 baud 8N1; stock case CH340 is not "
            "a transparent temple endpoint"
        ),
        "plan": asdict(plan),
    }
    if json_output:
        print(json.dumps(report, indent=2, sort_keys=True))
        return
    print(f"Image:             {plan.image_path}")
    print(f"Package:           {plan.package_version}")
    print(f"Build:             {plan.build_date} {plan.build_time}")
    print(f"Image SHA-256:      {plan.image_sha256}")
    print(f"Main payload:       {plan.main_payload_bytes:,} bytes")
    print(f"Main SHA-256:       {plan.main_payload_sha256}")
    print(f"0x54 records:       {plan.main_record_count:,}")
    print(f"Installed end:      {plan.main_installed_end}")
    print("Flashable:          Apollo main only")
    print("Bootloader:         REJECTED by policy")
    print(
        "Transport:          raw 1-Mbaud temple UART; not the stock case "
        "CH340 console"
    )


def _progress_printer(every: int) -> Callable[[int, int], None]:
    last_percent = -1

    def report(completed: int, total: int) -> None:
        nonlocal last_percent
        percent = completed * 100 // total
        if (
            completed == total
            or completed == 1
            or completed % every == 0
            or percent >= last_percent + 5
        ):
            print(
                f"Data: {completed:,}/{total:,} records "
                f"({completed * 100.0 / total:.1f}%)",
                flush=True,
            )
            last_percent = percent

    return report


def _write_log(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _add_direct_transport_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--device", required=True)
    parser.add_argument(
        "--direct-temple-uart-confirmed",
        action="store_true",
        help=(
            "confirm that --device exposes a raw temple UART through an "
            "electrically safe fixture/bridge; the stock case CH340 does not"
        ),
    )
    parser.add_argument(
        "--response-timeout",
        type=float,
        default=5.0,
        help="ordinary reply timeout in seconds (default: 5)",
    )


def _require_direct_confirmation(
    parser: argparse.ArgumentParser, args: argparse.Namespace
) -> None:
    if not args.direct_temple_uart_confirmed:
        parser.error(
            "serial access requires --direct-temple-uart-confirmed; "
            "do not point this tool at the stock case CH340 console"
        )
    if args.response_timeout <= 0:
        parser.error("--response-timeout must be positive")


def _open_transport(args: argparse.Namespace) -> DirectSerialTempleTransport:
    return DirectSerialTempleTransport(args.device)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser(
        "inspect", help="validate and describe an EVENOTA package offline"
    )
    inspect_parser.add_argument("image", type=Path)
    inspect_parser.add_argument("--json", action="store_true")

    preflight_parser = subparsers.add_parser(
        "preflight", help="issue only the read-only 0x24 version query"
    )
    _add_direct_transport_arguments(preflight_parser)
    preflight_parser.add_argument(
        "--expect-version",
        help="fail if the running temple version differs",
    )

    flash_parser = subparsers.add_parser(
        "flash", help="stage and install only the Apollo main component"
    )
    flash_parser.add_argument("image", type=Path)
    _add_direct_transport_arguments(flash_parser)
    flash_parser.add_argument(
        "--execute-main-ota",
        action="store_true",
        help="explicitly enable the mutating 0x52-0x55 transaction",
    )
    flash_parser.add_argument(
        "--accept-single-slot-risk",
        action="store_true",
        help="acknowledge that the Even main application is installed in place",
    )
    flash_parser.add_argument(
        "--confirm-image-sha256",
        help="must exactly match the complete validated EVENOTA image",
    )
    flash_parser.add_argument(
        "--expect-current-version",
        help="abort before OTA if the running temple differs",
    )
    flash_parser.add_argument(
        "--data-retries",
        type=int,
        choices=(0, 1),
        default=0,
        help=(
            "exact 0x54 retry after an explicit rejection only "
            "(default: 0; Case-path hardware tests require a fresh component "
            "after reset instead)"
        ),
    )
    flash_parser.add_argument(
        "--deferred-batch-bytes",
        type=int,
        default=DEFERRED_BATCH_SIZE,
        help=(
            "accepted bytes between storage-settle delays; must be a multiple "
            f"of 1000 (default: {DEFERRED_BATCH_SIZE})"
        ),
    )
    flash_parser.add_argument(
        "--batch-settle-ms",
        type=float,
        default=100.0,
        help="delay after each deferred 6-KiB batch (default: 100)",
    )
    flash_parser.add_argument(
        "--late-batch-settle-ms",
        type=float,
        help="late-image storage delay (default: --batch-settle-ms)",
    )
    flash_parser.add_argument(
        "--final-settle-ms",
        type=float,
        help="delay after the final DATA record (default: late delay)",
    )
    flash_parser.add_argument(
        "--finish-timeout",
        type=float,
        default=60.0,
        help="0x55 result timeout in seconds (default: 60)",
    )
    flash_parser.add_argument(
        "--postflight-timeout",
        type=float,
        default=180.0,
        help="matching post-reboot version timeout (default: 180)",
    )
    flash_parser.add_argument(
        "--postflight-interval",
        type=float,
        default=2.0,
        help="post-reboot version polling interval (default: 2)",
    )
    flash_parser.add_argument(
        "--progress-every",
        type=int,
        default=50,
        help="print progress at least every N records (default: 50)",
    )
    flash_parser.add_argument(
        "--log",
        type=Path,
        help="optional JSON audit-log path",
    )
    return parser


def main() -> int:
    parser = build_argument_parser()
    args = parser.parse_args()

    if args.command == "inspect":
        try:
            plan, _ = build_package_plan(args.image)
            _print_plan(plan, json_output=args.json)
            return 0
        except (OSError, ValueError, FlasherError) as error:
            print(f"Inspection failed: {error}", file=sys.stderr)
            return 1

    _require_direct_confirmation(parser, args)
    transport: DirectSerialTempleTransport | None = None
    if args.command == "preflight":
        try:
            transport = _open_transport(args)
            transport.drain_input()
            flasher = MainFirmwareFlasher(
                transport, response_timeout=args.response_timeout
            )
            version = flasher.read_version()
            print(
                f"Temple firmware={version.firmware}, "
                f"hardware={version.hardware}"
            )
            if (
                args.expect_version is not None
                and version.firmware != args.expect_version
            ):
                raise SafetyError(
                    f"expected {args.expect_version}, observed "
                    f"{version.firmware}"
                )
            return 0
        except (
            OSError,
            FlasherError,
            serial.SerialException,
        ) as error:
            print(f"Preflight failed safely: {error}", file=sys.stderr)
            return 1
        finally:
            if transport is not None:
                transport.close()

    assert args.command == "flash"
    try:
        plan, main_component = build_package_plan(args.image)
    except (OSError, ValueError, FlasherError) as error:
        print(f"Package validation failed: {error}", file=sys.stderr)
        return 1

    if not args.execute_main_ota:
        parser.error("flash requires --execute-main-ota")
    if not args.accept_single_slot_risk:
        parser.error("flash requires --accept-single-slot-risk")
    if (
        args.confirm_image_sha256 is None
        or args.confirm_image_sha256.lower() != plan.image_sha256
    ):
        parser.error(
            "--confirm-image-sha256 must equal the complete image SHA-256: "
            + plan.image_sha256
        )
    if args.data_retries not in (0, 1):
        parser.error("--data-retries must be 0 or 1")
    if args.batch_settle_ms < 0:
        parser.error("--batch-settle-ms cannot be negative")
    if (
        args.deferred_batch_bytes < 1000
        or args.deferred_batch_bytes % 1000 != 0
    ):
        parser.error("--deferred-batch-bytes must be a positive multiple of 1000")
    if (
        args.late_batch_settle_ms is not None
        and args.late_batch_settle_ms < 0
    ):
        parser.error("--late-batch-settle-ms cannot be negative")
    if args.final_settle_ms is not None and args.final_settle_ms < 0:
        parser.error("--final-settle-ms cannot be negative")
    if (
        args.finish_timeout <= 0
        or args.postflight_timeout <= 0
        or args.postflight_interval <= 0
        or args.progress_every <= 0
    ):
        parser.error("timeouts, polling interval, and progress interval must be positive")

    started = datetime.now(timezone.utc)
    audit: dict[str, object] = {
        "schema_version": 1,
        "started_at_utc": started.isoformat(),
        "operation": "g2_pogo_apollo_main_ota",
        "device": args.device,
        "package": asdict(plan),
        "bootloader_component_allowed": False,
        "required_final_restore_step": FINAL_RESTORE_REQUIREMENT,
        "outcome": "started",
    }
    try:
        print("Validated main-only flash plan:")
        _print_plan(plan, json_output=False)
        transport = _open_transport(args)
        transport.drain_input()
        flasher = MainFirmwareFlasher(
            transport,
            response_timeout=args.response_timeout,
            finish_timeout=args.finish_timeout,
            data_retries=args.data_retries,
            deferred_batch_size=args.deferred_batch_bytes,
            batch_settle_seconds=args.batch_settle_ms / 1000.0,
            late_batch_settle_seconds=(
                args.late_batch_settle_ms / 1000.0
                if args.late_batch_settle_ms is not None
                else None
            ),
            final_settle_seconds=(
                args.final_settle_ms / 1000.0
                if args.final_settle_ms is not None
                else None
            ),
            progress=_progress_printer(args.progress_every),
        )
        current = flasher.read_version()
        audit["preflight_version"] = asdict(current)
        print(
            f"Preflight: firmware={current.firmware}, "
            f"hardware={current.hardware}"
        )
        if (
            args.expect_current_version is not None
            and current.firmware != args.expect_current_version
        ):
            raise SafetyError(
                f"expected current firmware {args.expect_current_version}, "
                f"observed {current.firmware}"
            )

        print(
            "Starting main-component OTA; do not remove power or disturb "
            "the fixture.",
            flush=True,
        )
        result = flasher.flash_main(main_component)
        audit["transfer"] = asdict(result)
        print(
            "Transfer result: "
            f"records={result.records_sent:,}, "
            f"bytes={result.payload_bytes_sent:,}, "
            f"retries={result.data_retries}, "
            f"finish_ack={result.finish_ack_received}",
            flush=True,
        )

        postflight = poll_for_version(
            flasher,
            plan.expected_device_version,
            timeout=args.postflight_timeout,
            interval=args.postflight_interval,
        )
        audit["postflight_version"] = asdict(postflight)
        audit["restore_complete"] = False
        audit["outcome"] = "success"
        print(
            f"Postflight: firmware={postflight.firmware}, "
            f"hardware={postflight.hardware}"
        )
        print("Main-firmware flash completed and postflight liveness verified.")
        print(f"Required final restore step: {FINAL_RESTORE_REQUIREMENT}")
        return_code = 0
    except (
        OSError,
        FlasherError,
        serial.SerialException,
    ) as error:
        audit["outcome"] = "failed_or_uncertain"
        audit["error"] = str(error)
        if isinstance(error, NonIdempotentOtaError):
            audit["failure_stage"] = error.stage
            audit["failed_command"] = f"0x{error.command:02x}"
            audit["recovery_recommendation"] = (
                error.recovery_recommendation
            )
        print(
            "Flash stopped; device state may be incomplete or uncertain: "
            f"{error}",
            file=sys.stderr,
            flush=True,
        )
        return_code = 1
    finally:
        audit["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
        if transport is not None:
            transport.close()
        if args.log is not None:
            try:
                _write_log(args.log, audit)
                print(f"Wrote audit log: {args.log}")
            except OSError as error:
                print(
                    f"Could not write audit log: {error}",
                    file=sys.stderr,
                )
                return_code = 1
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())

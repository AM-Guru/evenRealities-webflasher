#!/usr/bin/env python3
"""Flash a reviewed G2 main image through the charging-case USB port.

The case STM32 runs a hash-gated bridge only from SRAM.  The bridge selects
one YHM2510 pogo route, permits the read-only 0x24 request and a main-only
0x52/0x53/0x54/0x55 OTA state machine, then restores the case's original
ten-register YHM state byte-for-byte.  It cannot forward a bootloader or
peripheral component header.

This remains a single-slot Apollo application update.  It does not make a
nonbooting temple recoverable and deliberately does not expose arbitrary UART
forwarding.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import struct
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import serial

from g2_case_rom import (
    BootloaderError,
    SRAM_ADDRESS,
    go_sram,
    open_rom_loader,
    read_exact,
    read_memory,
    require_expected_identity,
    restore_application,
    write_sram,
)
from g2_pogo_flasher import (
    FlasherError,
    MainFirmwareFlasher,
    NonIdempotentOtaError,
    ProtocolError,
    SafetyError,
    TempleTransport,
    TransportTimeout,
    build_package_plan,
    poll_for_version,
)


BRIDGE_BYTES = 2952
BRIDGE_SHA256 = (
    "eba56380f04bf00ad9d87dffbc40c3292ec5b3cee458d3607c8cffd0dcbe335b"
)
BRIDGE_BANNER = b"G2_POGO_FLASH_BRIDGE_V7\n"
REVIEWED_CFW_SHA256 = (
    "105032302d02ccf943b785070cf15877a918c120b7ca1332bb6261f70eb6d683"
)
REVIEWED_OFFICIAL_SHA256 = (
    "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa"
)
REVIEWED_OFFICIAL_MAIN_SHA256 = (
    "36c5b0e499a68ac2493a497bdab9740fd3e7027730c26a9094eca47268a27863"
)
REVIEWED_OFFICIAL_MAIN_BYTES = 3_523_396
REVIEWED_MAIN_SHA256 = (
    "2d82addd4c9916781b50f7be377645b797f10856a460bc5190f3172e7161614e"
)
REVIEWED_MAIN_BYTES = 3_543_523
REVIEWED_BASE_VERSION = "2.2.6.10"
REVIEWED_CFW_VERSION = "2.2.6.11"
REVIEWED_CASE_VERSION = "1.2.57"
FINAL_RESET_COMMAND = b"DEB0\n"
FINAL_RESET_CONFIRMATION = re.compile(
    rb"reset gls L & R, reason: cmd",
    re.IGNORECASE,
)
POST_RESET_TELEMETRY_ATTEMPTS = 3
POST_RESET_REOPEN_DELAY_SECONDS = 0.5
# Repeated read-only probes consume the same short app-mode route needed by the
# first OTA state transition. Hardware reproduced a missing START after a
# 10-query gate, then acknowledged the identical START after one fresh version
# query. Use the checksum-valid query as a just-in-time liveness gate; repeated
# probes are diagnostic load, not evidence that the later mutation will work.
FLASH_STABILITY_QUERIES = 1
FLASH_STABILITY_INTERVAL_SECONDS = 0.025
FLASH_PRE_START_SETTLE_SECONDS = 0.250
PACING_PROFILES = {
    "conservative": {
        "deferred_batch_size": 6_000,
        "batch_settle_seconds": 1.000,
        "late_batch_settle_seconds": 2.000,
        "late_batch_threshold": 0.75,
        "final_settle_seconds": 15.000,
        "hardware_qualified": True,
    },
    # Use only for a fresh whole-component retry after exact cleanup and the
    # bilateral reset/liveness gate. Hardware completed this policy after an
    # explicit DATA rejection; the rejected record itself is never replayed.
    "conservative-retry": {
        "deferred_batch_size": 6_000,
        "batch_settle_seconds": 2.000,
        "late_batch_settle_seconds": 4.000,
        "late_batch_threshold": 0.75,
        "final_settle_seconds": 30.000,
        "hardware_qualified": True,
    },
    # This reduces scheduled idle time by batching twice as many accepted bytes.
    # A 2026-07-26 right-Stock recovery explicitly rejected DATA at 691,000
    # accepted bytes, so it remains opt-in research and must never be promoted
    # merely from elapsed-time estimates.
    "balanced-lab": {
        "deferred_batch_size": 12_000,
        "batch_settle_seconds": 0.750,
        "late_batch_settle_seconds": 1.500,
        "late_batch_threshold": 0.75,
        "final_settle_seconds": 15.000,
        "hardware_qualified": False,
    },
}

RESULT_ADDRESS = 0x20011A00
RESULT_LENGTH = 128
PROOF_ADDRESS = 0x20011B00
PROOF = bytes.fromhex("47465250dec0dec0")
ZERO_PROOF = bytes(len(PROOF))
ALLOWED_YHM_BASELINES = {
    bytes.fromhex(value)
    for value in (
        "811104afaf038d2022ff",
        "810004aeae03812022ff",
        "811104afaf03812022ff",
        "810104afae03812022ff",
        "811004aeaf03812022ff",
    )
}

READY_STATUS = {
    0: "ok",
    1: "bad host request",
    2: "command or OTA state rejected",
    3: "YHM baseline is not an allowlisted seated-idle state",
    4: "YHM route selection failed",
    5: "temple UART transmit failed",
    6: "no complete framed temple response",
    7: "YHM baseline restoration failed",
    16: "host request timeout",
}


def _drain_case_console(port: serial.Serial, duration: float) -> bytes:
    deadline = time.monotonic() + duration
    captured = bytearray()
    while time.monotonic() < deadline:
        captured.extend(port.read(4096))
    return bytes(captured)


def _open_case_console(device: str) -> serial.Serial:
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
    time.sleep(0.05)
    port.rts = False
    return port


def parse_case_restore_evidence(
    captured: bytes,
    *,
    require_reset_confirmation: bool,
) -> dict[str, object]:
    versions = re.findall(rb"\bB200 ([0-9.]+)", captured)
    if not versions:
        raise SafetyError("normal case firmware banner was not observed")
    version = versions[-1].decode("ascii", errors="replace")
    if version != REVIEWED_CASE_VERSION:
        raise SafetyError(
            f"case firmware is {version}, expected {REVIEWED_CASE_VERSION}"
        )
    presence_telemetry = re.findall(
        rb"GLS_L:(\d+), GLS_R:(\d+)",
        captured,
    )
    if not presence_telemetry:
        raise SafetyError("fresh case temple-presence telemetry was not observed")
    left_raw, right_raw = presence_telemetry[-1]
    ota_telemetry = re.findall(rb"otaGls:(\d+)", captured)
    reset_confirmed = bool(FINAL_RESET_CONFIRMATION.search(captured))
    if require_reset_confirmation and not reset_confirmed:
        raise SafetyError(
            "case did not confirm the traced B0 left/right temple reset"
        )
    return {
        "case_version": version,
        "left_present": bool(int(left_raw)),
        "right_present": bool(int(right_raw)),
        "ota_glasses": int(ota_telemetry[-1]) if ota_telemetry else None,
        "reset_command": FINAL_RESET_COMMAND.decode("ascii").strip(),
        "reset_confirmed": reset_confirmed,
    }


def read_case_preflight(device: str, routes: tuple[str, ...]) -> dict[str, object]:
    """Require case 1.2.57 and fresh presence for every selected route."""
    port = _open_case_console(device)
    try:
        captured = bytearray(_drain_case_console(port, 2.5))
        port.reset_input_buffer()
        if port.write(b"DEA3\n") != 5:
            raise ProtocolError("case telemetry query was truncated")
        port.flush()
        captured.extend(_drain_case_console(port, 1.0))
    finally:
        port.close()

    report = parse_case_restore_evidence(
        bytes(captured),
        require_reset_confirmation=False,
    )
    for route in routes:
        if not report[f"{route}_present"]:
            raise SafetyError(
                f"fresh case telemetry does not report {route} as seated"
            )
    return report


def read_post_reset_case_telemetry(
    device: str,
    attempts: int = POST_RESET_TELEMETRY_ATTEMPTS,
) -> dict[str, object]:
    """Reopen the normal console and retry fresh telemetry after a B0 reset."""
    if attempts < 1:
        raise ValueError("post-reset telemetry attempts must be positive")
    errors: list[str] = []
    for attempt in range(1, attempts + 1):
        port: serial.Serial | None = None
        try:
            port = _open_case_console(device)
            captured = bytearray(_drain_case_console(port, 2.5))
            port.reset_input_buffer()
            if port.write(b"DEA0\n") != 5:
                raise ProtocolError(
                    "post-reset case version query was truncated"
                )
            port.flush()
            captured.extend(_drain_case_console(port, 0.9))
            port.reset_input_buffer()
            if port.write(b"DEA3\n") != 5:
                raise ProtocolError(
                    "post-reset case telemetry query was truncated"
                )
            port.flush()
            captured.extend(_drain_case_console(port, 1.0))
            report = parse_case_restore_evidence(
                bytes(captured),
                require_reset_confirmation=False,
            )
            report["post_reset_telemetry_session"] = "reopened"
            report["post_reset_telemetry_attempt"] = attempt
            return report
        except (
            OSError,
            FlasherError,
            serial.SerialException,
        ) as error:
            errors.append(f"attempt {attempt}: {error}")
        finally:
            if port is not None:
                port.close()
        if attempt != attempts:
            time.sleep(POST_RESET_REOPEN_DELAY_SECONDS)
    raise SafetyError(
        "fresh case telemetry did not return after "
        f"{attempts} reopened serial sessions ({'; '.join(errors)})"
    )


def reset_both_temples_and_recheck(device: str) -> dict[str, object]:
    """Confirm B0, then verify telemetry through a newly opened serial session."""
    port = _open_case_console(device)
    try:
        captured = bytearray(_drain_case_console(port, 2.5))
        port.reset_input_buffer()
        if port.write(FINAL_RESET_COMMAND) != len(FINAL_RESET_COMMAND):
            raise ProtocolError("case B0 reset command was truncated")
        port.flush()
        captured.extend(_drain_case_console(port, 2.2))
        if not FINAL_RESET_CONFIRMATION.search(captured):
            raise SafetyError(
                "case did not confirm the traced B0 left/right temple reset"
            )
    finally:
        port.close()
    # Hardware observation: the Case can confirm DEB0 yet omit A3 telemetry in
    # that same console session while both temple links restart. Closing and
    # reopening the normal console produced fresh GLS_L/GLS_R state.
    time.sleep(6.5)
    report = read_post_reset_case_telemetry(device)
    report["reset_command"] = FINAL_RESET_COMMAND.decode("ascii").strip()
    report["reset_confirmed"] = True
    report["reset_confirmation_session"] = "pre-restart"
    return report


BRIDGE_BASE64 = (
    "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"
)


def build_bridge() -> bytes:
    """Decode and hash-gate the exact hardware-validated SRAM bridge."""
    try:
        payload = base64.b64decode(BRIDGE_BASE64, validate=True)
    except ValueError as error:
        raise SafetyError("embedded case bridge is not valid base64") from error
    digest = hashlib.sha256(payload).hexdigest()
    if len(payload) != BRIDGE_BYTES or digest != BRIDGE_SHA256:
        raise SafetyError(
            "embedded bridge differs from the reviewed build "
            f"(size={len(payload)}, sha256={digest})"
        )
    if len(payload) % 4:
        raise SafetyError("bridge length is not ROM-write aligned")
    stack_pointer, reset_handler = struct.unpack_from("<II", payload)
    if stack_pointer != 0x2001F000 or reset_handler != 0x20010009:
        raise SafetyError("bridge vector table differs from the reviewed layout")
    return payload


class CaseSramTempleTransport(TempleTransport):
    """Main-only temple transport through a volatile case SRAM bridge."""

    def __init__(
        self,
        device: str,
        route: str,
        *,
        require_route_phase: bool = False,
    ) -> None:
        if route not in ("left", "right"):
            raise ValueError("route must be left or right")
        self.device = device
        self.route = route
        self.require_route_phase = require_route_phase
        self.payload = build_bridge()
        self.port: serial.Serial | None = None
        self.sequence = 0
        self.active = False
        self.bridge_launched = False
        self.restore_verified = False
        self.application_version: str | None = None
        self.close_error: str | None = None
        self.baseline = b""
        self.restored = b""
        self.retained_result: dict[str, object] = {}
        self.completed_transfer: tuple[int, int] | None = None
        self._permitted_writes: set[tuple[int, bytes]] = {
            (PROOF_ADDRESS, ZERO_PROOF),
            (RESULT_ADDRESS, bytes(RESULT_LENGTH)),
        }
        for offset in range(0, len(self.payload), 256):
            self._permitted_writes.add(
                (
                    SRAM_ADDRESS + offset,
                    self.payload[offset : offset + 256],
                )
            )
        self._start()

    def _write_sram(
        self, port: serial.Serial, address_value: int, data: bytes
    ) -> None:
        if (address_value, data) not in self._permitted_writes:
            raise SafetyError("attempted case SRAM write is outside the allowlist")
        write_sram(port, address_value, data)

    def _start(self) -> None:
        port = open_rom_loader(self.device)
        try:
            require_expected_identity(port)
            self._write_sram(port, PROOF_ADDRESS, ZERO_PROOF)
            self._write_sram(port, RESULT_ADDRESS, bytes(RESULT_LENGTH))
            if read_memory(port, PROOF_ADDRESS, len(ZERO_PROOF)) != ZERO_PROOF:
                raise SafetyError("case bridge proof location did not clear")
            if read_memory(port, RESULT_ADDRESS, RESULT_LENGTH) != bytes(
                RESULT_LENGTH
            ):
                raise SafetyError("case bridge result location did not clear")
            for offset in range(0, len(self.payload), 256):
                chunk = self.payload[offset : offset + 256]
                address = SRAM_ADDRESS + offset
                self._write_sram(port, address, chunk)
                if read_memory(port, address, len(chunk)) != chunk:
                    raise SafetyError(
                        f"case SRAM readback differs at 0x{address:08x}"
                    )
            go_sram(port)
            self.bridge_launched = True
            # The ROM-loader opener holds DTR low to select system memory.
            # Release BOOT0 immediately after the verified SRAM jump.  This
            # matches the normal case-application control-line state and makes
            # any subsequent reset return to the case app, not the ROM loader.
            port.dtr = True
            # The bridge retains the ROM loader's 115,200 8E1 framing so
            # Web Serial never needs a close/reopen transition after GO.
            port.parity = serial.PARITY_EVEN
            port.timeout = 8.0
            banner = read_exact(port, len(BRIDGE_BANNER), "bridge banner")
            if banner != BRIDGE_BANNER:
                raise SafetyError(f"bridge banner mismatch: {banner.hex()}")

            setup = bytearray(b"G2FW")
            setup.extend(
                (
                    1,
                    0 if self.route == "left" else 1,
                    int(self.require_route_phase),
                    0x42,
                    0,
                )
            )
            setup.append(sum(setup) & 0xFF)
            port.write(setup)
            port.flush()
            ready = read_exact(port, 13, "bridge ready response")
            if (
                ready[:4] != b"G2RD"
                or ready[4] != 1
                or ready[6] != setup[5]
                or ready[7] != setup[7]
                or ready[-1] != sum(ready[:-1]) & 0xFF
            ):
                raise SafetyError(f"invalid bridge ready response: {ready.hex()}")
            if ready[5] != 0:
                raise SafetyError(
                    f"bridge setup status {ready[5]}: "
                    f"{READY_STATUS.get(ready[5], 'unknown')}"
                )
            if ready[8:12] != bytes.fromhex("ff03ff03"):
                raise SafetyError(
                    "bridge did not prove complete baseline/selected YHM reads"
                )
            self.port = port
            self.active = True
        except Exception as primary_error:
            if port.is_open:
                port.close()
            cleanup_errors: list[str] = []
            if self.bridge_launched:
                time.sleep(0.35)
                try:
                    self._verify_retained_restore()
                except Exception as error:
                    cleanup_errors.append(
                        f"retained route-restoration proof: {error}"
                    )
            try:
                restore_application(
                    self.device, expected_version=REVIEWED_CASE_VERSION
                )
            except Exception as restore_error:
                cleanup_errors.append(
                    f"case application return: {restore_error}"
                )
            if cleanup_errors:
                raise SafetyError(
                    f"bridge startup failed: {primary_error}; "
                    + "; ".join(cleanup_errors)
                ) from primary_error
            raise

    def drain_input(self) -> None:
        if self.port is not None and self.port.is_open:
            self.port.reset_input_buffer()

    def _write_host_bytes(self, data: bytes, what: str) -> None:
        if self.port is None:
            raise ProtocolError("case bridge is not open")
        written = self.port.write(data)
        self.port.flush()
        if written != len(data):
            raise ProtocolError(
                f"case USB write accepted {written}/{len(data)} bytes for {what}"
            )

    def _write_host_header(self, data: bytes) -> None:
        """Pace the fixed header across the CH340 after an idle transition."""
        if len(data) != 10:
            raise ProtocolError("case bridge transaction header must be 10 bytes")
        # Hardware evidence captured only the first five bytes of a 10-byte
        # header after the former two-second pre-start idle. Two independently flushed
        # five-byte writes avoid that silent CH340 truncation while staying well
        # inside the bridge's bounded per-byte receive deadline.
        self._write_host_bytes(data[:5], "transaction header prefix")
        time.sleep(0.005)
        self._write_host_bytes(data[5:], "transaction header suffix")

    def _read_exact_until(
        self, count: int, deadline: float, what: str
    ) -> bytes:
        if self.port is None:
            raise ProtocolError("case bridge is not open")
        result = bytearray()
        while len(result) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TransportTimeout(
                    f"timeout reading {what}: got {len(result)}/{count} bytes"
                )
            self.port.timeout = min(0.25, remaining)
            chunk = self.port.read(count - len(result))
            if chunk:
                result.extend(chunk)
        return bytes(result)

    def _read_response(self, timeout: float) -> tuple[int, int, bytes]:
        if self.port is None:
            raise ProtocolError("case bridge is not open")
        deadline = time.monotonic() + max(10.0, timeout + 10.0)
        window = bytearray()
        inspected = 0
        while inspected < 128:
            window.extend(
                self._read_exact_until(
                    1, deadline, "case bridge response synchronization byte"
                )
            )
            inspected += 1
            if len(window) > 4:
                del window[0]
            if window == b"G2RX":
                break
        else:
            raise ProtocolError(
                "case bridge emitted 128 bytes without a complete G2RX marker"
            )
        header = b"G2RX" + self._read_exact_until(
            7, deadline, "case bridge response header suffix"
        )
        if inspected > 4:
            print(
                "case bridge: discarded "
                f"{inspected - 4} short-response prefix bytes and "
                "synchronized to the retransmitted G2RX frame",
                flush=True,
            )
        if header[:5] != b"G2RX\x01":
            raise ProtocolError(
                f"invalid case bridge response header: {header.hex()}"
            )
        length = header[8]
        if length > 64:
            raise ProtocolError("case bridge capture length exceeds 64")
        tail = self._read_exact_until(
            length + 1,
            deadline,
            "case bridge response payload/checksum",
        )
        response = header + tail
        if response[-1] != sum(response[:-1]) & 0xFF:
            raise ProtocolError("case bridge response checksum is invalid")
        if header[5] != self.sequence:
            raise ProtocolError(
                f"case bridge sequence is {header[5]}, expected {self.sequence}"
            )
        return header[6], header[7], response[11:-1]

    def _exchange(
        self, magic: bytes, request: bytes, timeout: float
    ) -> tuple[int, int, bytes]:
        if not self.active or self.port is None:
            raise ProtocolError("case bridge session is not active")
        if magic not in (b"G2TX", b"G2TS"):
            raise SafetyError("case bridge request magic is not allowlisted")
        if not request or len(request) > 1009:
            raise ProtocolError("temple request length is outside bridge bounds")
        self.sequence = (self.sequence + 1) & 0xFF
        header = bytearray(magic)
        header.extend((1, self.sequence))
        header.extend(struct.pack("<H", len(request)))
        header.append(0)
        header.append(sum(header) & 0xFF)
        self._write_host_header(bytes(header))
        deadline = time.monotonic() + 8.0
        if self._read_exact_until(
            1, deadline, "transaction-header flow-control token"
        ) != b"\xc3":
            raise ProtocolError("case bridge rejected the transaction header")
        # macOS occasionally reported a full ~1 KiB buffer accepted although
        # the CH340 delivered a truncated stream.  Stop-and-wait flow control
        # proves that the case consumed each short chunk before sending more.
        for offset in range(0, len(request), 32):
            self._write_host_bytes(
                request[offset : offset + 32],
                f"transaction payload at {offset}",
            )
            deadline = time.monotonic() + 8.0
            if self._read_exact_until(
                1,
                deadline,
                f"transaction payload flow-control token at {offset}",
            ) != b"\xc3":
                raise ProtocolError(
                    f"case bridge did not accept payload chunk at {offset}"
                )
        self._write_host_bytes(
            bytes((sum(request) & 0xFF,)),
            "transaction payload checksum",
        )
        return self._read_response(timeout)

    def transact(self, request: bytes, timeout: float) -> bytes:
        bridge_status, uart_errors, captured = self._exchange(
            b"G2TX", request, timeout
        )
        if uart_errors:
            raise ProtocolError(
                f"case pogo UART reported error mask 0x{uart_errors:02x}"
            )
        if bridge_status == 6:
            raise TransportTimeout("no complete temple frame through case bridge")
        if bridge_status:
            raise SafetyError(
                f"case bridge status {bridge_status}: "
                f"{READY_STATUS.get(bridge_status, 'unknown')}"
            )
        return captured

    def stress_host_receive(self, payload_size: int) -> None:
        if not 1 <= payload_size <= 1009:
            raise ValueError("host stress payload must be between 1 and 1009")
        status, uart_errors, captured = self._exchange(
            b"G2TS", bytes(payload_size), 8.0
        )
        if status or uart_errors or captured:
            raise ProtocolError(
                "host-only stress response was not empty/OK: "
                f"status={status}, errors={uart_errors}, "
                f"captured={captured.hex()}"
            )

    def _request_exit(self) -> bytes:
        if self.port is None or not self.port.is_open:
            raise ProtocolError("case bridge serial port is not open")
        self.sequence = (self.sequence + 1) & 0xFF
        header = bytearray(b"G2TX")
        header.extend((1, self.sequence))
        header.extend(b"\0\0\0")
        header.append(sum(header) & 0xFF)
        self._write_host_header(bytes(header))
        status, errors, captured = self._read_response(10.0)
        if status != 0 or errors != 0 or len(captured) != 10:
            raise ProtocolError(
                f"bridge exit failed status={status}, errors={errors}, "
                f"restored={captured.hex()}"
            )
        return captured

    def _verify_retained_restore(self) -> None:
        port = open_rom_loader(self.device)
        verification_error: Exception | None = None
        cleanup_error: Exception | None = None
        identity_verified = False
        try:
            try:
                require_expected_identity(port)
                identity_verified = True
                proof = read_memory(port, PROOF_ADDRESS, len(PROOF))
                result = read_memory(port, RESULT_ADDRESS, RESULT_LENGTH)
                words = [
                    int.from_bytes(result[offset : offset + 4], "little")
                    for offset in range(0, RESULT_LENGTH, 4)
                ]
                self.retained_result = {
                    "magic": f"0x{words[0]:08x}",
                    "progress": words[1],
                    "route": words[2],
                    "sequence": words[3],
                    "status": words[4],
                    "baseline_mask": f"0x{words[5]:03x}",
                    "selected_mask": f"0x{words[6]:03x}",
                    "restored_mask": f"0x{words[7]:03x}",
                    "write_mask": f"0x{words[8]:x}",
                    "ota_state": words[9],
                    "expected_sequence": words[10],
                    "declared_size": words[11],
                    "accepted_size": words[12],
                    "temple_tx_count": words[13],
                    "temple_rx_count": words[14],
                    "temple_uart_errors": f"0x{words[15]:x}",
                    "host_tx_recoveries": words[24],
                    "host_tx_aborts": words[25],
                    "host_tx_last_isr": f"0x{words[26]:08x}",
                    "host_rx_timeouts": words[27],
                    "host_rx_errors": words[28],
                    "host_tc_timeouts": words[29],
                    "host_stage": words[30],
                    "host_chunk_offset": words[31],
                    "proof": proof.hex(),
                }
                self.baseline = result[64:74]
                self.restored = result[84:94]
                expected_route = 0 if self.route == "left" else 1
                host_timeout_restored = (
                    words[4] == 16
                    and words[1] == 3
                    and words[5] == 0x3FF
                    and words[6] == 0x3FF
                    and words[7] == 0x3FF
                    and words[15] == 0
                    and self.baseline in ALLOWED_YHM_BASELINES
                    and self.baseline == self.restored
                )
                if (
                    proof != PROOF
                    or words[0] != 0x57463247
                    or words[1] != 3
                    or words[2] != expected_route
                    or (
                        not host_timeout_restored
                        and words[3] != self.sequence
                    )
                    or words[4] not in (0, 16)
                    or words[5] != 0x3FF
                    or words[6] != 0x3FF
                    or words[7] != 0x3FF
                    or words[15] != 0
                    or (
                        not host_timeout_restored
                        and
                        self.completed_transfer is not None
                        and (
                            words[11] != self.completed_transfer[0]
                            or words[12] != self.completed_transfer[0]
                            or words[10] != self.completed_transfer[1]
                        )
                    )
                    or self.baseline != self.restored
                ):
                    raise SafetyError(
                        "case bridge restore proof is incomplete or belongs "
                        "to another transaction: "
                        f"retained={self.retained_result}, "
                        f"baseline={self.baseline.hex()}, "
                        f"restored={self.restored.hex()}"
                    )
                if host_timeout_restored:
                    self.retained_result[
                        "host_timeout_restoration_verified"
                    ] = True
            except Exception as error:
                verification_error = error

            # Retained proof is volatile, but clear and read it back even when
            # verification failed so a later run cannot inherit stale proof.
            try:
                if not identity_verified:
                    raise SafetyError(
                        "refusing retained-data writes without the exact "
                        "reviewed ROM identity and command table"
                    )
                self._write_sram(port, PROOF_ADDRESS, ZERO_PROOF)
                self._write_sram(port, RESULT_ADDRESS, bytes(RESULT_LENGTH))
                if read_memory(port, PROOF_ADDRESS, len(PROOF)) != ZERO_PROOF:
                    raise SafetyError("retained proof did not clear")
                if (
                    read_memory(port, RESULT_ADDRESS, RESULT_LENGTH)
                    != bytes(RESULT_LENGTH)
                ):
                    raise SafetyError("retained result did not clear")
            except Exception as error:
                cleanup_error = error

            if verification_error is not None or cleanup_error is not None:
                details = []
                if verification_error is not None:
                    details.append(f"verification: {verification_error}")
                if cleanup_error is not None:
                    details.append(f"cleanup: {cleanup_error}")
                raise SafetyError("; ".join(details))
            self.restore_verified = True
        finally:
            if port.is_open:
                port.close()

    def close(self) -> None:
        if self.restore_verified and self.application_version is not None:
            return
        errors: list[str] = []
        exit_error: Exception | None = None
        if self.active and self.port is not None and self.port.is_open:
            try:
                self.restored = self._request_exit()
            except Exception as error:
                exit_error = error
            finally:
                self.active = False
                self.port.close()
                self.port = None
        time.sleep(0.35)
        try:
            self._verify_retained_restore()
        except Exception as error:
            errors.append(f"retained restore proof: {error}")
        if exit_error is not None and not self.restore_verified:
            errors.append(f"exit request: {exit_error}")
        try:
            self.application_version = restore_application(
                self.device, expected_version=REVIEWED_CASE_VERSION
            )
        except Exception as error:
            errors.append(f"case application restore: {error}")
        self.close_error = "; ".join(errors) if errors else None


def _progress(route: str):
    last = -1

    def report(completed: int, total: int) -> None:
        nonlocal last
        percent = completed * 100 // total
        if (
            completed == 1
            or completed == total
            or completed % 50 == 0
            or percent >= last + 5
        ):
            print(
                f"{route}: {completed:,}/{total:,} records "
                f"({completed * 100.0 / total:.1f}%)",
                flush=True,
            )
            last = percent

    return report


def _close_checked(transport: CaseSramTempleTransport) -> None:
    transport.close()
    if transport.close_error is not None:
        raise SafetyError(transport.close_error)
    print(
        f"{transport.route}: YHM baseline restored byte-for-byte "
        f"({transport.baseline.hex()}); case application "
        f"B200 {transport.application_version}",
        flush=True,
    )


def final_reset_and_verify_liveness(
    device: str,
    routes: tuple[str, ...],
    expected_version: str,
) -> dict[str, object]:
    """Make B0 the final temple mutation, then run read-only liveness checks."""
    reset_report = reset_both_temples_and_recheck(device)
    for route in routes:
        if not reset_report[f"{route}_present"]:
            raise SafetyError(
                f"{route}: contact did not return after the final B0 reset"
            )

    versions: dict[str, object] = {}
    for route in routes:
        version = None
        for phase_attempt in range(1, 5):
            transport: CaseSramTempleTransport | None = None
            try:
                transport = CaseSramTempleTransport(device, route)
                version = MainFirmwareFlasher(transport).read_version()
                break
            except SafetyError as error:
                if (
                    "bridge setup status 3:" not in str(error)
                    or phase_attempt == 4
                ):
                    raise
                time.sleep(0.5 * phase_attempt)
            finally:
                if transport is not None:
                    _close_checked(transport)
        if version is None:
            raise SafetyError(
                f"{route}: post-reset version retry ended without a result"
            )
        if version.firmware != expected_version or version.hardware != 5:
            raise SafetyError(
                f"{route}: post-reset expected {expected_version}/hardware 5, "
                f"observed {version.firmware}/hardware {version.hardware}"
            )
        versions[route] = asdict(version)
    return {
        "outcome": "success",
        "temple_mutation": "traced stock DEB0 dual-temple reset",
        "case": reset_report,
        "versions": versions,
        "version_is_liveness_not_image_provenance": True,
    }


def can_run_final_reset_after_failure(
    route_results: list[dict[str, object]],
) -> bool:
    """Permit failure recovery only after every attempted route cleaned up."""
    return bool(route_results) and all(
        result.get("case_restore_verified") is True
        and result.get("case_application_version") == REVIEWED_CASE_VERSION
        for result in route_results
    )


def classify_zero_byte_start_boundary(
    error: Exception,
    retained_result: dict[str, object],
) -> dict[str, object] | None:
    """Recognize the interrupted-session START failure proven on 2026-07-25."""
    if (
        not isinstance(error, NonIdempotentOtaError)
        or error.command != 0x52
        or "no complete temple frame" not in str(error)
        or retained_result.get("declared_size") != 0
        or retained_result.get("accepted_size") != 0
    ):
        return None
    return {
        "classification": "wired_start_no_frame_zero_byte_boundary",
        "firmware_bytes_accepted": 0,
        "start_or_header_replay_allowed": False,
        "recommended_next_transport": (
            "fresh BLE full-package session if the temple advertises"
        ),
        "recovery_recommendation": error.recovery_recommendation,
    }


def verify_route_stability(
    flasher: MainFirmwareFlasher,
    expected_version: str,
    expected_hardware: int,
    *,
    queries: int = FLASH_STABILITY_QUERIES,
    interval_seconds: float = FLASH_STABILITY_INTERVAL_SECONDS,
    sleeper=time.sleep,
) -> dict[str, object]:
    """Account for the fresh preflight reply and optionally repeat it."""
    if queries < 1:
        raise ValueError("liveness preflight requires at least one query")
    for index in range(2, queries + 1):
        if interval_seconds:
            sleeper(interval_seconds)
        try:
            observed = flasher.read_version()
        except FlasherError as error:
            raise ProtocolError(
                f"stability query {index}/{queries}: {error}"
            ) from error
        if (
            observed.firmware != expected_version
            or observed.hardware != expected_hardware
        ):
            raise SafetyError(
                f"stability query {index}/{queries}: expected "
                f"{expected_version}/hardware {expected_hardware}, observed "
                f"{observed.firmware}/hardware {observed.hardware}"
            )
    return {
        "queries": queries,
        "interval_ms": interval_seconds * 1_000.0,
        "firmware": expected_version,
        "hardware": expected_hardware,
        "outcome": "success",
    }


def _write_audit(path: Path, audit: dict[str, object]) -> None:
    """Atomically persist a private audit checkpoint."""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    partial.write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.chmod(partial, 0o600)
    os.replace(partial, path)


def resolve_pacing_profile(
    name: str,
    *,
    accept_experimental_risk: bool,
) -> dict[str, object]:
    profile = PACING_PROFILES[name]
    if not profile["hardware_qualified"] and not accept_experimental_risk:
        raise ValueError(
            f"pacing profile {name!r} is not hardware-qualified; "
            "pass --accept-experimental-pacing-risk to use it"
        )
    return dict(profile)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("image", type=Path)

    preflight = subparsers.add_parser("preflight")
    preflight.add_argument("--device", required=True)
    preflight.add_argument("--route", choices=("left", "right"), required=True)
    preflight.add_argument("--expect-version", default=REVIEWED_BASE_VERSION)
    preflight.add_argument("--glasses-seated-confirmed", action="store_true")

    stress = subparsers.add_parser(
        "stress-preflight",
        help="repeat only the read-only 0x24 query before permitting a flash",
    )
    stress.add_argument("--device", required=True)
    stress.add_argument("--route", choices=("left", "right"), required=True)
    stress.add_argument("--expect-version", default=REVIEWED_BASE_VERSION)
    stress.add_argument("--queries", type=int, default=500)
    stress.add_argument(
        "--interval-ms",
        type=float,
        default=15.0,
        help="delay between short read-only queries (default: 15 ms)",
    )
    stress.add_argument("--glasses-seated-confirmed", action="store_true")

    host_stress = subparsers.add_parser(
        "stress-usb",
        help="exercise large CH340 receive envelopes without touching USART3",
    )
    host_stress.add_argument("--device", required=True)
    host_stress.add_argument(
        "--route", choices=("left", "right"), required=True
    )
    host_stress.add_argument("--transactions", type=int, default=500)
    host_stress.add_argument("--payload-bytes", type=int, default=1009)
    host_stress.add_argument("--glasses-seated-confirmed", action="store_true")

    reset = subparsers.add_parser(
        "reset-both-temples",
        help=(
            "send the traced DEB0 bilateral reset, reopen the Case console, "
            "and verify both running temples"
        ),
    )
    reset.add_argument("--device", required=True)
    reset.add_argument("--expect-version", default=REVIEWED_BASE_VERSION)
    reset.add_argument("--glasses-seated-confirmed", action="store_true")

    for command, help_text in (
        (
            "flash-reviewed-cfw",
            "flash the exact reviewed CFW Apollo-main image",
        ),
        (
            "flash-reviewed-official",
            "restore the exact pinned official Apollo-main image",
        ),
    ):
        flash = subparsers.add_parser(command, help=help_text)
        flash.add_argument("image", type=Path)
        flash.add_argument("--device", required=True)
        flash.add_argument(
            "--routes", choices=("both", "left", "right"), default="both"
        )
        flash.add_argument("--glasses-seated-confirmed", action="store_true")
        flash.add_argument("--execute-main-ota", action="store_true")
        flash.add_argument("--accept-single-slot-risk", action="store_true")
        flash.add_argument("--confirm-image-sha256", required=True)
        flash.add_argument(
            "--expect-current-version",
            default=None,
            help=(
                "override the live source-version gate; by default CFW install "
                "requires Stock 2.2.6.10 and official restore accepts Stock "
                "2.2.6.10 or reviewed CFW 2.2.6.11"
            ),
        )
        flash.add_argument(
            "--pacing-profile",
            choices=tuple(PACING_PROFILES),
            default="conservative",
            help=(
                "storage pacing profile; conservative is hardware-qualified "
                "(default: conservative)"
            ),
        )
        flash.add_argument(
            "--accept-experimental-pacing-risk",
            action="store_true",
            help="required for a pacing profile that is not hardware-qualified",
        )
        flash.add_argument("--log", type=Path, required=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "inspect":
        try:
            plan, _ = build_package_plan(args.image)
            print(json.dumps(asdict(plan), indent=2, sort_keys=True))
            print(f"bridge_sha256={hashlib.sha256(build_bridge()).hexdigest()}")
            return 0
        except (OSError, FlasherError, ValueError) as error:
            print(f"Inspection failed: {error}", file=sys.stderr)
            return 1

    if not args.glasses_seated_confirmed:
        parser.error("hardware access requires --glasses-seated-confirmed")

    if args.command == "reset-both-temples":
        try:
            report = final_reset_and_verify_liveness(
                args.device,
                ("right", "left"),
                args.expect_version,
            )
            print(json.dumps(report, indent=2, sort_keys=True))
            return 0
        except (
            OSError,
            FlasherError,
            BootloaderError,
            serial.SerialException,
        ) as error:
            print(
                f"Bilateral reset was not fully verified: {error}",
                file=sys.stderr,
            )
            return 1

    if args.command == "stress-usb":
        if not 1 <= args.transactions <= 10_000:
            parser.error("--transactions must be between 1 and 10000")
        if not 1 <= args.payload_bytes <= 1009:
            parser.error("--payload-bytes must be between 1 and 1009")
        transport: CaseSramTempleTransport | None = None
        return_code = 1
        try:
            case_preflight = read_case_preflight(
                args.device, (args.route,)
            )
            print(
                f"case B200 {case_preflight['case_version']}; "
                f"{args.route} presence confirmed",
                flush=True,
            )
            transport = CaseSramTempleTransport(args.device, args.route)
            for index in range(1, args.transactions + 1):
                transport.stress_host_receive(args.payload_bytes)
                if (
                    index == 1
                    or index == args.transactions
                    or index % 100 == 0
                ):
                    print(
                        f"{args.route}: USB host-only transaction "
                        f"{index:,}/{args.transactions:,} "
                        f"({args.payload_bytes:,}-byte payload)",
                        flush=True,
                    )
            return_code = 0
        except (
            OSError,
            FlasherError,
            BootloaderError,
            serial.SerialException,
        ) as error:
            print(f"USB stress failed safely: {error}", file=sys.stderr)
        finally:
            if transport is not None:
                try:
                    _close_checked(transport)
                except FlasherError as error:
                    print(
                        f"Case restore verification failed: {error}",
                        file=sys.stderr,
                    )
                    return_code = 1
        return return_code

    if args.command in ("preflight", "stress-preflight"):
        query_count = 1 if args.command == "preflight" else args.queries
        if not 1 <= query_count <= 10_000:
            parser.error("--queries must be between 1 and 10000")
        query_interval = (
            0.0
            if args.command == "preflight"
            else args.interval_ms / 1_000.0
        )
        if not 0.0 <= query_interval <= 1.0:
            parser.error("--interval-ms must be between 0 and 1000")
        transport: CaseSramTempleTransport | None = None
        return_code = 1
        try:
            case_preflight = read_case_preflight(
                args.device, (args.route,)
            )
            print(
                f"case B200 {case_preflight['case_version']}; "
                f"{args.route} presence confirmed",
                flush=True,
            )
            transport = CaseSramTempleTransport(args.device, args.route)
            flasher = MainFirmwareFlasher(transport)
            for index in range(1, query_count + 1):
                try:
                    observed = flasher.read_version()
                except FlasherError as error:
                    raise ProtocolError(f"query {index}: {error}") from error
                if observed.firmware != args.expect_version:
                    raise SafetyError(
                        f"query {index}: expected {args.expect_version}, "
                        f"observed {observed.firmware}"
                    )
                if observed.hardware != 5:
                    raise SafetyError(
                        f"query {index}: expected hardware 5, "
                        f"observed {observed.hardware}"
                    )
                if (
                    query_count == 1
                    or index == 1
                    or index == query_count
                    or index % 100 == 0
                ):
                    print(
                        f"{args.route}: query {index:,}/{query_count:,}, "
                        f"temple firmware={observed.firmware}, "
                        f"hardware={observed.hardware}",
                        flush=True,
                    )
                if index != query_count and query_interval:
                    time.sleep(query_interval)
            if query_count > 1:
                print(
                    f"{args.route}: completed {query_count:,} consecutive "
                    "read-only transactions",
                    flush=True,
                )
            return_code = 0
        except (
            OSError,
            FlasherError,
            BootloaderError,
            serial.SerialException,
        ) as error:
            print(f"Preflight failed safely: {error}", file=sys.stderr)
        finally:
            if transport is not None:
                try:
                    _close_checked(transport)
                except FlasherError as error:
                    print(f"Case restore verification failed: {error}", file=sys.stderr)
                    return_code = 1
        return return_code

    assert args.command in (
        "flash-reviewed-cfw",
        "flash-reviewed-official",
    )
    image_kind = (
        "CFW"
        if args.command == "flash-reviewed-cfw"
        else "official"
    )
    reviewed_sha256 = (
        REVIEWED_CFW_SHA256
        if args.command == "flash-reviewed-cfw"
        else REVIEWED_OFFICIAL_SHA256
    )
    reviewed_main_sha256 = (
        REVIEWED_MAIN_SHA256
        if args.command == "flash-reviewed-cfw"
        else REVIEWED_OFFICIAL_MAIN_SHA256
    )
    reviewed_main_bytes = (
        REVIEWED_MAIN_BYTES
        if args.command == "flash-reviewed-cfw"
        else REVIEWED_OFFICIAL_MAIN_BYTES
    )
    expected_current_versions = (
        {args.expect_current_version}
        if args.expect_current_version
        else (
            {REVIEWED_BASE_VERSION}
            if image_kind == "CFW"
            else {REVIEWED_BASE_VERSION, REVIEWED_CFW_VERSION}
        )
    )
    if not args.execute_main_ota:
        parser.error("flash requires --execute-main-ota")
    if not args.accept_single_slot_risk:
        parser.error("flash requires --accept-single-slot-risk")
    try:
        pacing = resolve_pacing_profile(
            args.pacing_profile,
            accept_experimental_risk=args.accept_experimental_pacing_risk,
        )
    except ValueError as error:
        parser.error(str(error))
    try:
        plan, component = build_package_plan(args.image)
    except (OSError, FlasherError, ValueError) as error:
        print(f"Package validation failed: {error}", file=sys.stderr)
        return 1
    if plan.image_sha256 != reviewed_sha256:
        parser.error(
            "this case bridge command accepts only the reviewed "
            + image_kind
            + " image "
            + reviewed_sha256
        )
    if (
        plan.main_payload_bytes != reviewed_main_bytes
        or plan.main_payload_sha256 != reviewed_main_sha256
    ):
        parser.error(
            "the Apollo-main component does not match the reviewed "
            + image_kind
            + " pin"
        )
    if args.confirm_image_sha256.lower() != plan.image_sha256:
        parser.error(
            "--confirm-image-sha256 does not match the "
            + image_kind
            + " image"
        )

    routes = (
        ("right", "left")
        if args.routes == "both"
        else (args.routes,)
    )
    audit: dict[str, object] = {
        "schema_version": 3,
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "operation": f"g2_case_usb_reviewed_{image_kind.lower()}_main_only",
        "device": args.device,
        "routes": routes,
        "package": asdict(plan),
        "installed_identity": {
            "channel": "custom" if image_kind == "CFW" else "official",
            "reported_version": plan.expected_device_version,
            "display_version": (
                f"{plan.expected_device_version} CFW"
                if image_kind == "CFW"
                else plan.expected_device_version
            ),
            "exact_image_sha256": plan.image_sha256,
            "evidence": (
                "reviewed image pins, accepted transfer counts, postflight, "
                "final bilateral reset, and liveness"
            ),
        },
        "accepted_source_versions": sorted(expected_current_versions),
        "pacing_profile": {
            "name": args.pacing_profile,
            **pacing,
        },
        "bridge_sha256": BRIDGE_SHA256,
        "bootloader_component_allowed": False,
        "data_replay_allowed": False,
        "component_attempts_per_invocation": 1,
        "component_restart_boundary": (
            "new invocation after verified cleanup and final bilateral reset"
        ),
        "route_results": [],
        "final_reset_and_liveness": None,
        "outcome": "started",
    }
    try:
        _write_audit(args.log, audit)
    except OSError as error:
        print(
            f"Refusing hardware access because the audit log cannot be "
            f"created: {error}",
            file=sys.stderr,
        )
        return 1
    return_code = 1
    try:
        case_preflight = read_case_preflight(args.device, routes)
        audit["case_preflight"] = case_preflight
        _write_audit(args.log, audit)
        print(
            f"case B200 {case_preflight['case_version']}; selected route "
            "presence confirmed",
            flush=True,
        )
        for route in routes:
            transport: CaseSramTempleTransport | None = None
            route_result: dict[str, object] = {"route": route}
            route_error: Exception | None = None
            cleanup_error: Exception | None = None
            try:
                for phase_attempt in range(1, 5):
                    print(
                        f"{route}: loading verified volatile case bridge "
                        f"(route-phase attempt {phase_attempt}/4)",
                        flush=True,
                    )
                    try:
                        transport = CaseSramTempleTransport(
                            args.device,
                            route,
                            require_route_phase=True,
                        )
                        route_result["route_phase_setup_attempts"] = (
                            phase_attempt
                        )
                        break
                    except SafetyError as error:
                        if (
                            "bridge setup status 3:" not in str(error)
                            or phase_attempt == 4
                        ):
                            raise
                        print(
                            f"{route}: Case idle phase does not match the "
                            "selected mutation route; retrying before any "
                            "temple transmission",
                            flush=True,
                        )
                        time.sleep(0.5 * phase_attempt)
                assert transport is not None
                flasher = MainFirmwareFlasher(
                    transport,
                    response_timeout=8.0,
                    finish_timeout=60.0,
                    data_retries=0,
                    retry_backoff_seconds=30.0,
                    deferred_batch_size=int(pacing["deferred_batch_size"]),
                    batch_settle_seconds=float(
                        pacing["batch_settle_seconds"]
                    ),
                    late_batch_settle_seconds=float(
                        pacing["late_batch_settle_seconds"]
                    ),
                    late_batch_threshold=float(
                        pacing["late_batch_threshold"]
                    ),
                    final_settle_seconds=float(
                        pacing["final_settle_seconds"]
                    ),
                    progress=_progress(route),
                )
                current = flasher.read_version()
                route_result["preflight_version"] = asdict(current)
                print(
                    f"{route}: preflight firmware={current.firmware}, "
                    f"hardware={current.hardware}",
                    flush=True,
                )
                if current.firmware not in expected_current_versions:
                    raise SafetyError(
                        f"{route}: expected source firmware in "
                        f"{sorted(expected_current_versions)}, observed "
                        f"{current.firmware}"
                    )
                if current.hardware != 5:
                    raise SafetyError(
                        f"{route}: expected hardware 5, "
                        f"observed {current.hardware}"
                    )
                route_result["stability_preflight"] = verify_route_stability(
                    flasher,
                    current.firmware,
                    current.hardware,
                )
                print(
                    f"{route}: completed {FLASH_STABILITY_QUERIES} "
                    "consecutive read-only stability queries",
                    flush=True,
                )
                time.sleep(FLASH_PRE_START_SETTLE_SECONDS)
                transport.drain_input()
                print(
                    f"{route}: starting reviewed {image_kind} "
                    "Apollo-main transfer; "
                    "do not disturb the case",
                    flush=True,
                )
                transfer = flasher.flash_main(component)
                transport.completed_transfer = (
                    transfer.payload_bytes_sent,
                    transfer.records_sent,
                )
                route_result["transfer"] = asdict(transfer)
                postflight = poll_for_version(
                    flasher,
                    plan.expected_device_version,
                    timeout=180.0,
                    interval=2.0,
                )
                route_result["postflight_version"] = asdict(postflight)
                if postflight.hardware != 5:
                    raise SafetyError(
                        f"{route}: postflight hardware changed to "
                        f"{postflight.hardware}"
                    )
                print(
                    f"{route}: postflight firmware={postflight.firmware}, "
                    f"hardware={postflight.hardware}",
                    flush=True,
                )
            except (
                OSError,
                FlasherError,
                BootloaderError,
                serial.SerialException,
            ) as error:
                route_error = error
            finally:
                if transport is not None:
                    try:
                        _close_checked(transport)
                    except (
                        OSError,
                        FlasherError,
                        BootloaderError,
                        serial.SerialException,
                    ) as error:
                        cleanup_error = error
                    finally:
                        route_result["case_restore_verified"] = (
                            transport.restore_verified
                        )
                        route_result["case_application_version"] = (
                            transport.application_version
                        )
                        route_result["yhm_baseline"] = transport.baseline.hex()
                        route_result["retained_result"] = (
                            transport.retained_result
                        )
            if route_error is not None or cleanup_error is not None:
                route_result["outcome"] = "failed_or_uncertain"
                if route_error is not None:
                    route_result["error"] = str(route_error)
                    if isinstance(route_error, NonIdempotentOtaError):
                        route_result["failure_stage"] = route_error.stage
                        route_result["failed_command"] = (
                            f"0x{route_error.command:02x}"
                        )
                        route_result["recovery_recommendation"] = (
                            route_error.recovery_recommendation
                        )
                    recovery_boundary = classify_zero_byte_start_boundary(
                        route_error,
                        route_result.get("retained_result", {}),
                    )
                    if recovery_boundary is not None:
                        route_result["recovery_boundary"] = recovery_boundary
                if cleanup_error is not None:
                    route_result["cleanup_error"] = str(cleanup_error)
                cast_results = audit["route_results"]
                assert isinstance(cast_results, list)
                cast_results.append(route_result)
                _write_audit(args.log, audit)
                if route_error is not None and cleanup_error is not None:
                    raise SafetyError(
                        f"primary transaction: {route_error}; "
                        f"cleanup verification: {cleanup_error}"
                    )
                if route_error is not None:
                    raise route_error
                assert cleanup_error is not None
                raise cleanup_error
            route_result["outcome"] = "success"
            cast_results = audit["route_results"]
            assert isinstance(cast_results, list)
            cast_results.append(route_result)
            _write_audit(args.log, audit)
        print(
            "All selected routes and the case application are restored; "
            "sending the final traced B0 dual-temple reset",
            flush=True,
        )
        final_reset = final_reset_and_verify_liveness(
            args.device,
            routes,
            plan.expected_device_version,
        )
        audit["final_reset_and_liveness"] = final_reset
        _write_audit(args.log, audit)
        print(
            "Final B0 reset confirmed; selected contacts and checksum-valid "
            "post-reset version replies verified",
            flush=True,
        )
        audit["outcome"] = "success"
        return_code = 0
    except (
        OSError,
        FlasherError,
        BootloaderError,
        serial.SerialException,
    ) as error:
        audit["outcome"] = "failed_or_uncertain"
        audit["error"] = str(error)
        route_results = audit["route_results"]
        assert isinstance(route_results, list)
        for route_result in reversed(route_results):
            if "recovery_boundary" in route_result:
                audit["recovery_boundary"] = route_result["recovery_boundary"]
                break
            if "recovery_recommendation" in route_result:
                audit["recovery_recommendation"] = (
                    route_result["recovery_recommendation"]
                )
                break
        if (
            audit["final_reset_and_liveness"] is None
            and can_run_final_reset_after_failure(route_results)
        ):
            try:
                audit["final_reset_and_liveness"] = (
                    final_reset_and_verify_liveness(
                        args.device,
                        routes,
                        plan.expected_device_version,
                    )
                )
                print(
                    "Transfer remains failed or uncertain; final B0 reset and "
                    "post-reset liveness nevertheless verified",
                    file=sys.stderr,
                    flush=True,
                )
            except (
                OSError,
                FlasherError,
                BootloaderError,
                serial.SerialException,
            ) as reset_error:
                audit["final_reset_and_liveness"] = {
                    "outcome": "failed",
                    "error": str(reset_error),
                }
        print(
            "Flash stopped; the current route may be incomplete or uncertain: "
            f"{error}",
            file=sys.stderr,
            flush=True,
        )
    finally:
        audit["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
        try:
            _write_audit(args.log, audit)
            print(f"Wrote audit log: {args.log}")
        except OSError as error:
            print(f"Could not write audit log: {error}", file=sys.stderr)
            return_code = 1
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())

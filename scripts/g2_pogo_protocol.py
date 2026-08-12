#!/usr/bin/env python3
"""Offline model of the running G2 temple's product-test OTA protocol.

This module performs no hardware I/O.  It parses complete EVENOTA bundles and
builds the checksum-protected 0x52/0x53/0x54/0x55 requests accepted by the
running Apollo application.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


EVENOTA_MAGIC = b"EVENOTA\0"
TOC_OFFSET = 0x40
TOC_ENTRY_SIZE = 0x10
COMPONENT_HEADER_SIZE = 0x80
DATA_CHUNK_SIZE = 1000
DEFERRED_BATCH_SIZE = 6000


@dataclass(frozen=True)
class Component:
    index: int
    entry_id: int
    type_id: int
    storage_type: int
    filename: str
    header: bytes
    payload: bytes


@dataclass(frozen=True)
class ParsedResponse:
    payload: bytes
    checksum_valid: bool

    @property
    def command(self) -> int | None:
        return self.payload[0] if self.payload else None

    @property
    def status(self) -> int | None:
        if len(self.payload) == 5 and self.payload[1:4] == bytes((1, 3, 1)):
            return self.payload[4]
        return None


def crc16_ccitt_false(data: bytes) -> int:
    """Match Apollo's CRC-16/CCITT-FALSE implementation."""
    crc = 0xFFFF
    for value in data:
        crc ^= value << 8
        for _ in range(8):
            crc = (
                ((crc << 1) ^ 0x1021) & 0xFFFF
                if crc & 0x8000
                else (crc << 1) & 0xFFFF
            )
    return crc


def crc32c_msb(data: bytes) -> int:
    """Calculate the non-reflected CRC-32C used in component headers."""
    crc = 0
    for value in data:
        crc ^= value << 24
        for _ in range(8):
            crc = (
                ((crc << 1) ^ 0x1EDC6F41) & 0xFFFFFFFF
                if crc & 0x80000000
                else (crc << 1) & 0xFFFFFFFF
            )
    return crc


def add_ordinary_checksum(prefix: bytes) -> bytes:
    if not prefix or prefix[0] == 0x54:
        raise ValueError("0x54 uses its inner CRC-16, not the ordinary checksum")
    total_length = len(prefix) + 1
    checksum = (total_length + 0x7D + sum(prefix)) & 0xFF
    return prefix + bytes((checksum,))


def version_request() -> bytes:
    return add_ordinary_checksum(bytes.fromhex("24000100"))


def production_ota_start_request() -> bytes:
    return add_ordinary_checksum(bytes.fromhex("52000000"))


def production_ota_header_request(component_header: bytes) -> bytes:
    if len(component_header) != COMPONENT_HEADER_SIZE:
        raise ValueError("production OTA requires the exact 128-byte header")
    return add_ordinary_checksum(bytes.fromhex("53000080") + component_header)


def production_ota_data_request(
    data: bytes, *, final: bool, sequence: int
) -> bytes:
    if not 0 <= sequence <= 0xFF:
        raise ValueError("sequence must fit in one byte")
    if len(data) > DATA_CHUNK_SIZE:
        raise ValueError("a product-test record carries at most 1,000 bytes")
    if not final and len(data) != DATA_CHUNK_SIZE:
        raise ValueError("every non-final record must carry exactly 1,000 bytes")
    inner_length = len(data) + 4
    return (
        bytes((0x54, 0, 0))
        + struct.pack("<HBB", inner_length, int(final), sequence)
        + data
        + struct.pack("<H", crc16_ccitt_false(data))
    )


def production_ota_finish_request() -> bytes:
    return add_ordinary_checksum(bytes.fromhex("55000000"))


def iter_component_data_requests(payload: bytes) -> Iterator[bytes]:
    if not payload:
        yield production_ota_data_request(b"", final=True, sequence=0)
        return
    chunk_count = (len(payload) + DATA_CHUNK_SIZE - 1) // DATA_CHUNK_SIZE
    for index in range(chunk_count):
        start = index * DATA_CHUNK_SIZE
        yield production_ota_data_request(
            payload[start : start + DATA_CHUNK_SIZE],
            final=index + 1 == chunk_count,
            sequence=index & 0xFF,
        )


def build_response(command: int, status: int) -> bytes:
    """Build the fixed OTA reply for offline tests."""
    if not 0 <= command <= 0xFF or not 0 <= status <= 0xFF:
        raise ValueError("command and status must fit in one byte")
    payload = bytes((command, 1, 3, 1, status))
    response = b"\x5a\xa5\xff" + bytes((len(payload),)) + payload
    return response + bytes((sum(response) & 0xFF,))


def parse_response(frame: bytes) -> ParsedResponse:
    if len(frame) < 5 or frame[:3] != b"\x5a\xa5\xff":
        raise ValueError("not a framed temple response")
    expected_total = frame[3] + 5
    if len(frame) != expected_total:
        raise ValueError(
            f"declared response length is {expected_total}, observed {len(frame)}"
        )
    return ParsedResponse(
        payload=frame[4:-1],
        checksum_valid=frame[-1] == (sum(frame[:-1]) & 0xFF),
    )


def parse_evenota(path: Path) -> list[Component]:
    image = path.read_bytes()
    if len(image) < TOC_OFFSET or image[:8] != EVENOTA_MAGIC:
        raise ValueError(f"{path} is not an EVENOTA image")
    count = struct.unpack_from("<I", image, 8)[0]
    if not 1 <= count <= 64:
        raise ValueError(f"implausible component count {count}")

    components: list[Component] = []
    for index in range(count):
        toc = TOC_OFFSET + index * TOC_ENTRY_SIZE
        entry_id, offset, entry_size, toc_checksum = struct.unpack_from(
            "<IIII", image, toc
        )
        if entry_size < COMPONENT_HEADER_SIZE or offset + entry_size > len(image):
            raise ValueError(f"component {index + 1} exceeds image bounds")
        header = image[offset : offset + COMPONENT_HEADER_SIZE]
        payload = image[offset + COMPONENT_HEADER_SIZE : offset + entry_size]
        payload_size = struct.unpack_from("<I", header, 8)[0]
        header_checksum = struct.unpack_from("<I", header, 12)[0]
        type_id = struct.unpack_from("<I", header, 0x24)[0]
        storage_type = struct.unpack_from("<I", header, 0x28)[0]
        filename = header[0x30:].split(b"\0", 1)[0].decode(
            "utf-8", errors="strict"
        )
        calculated_checksum = crc32c_msb(payload)
        if payload_size != len(payload):
            raise ValueError(f"component {index + 1} payload-size mismatch")
        if (
            calculated_checksum != toc_checksum
            or calculated_checksum != header_checksum
        ):
            raise ValueError(f"component {index + 1} CRC-32C mismatch")
        components.append(
            Component(
                index=index + 1,
                entry_id=entry_id,
                type_id=type_id,
                storage_type=storage_type,
                filename=filename,
                header=header,
                payload=payload,
            )
        )
    return components


def component_wire_summary(component: Component) -> dict[str, object]:
    packets = list(iter_component_data_requests(component.payload))
    first = packets[0]
    last = packets[-1]
    last_data_length = struct.unpack_from("<H", last, 3)[0] - 4
    return {
        "index": component.index,
        "entry_id": component.entry_id,
        "type_id": component.type_id,
        "storage_type": component.storage_type,
        "filename": component.filename,
        "payload_bytes": len(component.payload),
        "payload_sha256": hashlib.sha256(component.payload).hexdigest(),
        "start_record_hex": production_ota_start_request().hex(),
        "header_record_bytes": len(production_ota_header_request(component.header)),
        "data_record_count": len(packets),
        "first_sequence": first[6],
        "last_sequence": last[6],
        "last_flag": last[5],
        "last_data_bytes": last_data_length,
        "full_6000_byte_deferred_batches": (
            len(component.payload) // DEFERRED_BATCH_SIZE
        ),
        "finish_record_hex": production_ota_finish_request().hex(),
    }


def self_test() -> None:
    assert crc16_ccitt_false(b"123456789") == 0x29B1
    assert version_request() == bytes.fromhex("24000100a7")
    assert production_ota_start_request() == bytes.fromhex("52000000d4")
    assert production_ota_finish_request() == bytes.fromhex("55000000d7")
    assert production_ota_data_request(
        b"", final=True, sequence=0
    ) == bytes.fromhex("54000004000100ffff")
    parsed = parse_response(build_response(0x52, 0))
    assert parsed.checksum_valid and parsed.command == 0x52 and parsed.status == 0

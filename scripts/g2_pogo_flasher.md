# G2 running-temple firmware tools

These Python tools implement the recovered `0x52` through `0x55` product-test
OTA protocol exposed by a **running** G2 temple application:

- `g2_case_pogo_flasher.py` uses the retail case's CH340 USB connection and
  the exact reviewed volatile SRAM/YHM bridge.
- `g2_pogo_flasher.py` uses an independently validated raw 1-Mbaud temple
  UART.
- `g2_pogo_protocol.py` contains the hardware-independent parser, checksums,
  and request builders shared by the tools.

They are intentionally fail-closed:

- a complete six-component `EVENOTA` package must pass topology and checksum
  validation;
- only `ota/s200_firmware_ota.bin` (Apollo component type 0) is sent;
- the Apollo bootloader and all peripheral components are rejected;
- the case-USB writer accepts only exact pinned official bundles and pins the
  selected complete-image hash;
- `0x52` start and `0x53` header are never replayed;
- `0x54` DATA is never replayed after a rejection, missing reply, or malformed
  reply; exact cleanup and the bilateral reset/liveness gate may authorize
  only a fresh whole-component START;
- the hardware-qualified Case profile keeps a 6-KiB parser handoff boundary,
  waits 1 second at each boundary and 2 seconds after 75%, and doubles only
  those settle windows for a fresh whole-component retry;
- the checksum-valid, zero-status `0x55` reply is mandatory; and
- success also requires postflight liveness, exact retained accepted
  size/sequence, byte-for-byte YHM restoration, volatile proof cleanup, and
  case 1.2.57 return; then the traced `DEB0` reset is the final
  temple-mutating operation and fresh contact plus version liveness is
required for every restored route.

Do not promote the 12-KiB `balanced-lab` profile. Hardware explicitly rejected
right-Stock DATA after 691,000 accepted bytes even though the Case-to-temple
UART remained error-free. The 6-KiB conservative profile subsequently
completed all 3,524 records and 3,523,396 bytes with FINISH, postflight, exact
route cleanup, and final reset/liveness.

## Install

```bash
python3 -m pip install -r scripts/requirements.txt
```

## Case-USB tool

Offline package/bridge inspection:

```bash
python3 scripts/g2_case_pogo_flasher.py inspect \
  /path/to/g2-2.2.6.10-official.bin
```

Read-only preflight of a seated route:

```bash
python3 scripts/g2_case_pogo_flasher.py preflight \
  --device /dev/cu.usbserial-XXXX \
  --route right \
  --glasses-seated-confirmed
```

Pinned official 2.2.6.10 main restore:

```bash
python3 scripts/g2_case_pogo_flasher.py flash-reviewed-official \
  /path/to/g2-2.2.6.10-official.bin \
  --device /dev/cu.usbserial-XXXX \
  --routes both \
  --glasses-seated-confirmed \
  --execute-main-ota \
  --accept-single-slot-risk \
  --confirm-image-sha256 \
  f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa \
  --log /path/to/g2-official-restore-audit.json
```

Before entering the ROM loader, the tool requires a normal case 1.2.57 banner
and fresh `DEA3` presence for every selected route. The embedded bridge is
decoded, SHA-256 checked, written only to an exact SRAM allowlist, and read
back block by block. Its host leg runs at 115,200 baud with 32-byte
stop-and-wait flow control; its independent case-to-temple leg remains
1,000,000 baud.

“Both” uses independent bridge sessions. It completes the right route,
retained cleanup, and normal case return before beginning the left. Any
missing proof stops the operation and records `failed_or_uncertain` in the
audit. `--log` is required: the tool refuses hardware access unless it can
create a private, atomically updated audit checkpoint.

Once every selected route is restored, the tool verifies Case 1.2.57, sends
the traced stock `DEB0` dual-temple reset, waits for the selected contacts,
and performs checksum-valid version reads. This phase was added after a
hardware recovery session in which the Case moved from
`GLS_L=0, GLS_R=1` with no left reply to `GLS_L=1, GLS_R=1`, left
2.2.6.10/hardware 5, and both working displays. The reset recovery sent no
firmware bytes. Version remains liveness evidence only; the selected image
hash is the exact installed-image provenance.

The reset acknowledgement and post-reset state are collected in distinct
serial sessions. The tested Case confirmed `DEB0` but returned no telemetry
when `DEA3` was sent later through that same open console. The tool now closes
the confirmation session, waits 6.5 seconds, and makes up to three fresh
console attempts with explicit `DEA0` and `DEA3` queries before the read-only
version checks.

The same guarded sequence is available without a firmware transfer:

```bash
python3 scripts/g2_case_pogo_flasher.py reset-both-temples \
  --device /dev/cu.usbserial-10 \
  --glasses-seated-confirmed
```

After a failed transfer, the same final phase is attempted only when every
attempted route has verified YHM cleanup and Case 1.2.57 return. The audit
retains `failed_or_uncertain`; if any cleanup is unverified, no reset command
is sent.

`stress-preflight` repeats the read-only version transaction. `stress-usb`
tests only the CH340/case receive envelope and does not forward its payload to
the temple. See `--help` for their bounded arguments.

## Direct raw-UART tool

The direct tool is useful only when an electrically safe fixture exposes one
temple's raw UART at 1,000,000 baud, 8N1, without flow control:

```bash
python3 scripts/g2_pogo_flasher.py preflight \
  --device /dev/cu.usbserial-RAW \
  --direct-temple-uart-confirmed \
  --expect-version 2.2.6.10
```

Do not pass the retail case CH340 to the direct tool. It is the case STM32's
console, not a transparent temple UART. Use `g2_case_pogo_flasher.py` for that
connection, and do not attach a generic USB-UART adapter directly to the
charging contacts.

The direct tool can inspect or transmit another complete validated package
when its full SHA-256 is explicitly confirmed. The case-USB writer is more
restrictive and accepts only packages in the official compiled allowlist.

## Recovery boundary

This is a running-application, single-slot reinstall path. A `0x54` response
acknowledges parser acceptance, not a separate durable flash commit. Retain the
official image hash, FINISH, reset, and liveness proof for exact installed
provenance.

These tools cannot:

- back up installed Apollo MRAM, INFO0/INFOC, calibration, pairing state, or
  keys;
- operate after the Apollo application or its pogo-UART task has stopped;
- enter or use a protected Ambiq SBL; or
- safely rewrite the only Even bootloader.

Installed-state backup still requires permitted SWD/debug read access or a
separately reviewed read service. Application-dead restoration requires a
proven Apollo SBL/MRAM-recovery or SWD route.

## Offline tests

```bash
npm run test:python
```

The tests use no serial hardware. They cover protocol vectors, package
validation, bootloader rejection, bridge size/hash/vector pins, reply shape
and status handling, exact data-record retries, and mandatory finish
acknowledgement.

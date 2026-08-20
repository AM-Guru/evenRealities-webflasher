# Even Realities WebFlasher

A browser-based analyzer, combined Case + Smart Glasses recovery-backup
utility and guarded charging-case recovery console for the Even Realities G2,
plus signed Nordic Secure DFU updates for the R1 Smart Ring.

The webflasher communicates directly with the case through Web Serial or its
CH340-specific WebUSB transport. Device communication and firmware validation
happen locally in the browser. Case data and uploaded firmware files stay local in the browser.

GitHub Pages target:
[am-guru.github.io/evenRealities-webflasher](https://am-guru.github.io/evenRealities-webflasher/)

## What it supports

- Connects to the retail case's WCH CH340/CH341 USB Serial interface
  (`1A86:7523`).
- Implements the reviewed CH340 control/bulk protocol directly over WebUSB,
  including 1-Mbaud 8N1 application framing, 115200-baud 8E1 STM32 framing,
  and DTR/RTS boot selection.
- Reports case firmware, exposed identifiers, battery and charging telemetry,
  lid state, USB state, glasses presence, temperature, and scalar case state.
- Separates Analyze into Charging Case, Smart Glasses, and Shell & Evidence
  views. The glasses pass captures version, hardware revision, battery,
  voltage, checksum-valid raw frames, and per-route transport/restoration
  proof for both temples.
- Downloads a structured local analytics report containing the case factory
  shell transcript, allowlisted `DEA0`/`DEA2`/`DEA3`/`DEA4` query meanings,
  left/right temple frames, recovery eligibility, and the hardware-validated
  transfer record.
- Identifies the STM32 ROM bootloader, option-byte configuration, active
  physical bank, fallback physical bank, and the firmware visible in each bank.
- Downloads one combined recovery set containing a complete 512 KiB case
  flash backup, the 128-byte case option block, checksum-validated identity
  snapshots from both seated temples, and each route's matching digest-pinned
  official Smart Glasses firmware bundle. A split-version pair — the usual
  remnant of an interrupted cross-version update — is backed up with per-route
  official bundles rather than refused, and a version absent from the archive
  is recorded as an explicit omission while the live snapshots are captured.
- Accepts official five- or six-component `EVENOTA` bundles, wrapped
  `firmware_box.bin` components, and validated raw case images.
- Recognizes and offers all 15 archived official G2 SHA-256 values. Custom
  firmware is excluded from the catalog and both installation paths.
- Offers all 12 archived official R1 releases through signed Nordic Secure
  DFU; bootloader unlocking and owner-key replacement are not included.
- Validates the Apollo main application's independent preamble, CRC-32, target
  region, installed-image boundary, and vector.
- Stages case firmware in the inactive bank and verifies a byte-for-byte
  readback before activation is available.
- Uses the traced stock `B0` command to reset both seated temples, closes the
  reset-confirmation console, then retries fresh Case sessions until their
  links and presence telemetry return.
- Runs the exact reviewed, read-only USB-to-pogo SRAM bridge for left/right
  temple status or firmware/hardware version, with retained transport and
  YHM-restoration proof.
- Computes the recovered `0x52...0x55` pogo OTA record plan for every
  component in a selected official bundle without emitting
  any OTA command, and explicitly marks the Apollo bootloader as omitted.
- Transfers only a pinned official Apollo-main payload
  to a selected running temple through the hardware-validated volatile
  case-USB bridge.
  The browser requires fresh presence telemetry, independent bundle/main/
  bridge trust pins, explicit risk confirmations, exact per-record replies,
  postflight liveness, retained route-restoration proof, volatile-data
  cleanup, and normal case 1.2.57 return.
- Opens in **Easy Mode** at the site root with direct Web Bluetooth as the
  primary Smart Glasses update: choose an official release, select the explicitly
  labeled Left and Right temples, confirm the assignments, and update both
  sides with the complete pinned package. The Case USB workflow stays hidden
  unless Bluetooth is unavailable, a Bluetooth update fails, or the operator
  explicitly opens it for a generally non-working or inaccessible device.
- Keeps the existing multi-pane console as **Advanced Mode**, including all
  manual analysis/recovery controls, and adds the same Update/Restore selector
  and automatic Case-USB recovery action beneath its firmware menu.
- Uses direct Web Bluetooth as the primary update transport. Chrome selects
  the advertising Left and Right temples separately; the flasher rejects a
  wrong-side, missing-side, or conflicting advertised name before connecting.
  It then sends only a complete six-component bundle whose package digest,
  topology, component CRCs, and Apollo MRAM bounds already passed the browser's
  compiled-in pins.
  Every 4-KiB block requires an explicit ACK and every component requires an
  END verification. An explicit NAK permits a bounded in-place resend; a bare
  ACK timeout is ambiguous and restarts the whole component from FILE_CHECK
  without replaying the block.
- Presents both recovery targets under Recover: three-step inactive-bank
  staging/activation for the charging case and a separately gated left,
  right, or both-temple reinstall for responsive Smart Glasses.
- Decodes read-only Apollo510 INFOC and active INFO0 debugger dumps locally,
  then fails closed unless every known SBL UART field matches the pogo route.
- Provides a floating, downloadable **Show Console Log** under Recovery,
  including operation lifecycle, bounded progress milestones, device transport
  messages, and browser failures.
- Shows operation-count progress and the current task in the right-hand footer
  for every analysis, backup, probe, staging, activation, reset, and restore.
- Requests a browser Screen Wake Lock for every persistent firmware mutation,
  reacquires it when the tab becomes visible again, releases it when the
  operation ends, and warns when browser or operating-system policy refuses
  sleep prevention.

## Important limitation

This is a **charging-case recovery and running-temple reinstall tool**. It is
not a dead-temple recovery tool.

The stock G2 case firmware does not expose a USB command that writes Apollo
firmware to an unresponsive glasses temple. The case can power, reset, and
check the glasses, but this tool cannot reflash a dead left or right temple
through the stock case.

The hardware evidence included with this project verifies that a reviewed, volatile SRAM payload can
use the case's existing USART3/YHM2510 front end to exchange fixed status and
version requests with either **running** temple. That is not a stock
USB-to-pogo command, a generic byte bridge, or a dead-application recovery
mechanism. After explicit seated-glasses confirmation, the webflasher can
load that exact digest-pinned bridge into high case SRAM. The payload contains
only embedded status/version requests and cannot accept arbitrary temple
bytes or firmware-transfer commands.

The case write and bank-activation path is research-derived and experimental.
It has not been physically validated by this repository on sacrificial
hardware. Read the safety section before using any write operation.

## Current firmware model

Official G2 2.2.6.10 is a six-component bundle for the codec, BLE
coprocessor, touch controller, charging case, Apollo bootloader, and Apollo
main application. The Apollo510B side uses a single in-place application, not
an A/B rollback:

- Even bootloader base: `0x00410000`
- main application base: `0x00438000`
- staged-install flag boundary: `0x007FE000`

The bootloader can replay a complete staged main image after some interrupted
installs, but no last-known-good application slot or boot-attempt rollback has
been found. It also does not initialize the application's UART2 case link, so
a transparent case bridge would not itself create a dead-temple recovery
route.

In every mirrored G2 main release from 2.0.1.14 through 2.2.6.10, the running
Apollo application configures UART2 at 1,000,000 baud, 8N1, without flow
control:

- Apollo GPIO42/TX reaches case PB9/USART3_RX.
- Apollo GPIO44/RX is driven by case PB8/USART3_TX.
- The case selects the left or right path through its YHM2510 front end and
  time-separates TX-only and RX-only operation.

### Application-alive pogo OTA

The current G2 main application contains a product-test dispatcher on its
1-Mbaud case/pogo UART. Commands `0x52...0x55` wrap the same normal component
OTA service used by the BLE `0xC0/0xC1` path:

| Command | What status zero proves | What it does not prove |
| --- | --- | --- |
| `0x52` | Product-OTA state initialized and normal OTA start dispatched | Any file or MRAM write |
| `0x53` | The exact 128-byte component header was accepted and forwarded | Payload storage |
| `0x54` | Sequence, length, and CRC checks passed; at 6,000-byte/final boundaries work is queued to the normal parser after the reply | Durable filesystem or MRAM commit |
| `0x55` | The normal OTA parser ran and returned its shared component-result byte | Reboot, installation, or the final bootloader MRAM copy |

This is a credible reinstall route only while a temple's main application and
UART task are alive. It is not a bootloader protocol, installed-MRAM backup,
or dead-temple recovery path.

The later commit boundary is component-specific. Apollo main firmware is fully
staged as `ota/s200_firmware_ota.bin`; only after its complete staged-file CRC
passes does the application write update flag `0x55555555` and reset so the
intact Even bootloader can install it. The Apollo bootloader is staged as
`ota/s200_bootloader.bin` and then copied directly into MRAM at `0x00410000`.
Its shared `0x55` result can report success before that later copy occurs.
Power loss or copy failure can therefore destroy the only Even bootloader
despite a successful-looking reply.

The stock case USB factory dispatcher does not originate or forward these
commands. The hardware investigation first verified the reconstructed path with fixed
`yhm-immediate-rx` probes, then physically validated a host-commanded,
one-request USB bridge. The working sequence selects one YHM2510 route,
transmits an internally embedded unframed request, switches USART3 from
TX-only to RX-only, and begins capture immediately—before any YHM/PMIC
diagnostic adds enough delay to miss the short reply.

Both left and right routes returned checksum-valid `5A A5 FF` application
frames with zero USART errors:

| Query | Physically observed result |
| --- | --- |
| Status `0x13` through the host bridge | Left 4,497 mV / 99%; right 4,487 mV / 99% |
| Version `0x24` | Both temples report firmware 2.2.6.10 and hardware revision 5 |

The reviewed browser-safe bridge is exactly 1,720 bytes with SHA-256
`e30e143d522e5a5d0b10a92a15610badcc6aef014333716a94eae183b14dc258`.
It accepts only status, version, or a no-contact exit self-test. All successful
route reads/writes and transmit counts matched, the starting YHM image was
restored byte-for-byte, the retained proof/result regions were cleared, and
stock case firmware 1.2.57 resumed normally. A non-idle charging-route image
was also physically observed to fail closed before transmission.

The webflasher keeps this fixed read bridge for diagnostics and separately
embeds the exact reviewed 2,952-byte V7 write bridge
(`eba56380f04bf00ad9d87dffbc40c3292ec5b3cee458d3607c8cffd0dcbe335b`).
Neither path is an
arbitrary USB-to-pogo sender. The writer's SRAM code permits only the version
query and Apollo-main `0x52...0x55` state machine, while the browser
independently permits only pinned official bundles and their exact main
payloads.

The shared fail-closed host validates the complete bundle, permits only the
Apollo main component, never blindly replays `0x52` start or `0x53` header,
and never replays `0x54` DATA after any failure. Hardware returned explicit,
unadvanced DATA rejections at records 349, 753, 874, and 1,663; same-record
retries after 15, 30, and 60 seconds all produced no complete frame. The Case
path now ends that component attempt, proves Case/YHM cleanup, issues the
bilateral reset, verifies both contacts and applications, and begins a fresh
component from START. It normally permits three total component attempts unless a
conservative restart returns the same `0x54/status 1` rejection within 64
records of an earlier rejection on the same route and target. That clustered
pattern is treated as a persistent receiver/storage boundary and stops before
an unproductive third full-component attempt. Missing,
malformed, or timed-out replies are also never replayed. Together with the
the captured protocol evidence that this grammar carries no destination
block index, this keeps DATA recovery fail-closed. The host also requires one fresh
checksum-valid read-only version reply immediately before the first OTA
command, waits 1 second at each 6-KiB handoff, increases that to 2 seconds
after 75%, and doubles both values for a restarted component. The
whole-component restart budget is four after a verified DATA failure with
exact cleanup proof, and six for the exact retained status-16 host timeout
with complete route restoration, Case 1.2.57 return, and bilateral
reset/liveness; intermediate restarts use doubled pacing and the
budget-exhausting restart uses triple pacing. The final DATA
record gets a 15-second settle, 30 seconds on a normal restart, or 45 seconds
on the status-16 final recovery, with
host-only keepalives. Success requires both the checksum-valid zero-status
`0x55` reply and postflight liveness. A terminal failure preserves a
failed/uncertain audit, restores Case/YHM state, and performs the final
bilateral reset when cleanup is proven.

The 2026-07-26 speed qualification rejected a larger Case storage batch. A
12-KiB `balanced-lab` right-Stock run received an explicit DATA rejection after
691,000 accepted bytes, with zero temple UART errors and exact cleanup. A fresh
6-KiB conservative run then accepted all 3,524 Stock-main records and
3,523,396 bytes, FINISH/postflight, exact YHM restoration, Case 1.2.57 return,
and final bilateral reset/liveness. It took 1,571 seconds. Consequently:

- Update sends the complete pinned official Apollo main when an update is
  required;
- Restore remains the complete reviewed-image operation;
- Case USB retains the 6-KiB deferred-write boundary; and
- `balanced-lab` remains explicit-risk research, not a faster default.

A fresh whole-component retry may use the hardware-qualified
`conservative-retry` profile: the batch remains 6 KiB while settle intervals
double to 2/4 seconds and the final settle becomes 30 seconds. It is valid only
after exact cleanup, bilateral reset/contact/liveness proof, and a new START;
the rejected DATA record is never replayed.

Three 2026-07-30 production attempts disproved pacing as a complete fix for
this Case-to-temple route. Build `e8110e4` rejected record 800 two records after the 798,000-byte
deferred boundary despite a three-second boundary settle. Build `449b15c`
serialized every 1,000-byte record for one second, but rejected record 542 two
records after the 540,000-byte boundary because that change granted the true
six-record deferred commit only the same one-second pause. Build `e81844e`
then retained that per-record serialization and gave every true 6-KiB
boundary an uninterrupted eight-second early or twelve-second late settle,
yet the right temple cleanly rejected record 494 after 493,000 accepted bytes.
All three attempts retained zero temple-UART and host-transport errors, exact
YHM restoration, Case 1.2.57 return, and checksum-valid bilateral 2.2.6.10
liveness after the final reset. The non-clustered rejection points moved
earlier as pacing increased, so the browser no longer escalates this signature
with more Case-USB delay. It stops after verified cleanup and directs the
operator to the fresh Bluetooth full-package path.

A 2.0.7.16 cross-version run provided the clustered-boundary evidence. The
right temple rejected record 2,184 after 2,183,000 accepted bytes, then
rejected record 2,219 after a fresh START, exact cleanup, bilateral reset and
doubled settle pacing. Those records are only 35,000 payload bytes apart. A
third attempt rejected record 34 and provided no stronger recovery evidence.
The host now records command, status, record, accepted bytes and target size
for explicit rejections and stops after the second clustered boundary while
still performing verified cleanup and final bilateral liveness.

A silent DATA record — no reply at all — is handled separately from an
explicit rejection. The DATA handler settles for 2, 8, then 20 seconds and
retransmits the identical record with the identical sequence byte, bounded to
three resends per record and twelve per component attempt. The temple's own
sequence guard accepts only the record it expects; a status-1 rejection of a
resend proves the lost-acknowledgement case and advances to the next record.
An explicitly rejected first transmission still ends the component attempt,
and a silent record does not escalate the remembered pacing level. The same
recovery work corrects bilateral verification for one-route repairs: a seated
temple outside the selected route is checked for liveness rather than asserted
at a version this run never installed.

The first 100-query gate was retired after a fresh hardware comparison showed
the live left route fail at query 52 and the already verified-stock right
route fail at query 53, both with zero UART error flags. Slowing the left probe
to 250 ms moved the failure to query 15, showing an elapsed app-mode route
window rather than a left-contact-specific query count. A later controlled
session then reproduced a missing START after the replacement 10-query gate,
while the identical START was acknowledged after one fresh version query.
Repeated probes were therefore consuming the route they were intended to
validate. The replacement is a single just-in-time checksum-valid liveness
query.

The first Bluetooth-off left restore iteration then exposed a separate CH340
idle-boundary defect before any OTA payload reached the temple. Retained bridge
state showed `ota_state=0`, zero declared/accepted bytes, and a host-header
timeout after exactly five of ten bytes. Both the Python and browser writers
therefore flush transaction headers as two paced five-byte writes; payload
flow control and all non-idempotent replay prohibitions remain unchanged. A
read-only transition then proved that the former two-second drain outlived the
selected app-mode route, while 250 ms retained a checksum-valid reply. The
pre-start drain is therefore 250 ms.

A later default-behavior test selected the newest official Stock bundle,
**Both temples**, and **Complete pinned Apollo main** without changing any
recovery selector. The right route accepted records 1–338, explicitly rejected
record 339, then returned no complete response to the one permitted exact retry
after 6.5 seconds. The host stopped without FINISH and did not begin the left
route. Case/YHM cleanup was verified, so the automatic final `DEB0` ran and
checksum-valid liveness passed on both sides. The result is not a Stock
installation proof: the right image provenance is failed/uncertain, while the
unattempted left retains its previously verified official Stock provenance.
The recovery proof card displays the selected target's own byte and record
count.

Local Vite development serves versioned, immutable
`/firmware-updates/g2/2…` and `/firmware-updates/r1/2…` artifacts from the
repository. The catalog remains local, while missing firmware binaries fail as
missing assets rather than falling through to Vite's `index.html`.

A later failed-OTA recovery added one more hardware result. The right display
worked, but the Case initially reported `GLS_L=0, GLS_R=1` and the left
application did not answer. The fixed reset probe reproduced the stock
dual-route reset waveform, restored its captured YHM image byte-for-byte, and
returned Case 1.2.57. Fresh telemetry then reported both contacts; a
checksum-valid left version reply decoded as 2.2.6.10/hardware 5, and the user
confirmed both displays working. That recovery sent no firmware bytes, so it
validates reset-and-liveness recovery—not an official-image transfer.

The subsequent 2026-07-25 rollback incident produced the first completed
case-USB official-image restore: the right temple accepted all 3,524 records
and 3,523,396 pinned stock bytes, returned firmware 2.2.6.10/hardware 5, and
the Case restored its YHM baseline byte-for-byte. The left data path became
intermittent despite `GLS_L=1` and normal charging voltage. It accepted 85,000
bytes on one attempt, then later read-only sessions lost complete frames at
queries 5, 41, and 81 with zero UART error flags. Presence/charging therefore
does not prove a reliable pogo data contact.

The browser and Python implementations now parse `GLS_L`/`GLS_R` from the
Case's `A3` line even when `otaGls` is absent (`otaGls` is reported separately
on `A4` by the tested Case), enforce the just-in-time liveness query before any
OTA mutation, and retain the validated final dual-reset/contact/version phase.
Case USB completed the pinned official Apollo-main transfer on the right. The
left product-test path remained unreliable after its interrupted 85,000-byte
session even with phone Bluetooth disabled: multiple fresh sessions sent START
but accepted zero header/data bytes. A fresh local BLE connection using the
the reviewed direct-Bluetooth recovery tool then completed all six pinned official
components: 1,053 status-zero block ACKs, six END status-8 (`UPDATING`)
verifications, zero
resends, and all 861 Apollo-main blocks. The prescribed final `DEB0` reset
subsequently returned checksum-valid 2.2.6.10/hardware-5 replies from both
temples. Application-dead recovery remains unproven.
Both continue to mark the Apollo bootloader component **OMIT FROM POGO** until
an independent SBL, MRAM-recovery, or SWD route is proven.

A later Chromium/Python recovery cycle isolated the remaining Case-path
timeout. Production Web Serial first failed because a CH340 packet contained
one ROM ACK plus only 31 data bytes; the local host now abandons that partial
transaction, re-enters the loader, and completes all option, flash, and SRAM
reads in 31-byte requests. With that correction, integrated Chromium completed
Case analysis, a full 512-KiB Case backup, and checksum-valid left/right
2.2.6.10/hardware-5 probes.

The V4 DATA capture window then crossed the former Stock failures at 829,000
and 840,000 accepted bytes and completed the right Stock main: 3,523,396
bytes, 3,524 records, zero retries, FINISH acknowledgement, postflight
liveness, YHM restoration, and Case 1.2.57 return. The left V4 session accepted
823,000 bytes before an ambiguous no-frame result and therefore did not send
FINISH or replace the previously proven six-component Stock installation.
The final `DEB0` reset was confirmed after all attempts; fresh Chromium probes
then returned the same checksum-valid 2.2.6.10/hardware-5 frame from both
temples.

V6 extends the bounded START/HEADER/DATA/FINISH receive loop to
`0x04000000`, retains the 2,920-byte SRAM layout, and supports exact
bidirectional phase adaptation between the five allowlisted seated-idle YHM
baselines. An integrated Chromium Easy Mode run completed the official Stock
main on both temples. The right accepted all 3,524 records on its first V6
attempt. The left explicitly rejected its first attempt, so the host performed
verified cleanup, bilateral reset and liveness, then restarted the whole left
component with doubled pacing; all 3,524 records, FINISH, postflight, YHM
restoration, and Case 1.2.57 return passed. The final `DEB0`, both contacts,
and both checksum-valid 2.2.6.10/hardware-5 replies passed. A following
default Easy Mode Stock Update transmitted zero firmware bytes because the
saved bilateral audit already proved the selected target; its reset/liveness
verification also passed.

One later Case reported the previously unseen YHM baseline
`811004aeaf03812033ff`. The mutation bridge correctly rejected it before route
selection with status 3, zero selected/restored/write masks, zero temple
transactions, and zero accepted firmware bytes. A later WebFlasher `2825fce`
run produced six verified zero-write probes around two bilateral resets and
settled through `811004aeaf03812033ff`, `810104afae03812033ff`, and
`810004aeae03812033ff`. Each is the exact counterpart of a reviewed seated
state with only YHM register 8 changing from `0x22` to `0x33`.

The browser now keeps the original five-state `reviewed-22` bridge byte-for-byte
and adds a separate `observed-33` profile. Both the 1,720-byte read-only bridge
and 2,952-byte writer are independently SHA-256 pinned; the profile binaries
differ from their reviewed originals at exactly three table bytes, each
`0x22 → 0x33`. The browser may select `observed-33` only after immutable
retained SRAM proves an exact recognized baseline, zero YHM writes, and zero
temple transmissions, followed by fresh Case 1.2.57 and seated-contact
confirmation. The two unobserved table states remain byte-identical to the
reviewed profile. The selected writer still requires complete selected and
restored masks plus byte-for-byte restoration. Every other baseline remains
fail-closed. This electronic profile is not labeled Frame A or Frame B because
the Case does not expose its mechanical fit variant.

For offline analysis, selected `EVENOTA` bundles show the exact number of
1,000-byte `0x54` records and final sequence value for each component. The
recovered writer grammar uses an exact 128-byte component header for `0x53`,
CRC-16/CCITT-FALSE over each `0x54` data payload, a modulo-256 sequence, and
6,000-byte deferred batches. The expected sequence starts at zero. An explicit
rejection proves that the current sequence did not advance, but Case-path
hardware showed that the receiver does not recover reliably from an
in-session retry. The current host therefore replays no DATA record: after
exact cleanup and reset/liveness proof, it restarts the complete component
from START. Missing or malformed replies remain ambiguous and also abort the
component without replay. Start and header are not treated as replay-safe.
Offline calculation never contacts a temple. During a real
transfer, each acknowledgement is
parser acceptance rather than independent proof of a durable write. The final
acknowledgement, post-reset version, route restore, retained-proof cleanup, and
case-application return are all mandatory for a successful audit.

### Temple backup boundary

The current Apollo application routes BLE OTA lanes `0xC2/0xC3` to a
running-application LittleFS export service. Static analysis indicates that an
authenticated BLE client could potentially retrieve
`ota/s200_firmware_ota.bin` if the staged file remains after the last update.
That would recover the received main-application OTA artifact, not a snapshot
of installed MRAM.

The export does not include the separately installed Even bootloader,
pairing/calibration/key material, INFO0/INFOC, or current internal-memory
state. Present file availability and the full authenticated request sequence
have not been physically validated. The stock case and this USB webflasher
cannot reach `0xC2/0xC3`, so the combined backup does not claim an
installed-memory dump. Instead, it records checksum-validated version and
hardware snapshots from both running temples and embeds the matching official,
digest-pinned `EVENOTA` recovery bundle. This preserves a complete glasses
recovery image for the reported release while keeping the installed-MRAM
boundary explicit in the artifact.

### Dead-application recovery candidates

Ambiq's protected SBL can support a wired UART update after an invalid OEM
image or a provisioned GPIO override, but retail G2 enablement has not been
established. The normal application's proven GPIO42/GPIO44 pogo route is only
a candidate: SBL UART enablement, module, pins, baud rate, override pin,
receive window, lifecycle policy, and image authorization come from
per-device INFOC/INFO0 provisioning.

The stock case has no SBL `HELLO` implementation. A dead-temple claim therefore
requires a read-only INFOC/INFO0 dump and the full, unmasked
`RSTGEN->STAT` value, followed only if provisioning matches by a passive SBL
window capture. Until then there is no proven retail pogo, BLE, or stock-case
path for reflashing an application-dead temple.

The offline decoder in the webflasher checks the recovered provisioning words
without transmitting to hardware:

- INFOC `BOOT_OVERRIDE` at `0x400C2250`
- INFOC `WIRED_CONFIG` at `0x400C2254`
- INFOC active-INFO0 selector at `0x400C23FC`
- active INFO0 UART words at offsets `0x28...0x3C`
- active INFO0 receive timeout at `0x54`
- active INFO0 MRAM-recovery control at `0x68`

An exact match to the known application contacts requires UART2 enabled,
configuration word `0x0F4240C0` (1,000,000 baud, 8N1),
`0x00002A2C` (GPIO44/RX and GPIO42/TX), and pin-function words
`0x00000004, 0x00000004, 0, 0`. MRAM wired recovery additionally requires
the control word's master field to be `0x6` and its wired-recovery bit to be
set. These values are a matching hypothesis for a retail dump, not evidence
that all G2 temples were provisioned this way. A positive result establishes
only a restore candidate; Ambiq's documented UART host does not provide
installed-MRAM readback.

## Requirements

- A current Google Chrome, Microsoft Edge, or other Chromium browser with Web
  Serial or WebUSB.
- HTTPS when using a hosted copy, or `localhost` during development.
- A visible WebFlasher tab while flashing. The HTTPS deployment requests a
  Screen Wake Lock automatically; if the footer reports it unavailable,
  connect AC power and temporarily disable automatic system sleep.
- An Even Realities G2 charging case.
- Both Smart Glasses temples seated and running for the combined backup.
- A USB-C **data** cable, not a charge-only cable.
- Stable USB power for the entire backup or recovery operation.

The browser should offer a serial device with USB ID `1A86:7523`. Depending on
the operating system, it may appear as a CH340/CH341 device or as
`/dev/cu.usbserial-*`.

Direct WebUSB can be unavailable when the operating system has already bound
the CH340 interface to a native driver; use Web Serial on that computer instead.

## How the webflasher works

### 1. Factory-console analysis

The case is opened at 1,000,000 baud, 8 data bits, no parity, and 1 stop bit.
The webflasher uses only the read-only factory commands:

| Command | Purpose |
| --- | --- |
| `DEA0` | Case model and firmware version |
| `DEA2` | Eight-byte factory identifier |
| `DEA3` | Battery, lid, USB, glasses-presence, and temperature telemetry; the tested Case omits `otaGls` here |
| `DEA4` | Scalar case state plus asynchronous telemetry containing `otaGls` |

Analysis exposes only those read queries. The separate, user-invoked glasses
check exposes `DEB0`, a traced reversible hardware reset of both temples; no
provisioning, PMIC-repair, ship-mode, or other factory controls are exposed.

### 2. ROM-loader inspection

The webflasher changes the case's USB control signals to enter the immutable
STM32 ROM loader at 115,200 baud, 8 data bits, even parity, and 1 stop bit. It
then verifies the expected product ID, reads the 128-byte option block, and
inspects both 256 KiB flash banks.

After the browser grants access to exactly one matching `1A86:7523` Case, later
analysis and recovery operations reuse that authorized port. A chooser remains
mandatory when no matching Case is authorized or more than one is available.

CH340 reads can end after one 32-byte USB packet even though the STM32 already
returned to command mode. That packet contains the one-byte ROM ACK followed by
exactly 31 payload bytes. A timed-out block is never appended to a backup. When
the browser detects this exact boundary, it discards the prefix, closes the ROM
session, re-enters and re-identifies the immutable loader, and switches all
remaining reads to complete 31-byte requests. Other transient short reads get
bounded whole-block retries after the same fresh-session synchronization. This
prevents stale partial bytes from being mistaken for the next command
acknowledgement. On 2026-07-25 the hosted browser reproduced the deterministic
boundary repeatedly at option-memory `0x1FFF7800`, receiving 31 of 128 bytes.
The corrected live backup then found the same boundary while verifying the
volatile pogo bridge at SRAM `0x20010000` (31 of 256 bytes), so the adaptive
reader is used for flash, option memory, retained proof, and bridge readback.
Read-only temple probes also use bounded fresh-loader synchronization retries;
the first retry run showed that a Case can still be returning from the backup
console when the immediately following probe first asserts the loader signals.
After the verified SRAM jump, both read-only and writer bridges release BOOT0
before Web Serial changes framing. The Python flasher and the browser writer
already did this; the 2026-07-25 browser backup exposed and corrected the
missing release in the read-only probe.

The browser bridge now keeps the ROM loader's `115200 8E1` framing and one
continuous Web Serial session through the SRAM `GO`, banner, and host request.
This avoids a CH340 close/reopen reset boundary. Read-only route-phase status
`3` remains fail-closed. The host now requires the retained result to prove a
complete ten-register baseline read, zero YHM writes, zero selected/restored
masks, and zero temple transmissions before retrying. It records the exact
baseline, leaves the stock Case application undisturbed for 15 seconds and
then 45 seconds, and re-confirms Case 1.2.57 plus seated contact before each of
the two fresh fixed-bridge retries. No temple request is transmitted until the
YHM baseline matches the allowlist; a text-only status error cannot authorize
a retry.

The option bytes determine which physical bank is mapped as the running bank.
The UI reports the active and inactive physical-bank numbers rather than
assuming that a fixed address always means the same physical bank.

### 3. Running-temple read bridge

After the case reports the selected temple as present and the user confirms it
is seated, the webflasher:

1. enters the immutable case ROM loader;
2. verifies the pinned bridge SHA-256;
3. clears the retained proof/result regions;
4. writes and reads back all 1,720 bridge bytes at `0x20010000`;
5. executes one embedded status or version request;
6. validates the USB reply and the temple frame;
7. re-enters the ROM loader and verifies retained operation, route, byte
   counts, zero UART errors, all router masks, and byte-for-byte YHM restore;
8. clears and rereads both retained regions; and
9. returns to the stock case application.

The bridge writes case SRAM, not flash or option bytes. It writes no persistent
temple state. If the YHM baseline represents an active or non-allowlisted
charging route, it returns status 3 before selecting a route or transmitting.
The included hardware evidence validates the payload and host protocol with its Python
runner. Retain the audit for every browser write.

### 4. Guarded running-temple firmware writer

For an exact pinned official recovery package, the webflasher loads
the separately pinned 2,952-byte V7 bridge at `0x20010000`. It first requires
case firmware 1.2.57. Automatic Apply enables **Update Charging Case first**
by default; when needed it stages the latest official Case image in the
inactive bank, verifies it byte-for-byte, activates it, and re-analyzes the
Case,
fresh seated-route telemetry, the complete bundle SHA-256, the Apollo-main
payload SHA-256, hardware revision 5, and explicit user confirmations.

The host uses 32-byte stop-and-wait USB chunks and replays no START, HEADER,
or FINISH transaction; the one bounded exception is a silent DATA record,
which is retransmitted in place with identical bytes and sequence under the
temple's own sequence guard. An explicit DATA rejection or ambiguous reply
still ends that component attempt. After exact cleanup, bilateral reset,
contact and liveness proof, Easy Mode may begin a fresh full component within
the four-restart budget, with doubled pacing on intermediate restarts. An
exact retained status-16 host timeout widens the budget to six, with the
budget-exhausting attempt triple-paced after the same reset and
liveness proof. V6 rejects a mutating setup before
temple transmission when the Case idle-route phase does not match the selected
side. A bilateral run may reorder left/right in either direction only from an
exact allowlisted zero-write opposite-phase proof, capped at four adaptations.
V7 also handles an observed CH340/USART1 failure in which the Case emitted
only two bytes of a response after accepting DATA. The SRAM bridge
reinitializes USART1 and retransmits only its cached checksum-framed `G2RX`
response; the browser discards the short prefix and synchronizes to that
complete frame. A later run reached cached `G2RX` markers but received only
three of the seven header-suffix bytes on the final candidate. Build 6454760
then received complete headers but stopped twice after 7 of 11
payload/checksum bytes. The browser now uses a bounded 256-byte whole-frame
scan and a two-second inter-byte candidate gap inside an extended response
deadline, allowing another cached retransmission to replace either an
incomplete header or payload. Every complete candidate must match the expected
sequence and checksum. It never retransmits the temple DATA request.
If every host-response attempt fails, immutable-ROM readback may prove a status-16
fatal cleanup only when all route masks are complete and the ten restored YHM
bytes exactly match the allowlisted baseline. That proof permits a fresh
whole-component restart after the bilateral reset/liveness gate; it is not a
transfer-success proof.
If an intermediate or final reset returns a transient no-frame, non-idle YHM,
missing-contact, missing-telemetry, or missing-application-banner result, Easy
Mode sends one bounded second bilateral reset and repeats the read-only
contact/application gate. Wrong versions, incomplete cleanup, a second
failure, and every non-allowlisted failure still stop immediately.
Single-route Advanced repairs use the same bilateral rule: every intermediate
DEB0 gate and the final DEB0 gate verify both seated temple applications, not
only the route being rewritten.
Success additionally
requires the exact `0x55` acknowledgement and a checksum-valid postflight
version. It then exits the bridge, binds the retained proof to the route and
final host sequence, verifies all ten YHM registers were restored
byte-for-byte with zero UART errors, clears and rereads the volatile evidence,
and requires the normal case 1.2.57 banner.

If a running temple has an interrupted product-test session and repeated fresh
`0x52` START requests receive no frame while accepting zero header/data bytes,
or returns a clean explicit DATA rejection at the maximum reviewed pacing,
stop retrying that state machine. Restore the Case/YHM state, issue the
bilateral reset, and use a fresh BLE full-component session when the arm
advertises. The July 25 left recovery established this fallback with the exact
pinned stock package. Browser and Python audits label the zero-byte signature
`wired_start_no_frame_zero_byte_boundary` and record that START/HEADER replay
is forbidden. Easy Mode now performs the same reviewed direct-Bluetooth
protocol after two explicit side selections, while keeping the package,
component, retry, and memory-boundary gates local in the browser.

Any missing transaction or cleanup proof is reported as
`failed_or_uncertain`. The next selected route is not attempted. No bridge
operation erases or writes case flash, case option bytes, the Apollo
bootloader, or peripheral firmware.

### 5. Combined Case + Smart Glasses preservation backup

Before recovery, the tool:

- reads all 524,288 bytes from `0x08000000` through `0x0807FFFF`;
- reads all 128 option bytes at `0x1FFF7800`;
- queries a checksum-valid firmware/hardware version frame from each seated
  temple through the reviewed read-only SRAM bridge;
- requires the left and right firmware versions to match; and
- downloads, reparses, size-checks, and SHA-256-checks the matching official
  `EVENOTA` archive before embedding it in the backup.

The downloaded `.g2-backup.json` contains base64-encoded case memory,
SHA-256 hashes, case firmware and bank state, both raw temple-version frames
and route-restoration proofs, and the complete official glasses recovery
bundle. Treat it as private device data.

The case portion is a byte-for-byte installed-state backup. The Smart Glasses
portion is a live identity snapshot plus a validated recovery image for the
reported release; it is not a readback of installed Apollo MRAM, the separate
installed bootloader, keys, pairing state, calibration, or INFO0/INFOC.

### 6. Firmware validation

For an official `EVENOTA` bundle, the browser validates:

- bundle topology, component names, types, offsets, and lengths;
- the fixed `evenota\0` table trailer and contiguous close at end-of-file;
- every component's non-reflected CRC32C;
- the Apollo main-image size, flags, reserved words, CRC-32, type `0xCB`,
  target `0x00438000`, install-region boundary, and vector;
- the Apollo bootloader region boundary and vector when present;
- the charging-case component's `EVEN` wrapper and additive checksum;
- the raw case image's Cortex-M vector table;
- the archive size and SHA-256 when loaded from the hosted catalog; and
- the offline application-alive pogo transfer record count, final sequence,
  final payload size, and 6,000-byte batching plan for each component.

Standalone wrapped or raw case images receive the applicable case-image
checks. Invalid or oversized images are rejected before writes are enabled.
Successful integrity checks are reported separately from publisher trust.
Only a complete pinned digest identifies an archived official image.

### 7. Inactive-bank staging

Staging erases only the pages required by the selected case image in the
currently inactive physical bank. It does not mass-erase the MCU, overwrite the
active bank, or erase the device-data pages at bank offsets `0x3F000` and
`0x3F800`.

The image is written in ROM-loader blocks, read back, and compared
byte-for-byte and by SHA-256.

### 8. Bank activation

Activation is separate from staging. The tool rereads the inactive bank,
confirms it still matches, rereads the option bytes, and refuses to continue if
the device state changed.

The user must confirm that the backup was stored and type:

```text
ACTIVATE CASE BANK
```

Only then does the webflasher toggle `nSWAP_BANK` while preserving the rest of
the option block. The case resets, returns to its normal application, and is
analyzed again.

## Using the webflasher

### Analyze a case

1. Open the webflasher in a supported desktop browser.
2. Connect the G2 case with a USB-C data cable.
3. Click **Connect & analyze case**.
4. Select the CH340/CH341 serial device in the browser prompt.
5. Wait for the factory-console and ROM-loader passes to complete.
6. Review the case state, identifiers, bank mapping, and firmware versions.

Analysis is read-only. The case may reset while the tool changes between the
normal application and ROM-loader modes.

### Reset and recheck the glasses

1. Insert the left and right temples into the case.
2. Click **Reset both temples & recheck**.
3. Wait for the case to confirm `reset gls L & R, reason: cmd`.
4. The browser closes that console, waits for the temple links, and retries
   explicit `DEA0`/`DEA3` queries in newly opened serial sessions.
5. Review `GLS_L`, `GLS_R`, and the checksum-valid version liveness returned
   by both read-only pogo routes.

This is the physically traced case reset path and does not write firmware.
Live testing found no separate G2 recovery/DFU advertisement across this reset
while the temples were seated.

The 2026-07-25 recovery session validated its practical recovery value. Before
the reset, Case 1.2.57 reported `GLS_L=0, GLS_R=1` and the left application
did not answer. The Case confirmed the fixed dual-route reset, but the
original serial session did not return the immediate post-reset telemetry.
Reopening the normal console restored observation of `GLS_L=1, GLS_R=1`;
read-only bridge queries then returned firmware 2.2.6.10/hardware 5 from both
routes, and both displays worked. No firmware bytes were sent in that
recovery sequence.

It also does not invoke the application-alive `0x52...0x55` pogo OTA wrapper;
the stock case has no USB forwarding route to it.

### Query a running temple

1. Analyze the case and confirm the selected left or right temple is reported
   as present.
2. Under **Volatile read-only bridge**, select either firmware/hardware
   version or battery/voltage status.
3. Confirm the temple is seated and leave USB connected.
4. Click **Run read-only probe**.
5. Review the decoded result and raw checksum-valid temple frame.

Each click performs one fixed request and returns to stock case firmware. If
the tool reports a non-idle YHM baseline, let stock charging activity settle
and retry. This control cannot emit arbitrary bytes or install firmware.

### Easy Mode Bluetooth Update and USB recovery

The bare application URL opens in **Easy Mode**. **Advanced Mode** preserves
the original Connect, Analyze, Preserve, Choose image, and Recovery Console
panes.

1. Choose an official firmware release.
2. Remove both temples from the Case, keep them powered nearby, and disconnect
   the Even app or paired phone.
3. Click **Select LEFT temple**, then choose only the device whose advertised
   name explicitly identifies the Left side. Repeat with **Select RIGHT
   temple**. A wrong, missing, or conflicting side marker is rejected.
4. Confirm the assignments and click **Update … over Bluetooth**. When both
   sides require an update, the webflasher starts independent Left and Right OTA
   sessions simultaneously. If one side stops, the other is allowed to finish
   and both outcomes are retained. The footer shows separate Left and Right
   status bars so connection, transfer, verification, and failure state remain
   visible independently.
5. Keep both temples powered and nearby, and keep the WebFlasher tab in front,
   until all six components have received their END verification on both sides.

Chrome throttles a hidden tab enough to disrupt a multi-fragment BLE block. If
the tab becomes hidden, the webflasher finishes the in-flight transaction and
pauses at the next verified command boundary. It starts no new OTA command until
the tab is visible again, then resumes automatically.

Each selected side is connected immediately and gets bounded retries if its
saved Web Bluetooth handle is temporarily not advertising. After the final
component returns `END 8`/`END 9`, the webflasher never replays the verified image:
it pauses for 10 seconds to allow the temple to reboot, closes any old live OTA
link, and uses the same selected handle and device ID for a bounded fresh GATT
reconnect/liveness probe without reopening Chrome's chooser. A connection loss
during the package also enters the same 10-second recovery window; after the
saved endpoint reconnects, the package re-enters `BEGIN` and only the current
component restarts from its safe `FILE_CHECK` boundary while the other side
continues independently.

Chrome's native chooser can display both sides because Web Bluetooth cannot
filter on a middle-of-name side token. the webflasher therefore combines the G2
name filter with a mandatory post-selection side check and disconnects any
device that does not unambiguously match the requested side.

If Bluetooth is unavailable, the Bluetooth update fails, or either device is
generally non-working or inaccessible over Bluetooth, click **Open USB
recovery**. This reveals the Case-based backup workflow:

1. Click **Select Case** and choose the G2 Case USB device.
2. Click **Diagnose & recover without flashing** first. It classifies each
   seated side as proven Application mode or `recovery-or-unresponsive`; the
   latter intentionally does not claim a specific Apollo bootloader state the
   Case cannot observe. If either side is silent, it issues the bounded traced
   bilateral reboot and proves both checksum-valid Application-mode version
   replies. It then checks previously authorized Bluetooth handles for the
   normal G2 control service. If both sides were already healthy, it performs
   no reset; in either successful case it transmits zero firmware bytes.
3. Only if no-flash recovery is insufficient, leave **Update** selected or
   choose **Restore**.
4. Leave **Update Charging Case first** enabled. It is on by default; no Case
   write occurs when the Case is already current, and the updater never
   downgrades a newer or unknown Case version.
5. Click **Recover … over USB** and keep the Case, glasses, and cable still.

Every USB recovery begins with a fresh full Case analysis, including both physical
banks and all 128 option bytes. When enabled and needed, Apply validates the
latest official Case component, stages only the inactive bank, verifies its
complete readback, activates that bank, and re-analyzes the physical-bank
mapping. The update is accepted only when `nSWAP_BANK` changed, the previously
inactive physical bank is active on the target version, and the previous
active bank remains available as the fallback. It then proves the normal
application banner and opens a separate fresh console to explicitly reissue
`DEA0` with bounded retries. Whether the Case was updated or already current,
the glasses write gate also requires level-0 read access, dual-bank mode,
consistent physical-bank aliases, a valid target-version vector in the active
bank, and a valid fallback-bank vector.

After the Case gate, Apply first obtains a checksum-valid read-only
firmware/hardware-5 reply from each temple, then issues the traced bilateral
`DEB0` reset and obtains fresh replies again. The post-reset identity is the
one used for deployment planning. This normalizes a stale charging-route phase
and prevents old UI analysis or saved browser provenance from choosing the
transfer mode. If initial telemetry is missing a seated contact, the same
bounded reset is used as the recovery attempt instead of stopping before it;
the operation still stops without transmitting firmware if the contact and
application do not return. Smart Glasses firmware bytes remain blocked until
the Case, contacts, and both running temple applications pass these checks. If
the Case-update option is off, an older Case stops at preflight with an
actionable message.

Restore revalidates the selected bundle and rewrites the complete pinned
Apollo main on both temples. It starts right then left, but may reverse that
order only when the retained zero-write setup proof identifies the opposite
allowlisted Case phase. Update also writes the complete pinned Apollo main for
cross-version and unknown-source installs. Before Apply, the no-write transfer
preview reports the selected routes, the firmware bytes that will cross USB,
and—when the installed catalog image is known—the number of source bytes that
actually differ. A fresh checksum-valid Application-mode reply matching the
selected target skips that temple; if both temples match, Update sends zero
firmware bytes and performs only reset/liveness verification. Restore remains
available when an exact pinned-image reinstall is intentional.

If fresh Application-mode replies or saved route audits prove the selected
target on both temples, Apply performs only the required bilateral reset and
liveness verification. If only one temple proves the target, it is preserved
and only the other route is eligible for transfer. An older version, unknown
source, or saved proof outside the reviewed pair selects a complete target-main
write for each remaining route instead of attempting the differential path. A
successful Restore or Update saves fresh per-route proof locally, keyed by
Case serial, for later fail-closed updates.

Automatic Apply handles the reviewed failure boundaries as follows:

| Observed state | Automatic action |
| --- | --- |
| Case older than 1.2.57 | Stage 1.2.57 in the inactive bank, verify readback, switch banks, re-analyze, issue fresh `DEA0`, and recheck both vectors |
| Case option bytes, bank aliases, or fallback vector disagree | Stop before any temple reset or firmware transfer |
| One seated contact is initially missing | Issue the bounded traced bilateral reset and require contact plus application liveness to return |
| Both fresh hardware-5 Application replies already match the selected target | Send zero firmware bytes; perform reset and bilateral liveness verification only |
| One fresh hardware-5 Application reply already matches the selected target | Preserve that temple and update only the other route |
| Responsive hardware-5 temples run an older version such as 2.1.1.12 | Transfer the complete pinned official target main |
| Saved proof disagrees with fresh bilateral identity | Discard the saved plan and transfer the complete pinned target main |
| Just-in-time differential preflight changes before `START` | Retry complete only with proof of zero accepted firmware bytes, exact cleanup, Case 1.2.57 return, and bilateral reset/liveness |
| Differential reaches `FINISH`, but target boot/version liveness fails | Require exact accepted size, FINISH, route cleanup, Case 1.2.57, bilateral application reachability, and a new recovery reset before retrying the complete target |
| Differential failure leaves either temple application unreachable | Stop; do not start the complete fallback through an app-dependent OTA route |
| Read-only YHM baseline is outside the active seated-idle profile | Retry only from exact retained zero-write/zero-transmission proof; switch once to a separately pinned exact profile when recognized, otherwise let the stock app settle for 15 then 45 seconds and re-confirm Case/contact before each probe |
| Allowlisted zero-write YHM setup stop | Perform the bounded settle and setup reset/recheck ladder; if every attempt stops before route selection with immutable zero-byte proof, preserve completed routes, stop wired retries, and direct the operator to fresh Bluetooth full-package recovery |
| Incomplete cached `G2RX` header or payload | Passively scan for a complete same-sequence checksum-valid cached frame; never replay the temple request |
| Exact retained status-16 DATA host timeout after normal retries | Prove byte-for-byte route cleanup, Case 1.2.57, bilateral reset/contact/liveness, then widen the restart budget to six with the final restart triple-paced |
| Silent DATA record (no reply, no acceptance, zero UART/host errors) | Settle 2 s / 8 s / 20 s and resend the identical record in place under the temple's sequence guard, at most 3 per record and 12 per attempt; never escalates pacing memory |
| Two restored explicit DATA rejections recur within 64 records on the same route and target | Classify a persistent receiver/storage boundary, skip the third full-component attempt, restore the Case, and finish with bilateral liveness |
| First final-reset contact, telemetry, banner, YHM, or no-frame check is transient | Wait, issue one bounded second `DEB0`, and repeat the full liveness gate |
| Any transfer mutation, cleanup ambiguity, wrong hardware/version after transfer, or second reset failure | Stop closed and retain the failure audit |

The first hosted retest also exposed a pre-write phase-oscillation edge case.
A status-3 bridge setup reset can leave the Case charging task in the opposite
seated-idle phase. Changing the requested route after the following full Case
return chases that phase back and forth. The writer now keeps the requested
route fixed, waits for a verified Case 1.2.57 application return between
bounded setup retries, and only then samples the YHM baseline again. This
preserves the zero-temple-transmission boundary and lets the Case charging task
settle before any START.

### Restore a pinned main image on running temples

The default firmware selection is the numerically latest official Stock
release, independent of catalog order. Automatic Apply defaults to **Update**
and always targets **Both temples**, using the proof-gated phase-compatible
order. The Advanced Mode manual
recovery console retains its explicit **Both temples** and **Complete pinned
Apollo main** defaults; single-route operations remain explicit choices.

1. Analyze case firmware 1.2.57 with the glasses seated and both desired
   routes reported present.
2. Load a hash-pinned official bundle from the catalog or disk.
3. Under **Guarded running-temple reinstall**, select both routes or one
   explicit route. Both runs right first and then left; each route gets a
   fresh volatile bridge session and complete cleanup.
4. Choose **Complete pinned Apollo main**.
5. Confirm the glasses are seated, accept the single-slot risk, and type
   `FLASH GLASSES FIRMWARE`.
6. Keep the case powered, the lid and glasses still, and the browser awake
   until the audit reports success or `failed_or_uncertain`.
7. Download the audit JSON. Treat the numeric version as identity, not exact
   byte provenance; successful audits still require pinned hashes, accepted
   byte counts, FINISH, reset, and bilateral liveness.

After every selected route and Case 1.2.57 return are verified, the web
flasher sends `DEB0` as the final temple-mutating command. It waits for every
selected contact to return, but does not reuse the reset-confirmation console:
it closes that session and makes up to three newly opened `DEA0`/`DEA3`
attempts. It then performs checksum-valid read-only version probes and
verifies the Case application again. The audit is successful only if this
`finalResetAndLiveness` phase succeeds. Version is liveness evidence; the
complete image and Apollo-main hashes remain provenance.

For a failed or uncertain transfer, the same reset is attempted only when
every attempted route has verified route cleanup and Case 1.2.57 return. The
original transfer outcome remains failed or uncertain. If cleanup is not
verified, the flasher does not send the reset.

This is an application-alive reinstall path. If the temple no longer answers
the version preflight, do not attempt it repeatedly: use a separately proven
SBL/MRAM-recovery or SWD route.

### Direct Bluetooth update

1. Remove both temples from the Case. Close the Even app or turn off Bluetooth
   on the paired phone so the arms advertise as `Even G2_*_R_*` and
   `Even G2_*_L_*`.
2. In Easy Mode, choose the target image, then select the Left temple with the
   Left button and the Right temple with the Right button. the webflasher rejects
   a selection unless its explicit advertised side matches the requested side.
3. Confirm the side names and start the Bluetooth update. Keep the WebFlasher
   tab in front. The browser flashes Left and Right simultaneously using
   independent connections, ACK streams, heartbeats, retry state, and audit
   results. If one side stops, the other continues to its own verified outcome;
   retrying does not rewrite an already verified temple.
4. If the tab is hidden, the writer pauses before its next OTA command and
   resumes automatically at that verified boundary when the tab is visible.
   Wait for all six END verifications on both sides. Re-seat both temples in
   the Case and use the normal reset/recheck path for final checksum-valid
   `2.2.6.11`/hardware-5 liveness proof.

This primary path still depends on the running G2 application and its BLE OTA
service. It is not an application-dead, bootloader, or SWD recovery route.
Use the Case USB recovery controls only when this Bluetooth path fails or a
device is not wirelessly accessible.

### Inspect dead-temple recovery provisioning

1. Acquire INFOC and the selected active INFO0 through a read-only debugger
   session. This webflasher cannot acquire either dump through the stock case.
2. Under **Offline dead-temple candidate**, choose the INFOC dump beginning at
   `0x400C2000` and the active INFO0 dump beginning at offset zero.
3. Review the exact pogo-field match, receive window, SBL restore candidate,
   GPIO override, and MRAM wired-recovery result.

The files remain in the browser. The decoder has no serial or programming
path, and a positive result is not authorization to send an SBL image.

### Recover the charging case

1. Analyze the case.
2. Seat both temples, refresh analysis, click **Back up case + Smart Glasses**,
   and store the downloaded recovery set privately.
3. Select a version from the hosted official archive, or choose a local
   case-compatible official firmware file.
4. Confirm the displayed bundle, case version, size, and integrity results.
5. Click **Stage & verify inactive bank**.
6. Do not disconnect or remove power during erase, write, or readback.
7. Review the staged-bank verification result.
8. Check the backup confirmation, type `ACTIVATE CASE BANK`, and activate.
9. Wait for the case to reset and for the fresh analysis to finish.

If staging fails, the original active bank remains selected. Do not attempt
activation unless staging and readback both completed successfully.

## Python flashing tools

Install the Python tool's only external dependency:

```bash
python3 -m pip install -r scripts/requirements.txt
```

The case-USB tool performs the same pinned-official, running-temple operation
as the browser. Offline inspection opens no hardware:

```bash
python3 scripts/g2_case_pogo_flasher.py inspect \
  /path/to/g2-2.2.6.10-official.bin
```

A read-only preflight loads the volatile bridge, queries one running route,
proves YHM restoration, clears the retained evidence, and returns to case
1.2.57:

```bash
python3 scripts/g2_case_pogo_flasher.py preflight \
  --device /dev/cu.usbserial-XXXX \
  --route right \
  --glasses-seated-confirmed
```

To restore the exact pinned official `2.2.6.10` Apollo main on a selected
running route:

```bash
python3 scripts/g2_case_pogo_flasher.py flash-reviewed-official \
  /path/to/g2-2.2.6.10-official.bin \
  --device /dev/cu.usbserial-XXXX \
  --routes right \
  --glasses-seated-confirmed \
  --execute-main-ota \
  --accept-single-slot-risk \
  --confirm-image-sha256 \
  f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa \
  --log /path/to/g2-official-flash-audit.json
```

The tool rechecks case 1.2.57 and fresh selected-route presence before loading
the writer. It independently verifies the bridge, complete bundle, and main
payload hashes, every SRAM write, hardware revision 5, every OTA reply, final
accepted size/sequence, retained route restoration, volatile cleanup, and
normal case return. Any missing proof is failure or uncertain state.

`scripts/g2_pogo_flasher.py` provides the same main-only host for an
independently validated raw 1-Mbaud temple UART. Do not point that direct-UART
tool at the stock case CH340; use `g2_case_pogo_flasher.py` for the retail
case USB connection. Neither path backs up Apollo MRAM or recovers a temple
whose application/UART task is already dead. The raw-UART tool cannot issue
the Case reset: after a successful raw transfer, run the Case wrapper's
`reset-both-temples` command so bilateral `DEB0` remains the final mutation
and both routes receive read-only liveness verification.

## Firmware archive

The archive builder offers all 15 official G2 releases represented by the
evidence included in this repository. It also verifies and archives every R1 Secure DFU package
exposed by the authenticated compatibility API, with exact CDN size, MD5,
SHA-256, application, and signed init-packet pins:

```text
2.0.1.14  2.0.3.20  2.0.5.12  2.0.6.14
2.0.7.16  2.0.8.20  2.0.9.20  2.1.1.8
2.1.1.12  2.2.0.24  2.2.4.34  2.2.6.10
2.2.7.14  2.2.8.4  2.2.9.22
```

```text
R1: 2.0.3.0013  2.0.5.0004  2.0.6.0005  2.0.7.0004
    2.0.8.0012  2.2.0.0014  2.2.4.0003  2.2.5.0005
    2.2.6.0009  2.2.7.0005  2.2.8.0002  2.2.9.0003
```

It uses the firmware packages already included under `public/` as its local
fallback and may refresh exact pinned originals from the Even Realities CDN. It
does not depend on another checkout or repository.

Run it with:

```bash
npm run archive:firmware
```

Pass `--output <directory>` to write the same `index.json`, `g2/`, and `r1/`
layout elsewhere.

Use `--r1-only` to refresh just the R1 packages and `ringReleases` while
preserving the existing G2 catalog and compiled temple-flash targets.

Each device family has its own directory. Every version directory contains the
original bundle, extracted components, metadata, and checksums:

```text
firmware-archive/
  index.json
  g2/
    2.2.9.22/
      fc250b05e98a9ff998b4b68f5f99f994.bin
      ...
    2.2.8.4/
      d495a1dffb919795e95135e144345f04.bin
      firmware_codec.bin
      firmware_ble_em9305.bin
      firmware_touch.bin
      firmware_box.bin
      firmware_box.raw.bin
      ota_s200_bootloader.bin
      ota_s200_firmware_ota.bin
      metadata.json
      SHA256SUMS
    2.2.6.10/
      e28738432d7b612d625331b00383149b.bin
      ...
  r1/
    <version>/
      r1-<version>-<vendor-md5>.zip
      application.bin
      application.dat
      manifest.json
      metadata.json
      SHA256SUMS
```

The only firmware source of truth is
`public/firmware-updates/`. Its `index.json` catalogs every tracked package,
with G2 packages under `g2/` and R1 packages under `r1/`. Development, tests,
and the production build all read this layout directly. Vite copies it into the
ignored `dist/` deployment artifact and emits `dist/firmware-catalog.json` from
the same index; neither generated file is a second repository source. The
separate ignored `firmware-archive/` directory can be used for local scratch
rebuilds.

## Local development

Node.js 22.13 or newer is required.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The development server is for UI work only. Its hot reload can replace the
page while a temple is committing firmware, so device mutation is blocked
there. For a local hardware session, use the static production build instead:

```bash
npm run hardware
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000). Rebuild and restart
only when no device operation is active.

Available commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server on port 3000 |
| `npm run hardware` | Build and serve a non-hot-reloading local hardware test on `127.0.0.1:3000` |
| `npm test` | Run firmware-parser and safety tests |
| `npm run test:python` | Run the offline Python protocol/transport tests |
| `npm run build` | Create the static production build in `dist/` |
| `npm run check` | Run tests followed by the production build |
| `npm run validate:pages` | Verify the Pages manifest, catalog, base path, and every published firmware package |
| `npm run preview` | Serve the production build locally on port 4173 |
| `npm run clean` | Remove the generated `dist/` deployment artifact |
| `npm run archive:firmware` | Build the verified firmware archive |

## GitHub Pages deployment

After these reviewed changes are committed and pushed, the production site is
published at
[am-guru.github.io/evenRealities-webflasher](https://am-guru.github.io/evenRealities-webflasher/).
The repository is self-contained: the application, release manifest, firmware
catalog, and every catalog-listed firmware package are built into one static
GitHub Pages artifact.

Pushes to `main` and manual workflow runs execute
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) on GitHub's hosted
`ubuntu-latest` environment. The workflow installs dependencies, runs the
JavaScript and Python test suites, builds with the repository-specific Pages
base path, validates every published firmware package against its catalog size
and SHA-256, and deploys `dist/` through GitHub Pages. There is no self-hosted
runner, SSH deployment, release archive, Caddy configuration, or external
firmware mirror.

The GitHub repository is configured with **Pages → Build and deployment →
Source: GitHub Actions**. The Pages workflow uses the standard `pages: write`
and `id-token: write` permissions declared in the workflow.

Every build emits `release.json` with its full Git commit identity and the
SHA-256 of the catalog shipped in the same Pages artifact. Before any firmware
mutation, the running tab fetches that manifest and catalog with `no-store`
and refuses to continue unless the running bundle, deployed commit, and catalog
digest agree. The footer and operation logs include the short commit identity.

To reproduce the Pages build locally:

```bash
GITHUB_ACTIONS=true \
GITHUB_REPOSITORY=AM-Guru/evenRealities-webflasher \
GITHUB_SHA="$(git rev-parse HEAD)" \
  npm run build
npm run validate:pages
```

## Project structure

```text
src/App.jsx                    Guided recovery interface
src/lib/backup.js              Combined case/glasses recovery artifact builder
src/lib/serial.js              Shared serial and STM32 ROM-loader transport
src/lib/webusb.js              CH340 WebUSB serial-compatible transport
src/lib/firmware.js            Bundle, checksum, image, and option-byte logic
src/lib/pogoBridge.js          Pinned read-only SRAM bridge and proof validation
src/lib/pogoFlashBridge.js     Pinned main-only write bridge and protocol gates
src/lib/releaseIntegrity.js    Running/deployed build identity mutation gate
scripts/build-firmware-archive.mjs
                               CDN mirroring and archive extraction
scripts/g2_pogo_flasher.py     Raw 1-Mbaud temple-UART flasher
scripts/g2_case_pogo_flasher.py
                               Case-USB pinned-official flasher
scripts/g2_case_rom.py         Safety-scoped volatile-SRAM ROM primitives
tests/firmware.test.mjs        Parser and safety tests
tests/backup.test.mjs          Combined recovery artifact tests
tests/pogo-flash.test.mjs      Write-bridge and OTA protocol vectors
.github/workflows/pages.yml    GitHub Pages verification and deployment
scripts/validate-pages-build.mjs
                               Static Pages artifact integrity validation
public/even-g2-case-grey.png   G2 product image
public/firmware-updates/       Canonical catalog with g2/ and r1/ packages
```

## Safety and privacy

- Back up the complete case and both seated Smart Glasses before every staging
  attempt.
- Keep the case powered and connected throughout a write operation.
- Keep the WebFlasher tab visible during firmware writes. Screen Wake Lock is
  best-effort and cannot prevent lid closure, shutdown, power loss, browser
  termination, or an operating-system low-power policy from suspending the
  computer.
- Leave the case connected throughout a volatile pogo diagnostic so its
  retained restore proof can be checked and cleared.
- Never use a backup from one case as another case's device-data image.
- Do not publish `.g2-backup.json` files; they can contain identifiers,
  provisioning data, live temple snapshots, and embedded firmware.
- Serial control includes firmware-changing capabilities by design. Keep the
  exact G2 USB identity restriction, bounded frame sizes, one-technician limit,
  existing image trust pins, backup gates, readback verification, and deployed
  release-integrity check intact.
- A successful parser or build test is not a substitute for hardware
  validation.
- This software is provided without warranty under the MIT License.

## Troubleshooting

**The connect button says Chromium USB access is required**

Web Serial and WebUSB are unavailable in the current browser. Use a current
Chromium browser and load the app over HTTPS or from `localhost`.

**The case does not appear in the serial picker**

Try a known USB-C data cable, reconnect the case directly rather than through a
hub, and confirm that the operating system recognizes the CH340/CH341 device.
If **Use WebUSB** reports that the interface is already claimed, use Web Serial;
native USB serial drivers can make the same interface unavailable to WebUSB.

**Analysis times out after a reset**

Reconnect the cable, close other applications that may own the serial port,
choose the device again, and rerun analysis. Do not proceed with recovery from
a partial report.

An analytics export reports `applicationResponsive: null` when a seated temple
has not yet been queried; this is unknown, not a dead application. Charging
percent and voltage parsed from the Case console are labeled as informational
Case estimates. Run the full Smart Glasses analysis for checksum-valid
application status, version, and YHM route proof.

[Even sells the G2 Case](https://www.evenrealities.com/en-FI/products/g2-case)
for **Frame A** and **Frame B** fit geometries. Those labels describe the
matching frame/case fit and are not exposed by the reviewed factory-console or
STM32 ROM fields. The WebFlasher therefore reports the electronic signature
separately and does not guess A/B from the eight-byte factory identifier. An
empty Case legitimately reports `GLS_L:0` and `GLS_R:0`; Automatic Apply stops
before either the Case or glasses are changed until at least one temple is
detected. Use the Case variant matching the glasses and reseat both charging
contacts before retrying.

`sessionRecoveryAuditState` also distinguishes a current-page audit from an
absent one. `not-captured-in-current-page-session` means the export was created
after a reload or before an Apply attempt in that page session; it is not
evidence that no earlier recovery attempt occurred.

**The log reports a short ROM read, such as 31 of 128 bytes**

The Web Serial CH340 path may expose only the first USB packet: one ROM ACK and
31 payload bytes. The current flasher rejects that partial block, opens a new
identified ROM-loader session, and switches to complete 31-byte requests for
the remainder of the capture. Other short-read patterns still receive bounded
fresh-session retries. If analysis still fails, reconnect the Case directly,
close every other serial client, and rerun analysis; never use or restore from
the partial result.

**The case disconnects during activation**

A reset immediately after option-byte programming is expected. Wait for the
tool to reconnect and complete the fresh analysis. If it cannot, disconnect and
reconnect the case, then analyze it without starting another write.

**The operation says this browser tab is running an older WebFlasher**

The production safety release changed after the tab was opened. The write was
blocked before device mutation. Reload the page, confirm the footer and first
operation-log line show the new short commit, reconnect the Case, and retry.

## License

Licensed under the [MIT License](LICENSE.md).

The G2 product image is a user-supplied Even Realities CDN asset and is not
granted additional rights by this repository's MIT license. The interface and
social preview use the current Even Realities editorial palette: warm white,
ink black, and Even yellow.

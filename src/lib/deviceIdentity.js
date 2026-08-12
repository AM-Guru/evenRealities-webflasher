// Stable per-device identity for the G2 Charging Case.
//
// The value the factory console reports as the Case "serial" is the STM32's
// 96-bit unique device ID, not an Even Realities product serial. Comparing two
// cases makes the layout plain:
//
//   case A: 00 31 00 25 | 51 42 50 05 | 20 37 38 4b
//   case B: 00 24 00 24 | 51 42 50 03 | 20 37 38 4b
//              ^     ^              ^
//
// The trailing four bytes are byte-identical, bytes 4-6 are identical, byte 7
// differs by one, and the first word differs — exactly the documented STM32 UID
// layout of die coordinates, wafer number, and an ASCII lot code. Those two
// cases are the same silicon lot on different wafers.
//
// The practical consequence: this ID is an excellent stable key for a specific
// physical case, and it is NOT a hardware-revision indicator. Two cases of
// different revisions built from one lot look nearly identical here, and two of
// the same revision from different lots look unrelated. Anything that wants to
// track revisions has to come from elsewhere — the USB bridge chip revision, or
// an operator-supplied label.

import {
  compareTempleSerials,
  decodeGlassesSerial,
} from "./glassesVariant.js";

export const CASE_UID_BYTES = 12;

// The CH340 reports its own silicon revision during WebUSB setup, where it is
// already read to choose baud divisors and decide whether parity can be set.
// It is the one hardware-revision signal the Case volunteers, and the host
// serial driver hides it, so it is only observable on the WebUSB transport.
export function usbBridgeRevisionOf(port) {
  const version = port?.version;
  return Number.isInteger(version) && version >= 0 ? version : null;
}

function normalizeUidHex(value) {
  const hex = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  return hex.length === CASE_UID_BYTES * 2 ? hex : null;
}

function printableAscii(bytes) {
  return bytes
    .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."))
    .join("");
}

// Decode the reported Case identifier. Returns null when the value is not a
// well-formed 96-bit ID, so callers can fall back rather than invent structure.
export function decodeCaseUid(value) {
  const hex = normalizeUidHex(value);
  if (!hex) return null;
  const bytes = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  // Word 0 carries the die position on the wafer, word 1 the wafer number in
  // its least significant byte plus three lot characters, word 2 four more.
  const lotBytes = [...bytes.slice(4, 7), ...bytes.slice(8, 12)];
  return {
    uid: hex,
    dieY: (bytes[0] << 8) | bytes[1],
    dieX: (bytes[2] << 8) | bytes[3],
    waferNumber: bytes[7],
    // Presented as observed rather than asserting the vendor's canonical
    // character order; it is used for grouping, never for decisions.
    lotHex: lotBytes.map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    lotAscii: printableAscii(lotBytes),
  };
}

// Two cases share a production lot when the lot bytes match, regardless of
// wafer or die position. Useful for spotting whether a behaviour clusters by
// silicon batch.
export function sameProductionLot(firstUid, secondUid) {
  const first = decodeCaseUid(firstUid);
  const second = decodeCaseUid(secondUid);
  return Boolean(first && second && first.lotHex === second.lotHex);
}

// The key every per-device record is filed under. Falls back to a marked
// placeholder so a device that cannot be identified is still usable but is
// never silently merged with a real one.
export function caseDeviceKey(report) {
  const decoded = decodeCaseUid(report?.console?.serialNumber);
  if (decoded) return `uid:${decoded.uid}`;
  const identifier = String(report?.console?.identifier ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  return identifier ? `factory:${identifier}` : "unidentified-case";
}

// A compact, comparable description of the hardware an operation ran against.
// Everything here is observed, never inferred.
//
// The mechanical frame variant used to be permanently absent here, on the
// grounds that the factory console does not report it. That is still true of
// the USB path, but it is not the whole picture: the temples' own Device
// Information serial encodes the frame shape and the colourway, and the
// Bluetooth path can read it (see glassesVariant.js). Pass `templeIdentities`
// when that read succeeded and the variant is recorded; omit it and the
// honest "operator label instead" reason stands.
export function buildDeviceFingerprint({
  report,
  transport = null,
  usbBridgeRevision = null,
  templeVersions = null,
  templeIdentities = null,
  operatorLabel = null,
} = {}) {
  const decoded = decodeCaseUid(report?.console?.serialNumber);
  const temple = (route) => {
    const observed = templeVersions?.[route];
    if (!observed) return null;
    return {
      firmware:
        observed.firmware ?? observed.firmwareVersion ?? null,
      hardware:
        observed.hardware ?? observed.hardwareRevision ?? null,
    };
  };
  return {
    deviceKey: caseDeviceKey(report),
    operatorLabel: operatorLabel || null,
    case: {
      uid: decoded?.uid ?? null,
      uidDecoded: decoded
        ? {
            lotHex: decoded.lotHex,
            lotAscii: decoded.lotAscii,
            waferNumber: decoded.waferNumber,
            dieX: decoded.dieX,
            dieY: decoded.dieY,
          }
        : null,
      uidIsProductSerial: false,
      factoryIdentifier: report?.console?.identifier ?? null,
      firmware: report?.console?.caseVersion ?? null,
      activePhysicalBank: report?.options?.activePhysicalBank ?? null,
      fallbackPhysicalBank: report?.options?.inactivePhysicalBank ?? null,
    },
    transport: {
      kind: transport,
      // Read from the CH340 over WebUSB only; the Web Serial driver hides it.
      // A plausible discriminator between Case hardware revisions.
      usbBridgeRevision:
        Number.isInteger(usbBridgeRevision) && usbBridgeRevision >= 0
          ? `0x${usbBridgeRevision.toString(16).padStart(2, "0")}`
          : null,
    },
    temples: { left: temple("left"), right: temple("right") },
    glasses: buildGlassesIdentity(templeIdentities),
    frameVariant: buildFrameVariant(templeIdentities),
  };
}

function templeSerial(identities, route) {
  const value = identities?.[route]?.serialNumber ?? identities?.[route]?.serial;
  const text = String(value ?? "").trim();
  return text || null;
}

// The product identity of the glasses themselves, as distinct from the Case.
// Null throughout when no temple answered a Device Information read, which is
// the normal state on the USB-only path.
function buildGlassesIdentity(identities) {
  const left = templeSerial(identities, "left");
  const right = templeSerial(identities, "right");
  if (!left && !right) return null;
  const comparison = compareTempleSerials(left, right);
  // Either side's serial identifies the pair; they are equal whenever both
  // were read and agreed.
  const decoded = decodeGlassesSerial(left ?? right);
  return {
    leftSerial: left,
    rightSerial: right,
    // "matched" | "mismatched" | "unknown" - the last meaning only one side
    // was read, never that the two disagreed.
    pairVerdict: comparison.verdict,
    serial: comparison.verdict === "matched" ? comparison.serial : null,
    modelCode: decoded?.modelCode ?? null,
    productName: decoded?.productName ?? null,
    displayName: decoded?.displayName ?? null,
  };
}

function buildFrameVariant(identities) {
  const decoded = decodeGlassesSerial(
    templeSerial(identities, "left") ?? templeSerial(identities, "right"),
  );
  if (decoded?.frame) {
    return {
      value: decoded.frame.toUpperCase(),
      shape: decoded.frameShape,
      colorway: decoded.colorway,
      source: "temple-device-information-serial",
      reason: null,
    };
  }
  return {
    value: null,
    shape: null,
    colorway: null,
    source: null,
    reason: decoded
      ? "The temple serial was read but its model code is not one this tool recognises; record the frame variant with the operator label instead."
      : "The factory console and STM32 ROM fields do not report the Frame A/Frame B mechanical variant. It is carried in the temples' own Bluetooth Device Information serial, which the USB path cannot read; record it with the operator label instead.",
  };
}

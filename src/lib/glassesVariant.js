// Decode an Even Realities glasses serial into product family, frame shape, and
// colourway, and verify that a left and a right temple belong to one pair.
//
// ## Where the mapping comes from
//
// Recovered from the Even Realities companion app 2.2.0 (Flutter AOT), which
// performs exactly this decode to choose its product artwork:
// `even/common/utils/device_image_resolver::_parseGlassesSku` and
// `even/common/extension/ble/ble_mtach_device_ext::evenSNName` / `matchModel`.
//
//   slice     meaning
//   [0..2)    product family - S1 = G1 glasses, S2 = G2 glasses, B2 = R1 ring
//   [0..3)    frame shape    - S20/S28 -> A, S21/S29 -> B, S22 -> C
//                              (G1: S11 -> B, any other S1 -> A)
//   [0..4)    model code     - S211, S110, B210, B290
//   [5]       colourway      - A grey, B brown, C green
//
// Confirmed against hardware: `S211GBBC180304` is a G2 Frame B in brown.
// Frame A is round; Frame B is square.
//
// ## Two deliberate departures from the vendor app
//
// It silently defaults an unrecognised prefix to Frame A and an unrecognised
// colour byte to grey. A flashing tool must not do that: telling an operator
// they are holding a Frame A when the serial says something we have never seen
// is worse than telling them nothing. Unknown values decode to null here.
//
// ## Where this value can and cannot be obtained
//
// Only over Bluetooth, from the temple's own Device Information serial
// (0x180A/0x2A25). The USB path cannot produce it: the factory console reports
// the Charging Case's STM32 96-bit UID (see deviceIdentity.js), which is
// silicon lot/wafer/die data with no product meaning, and the pogo temple
// version frame carries only a firmware version and a hardware revision byte.

export const GLASSES_SERIAL_MIN_LENGTH = 6;

const FAMILY_BY_PREFIX = new Map([
  ["S1", "g1"],
  ["S2", "g2"],
  ["B2", "r1"],
]);

const G2_FRAME_BY_PREFIX = new Map([
  ["S20", "a"],
  ["S28", "a"],
  ["S21", "b"],
  ["S29", "b"],
  ["S22", "c"],
]);

const COLORWAY_BY_CODE = new Map([
  ["A", "grey"],
  ["B", "brown"],
  ["C", "green"],
]);

const PRODUCT_NAME_BY_FAMILY = new Map([
  ["g1", "Even G1"],
  ["g2", "Even G2"],
  ["r1", "Even R1"],
]);

const COLORWAY_LABEL = new Map([
  ["grey", "Grey"],
  ["brown", "Brown"],
  ["green", "Green"],
]);

// Frame shape as the wearer sees it. The vendor names these with bare letters,
// so the letter leads; the shape is the part an operator can check by eye
// against the frames on the bench.
const FRAME_SHAPE = new Map([
  ["a", "round"],
  ["b", "square"],
  ["c", null],
]);

function isGlassesFamily(family) {
  return family === "g1" || family === "g2";
}

// Uppercase, trim, and cut at the first character that cannot appear in a
// serial. That is what removes the `_L_1` / `_R_1` arm suffix carried by
// advertised names and log lines, so both spellings decode to one identity.
export function normalizeGlassesSerial(value) {
  const text = String(value ?? "").trim().toUpperCase();
  const match = /^[0-9A-Z]+/.exec(text);
  return match ? match[0] : "";
}

function frameForPrefix(prefix, family) {
  if (family === "g1") {
    // G1 ships two shapes; the vendor app tests only for S11 and treats every
    // other S1 prefix as A.
    return prefix === "S11" ? "b" : "a";
  }
  if (family === "g2") return G2_FRAME_BY_PREFIX.get(prefix) ?? null;
  return null;
}

// Decode a serial. Returns null when the string is not an Even serial at all,
// so callers fall back to showing the raw value rather than inventing a SKU.
export function decodeGlassesSerial(value) {
  const serial = normalizeGlassesSerial(value);
  // The family prefix (3) and the colour byte (index 5) must both be present
  // for the string to carry any variant information.
  if (serial.length < GLASSES_SERIAL_MIN_LENGTH) return null;

  const family = FAMILY_BY_PREFIX.get(serial.slice(0, 2));
  if (!family) return null;

  const frame = isGlassesFamily(family)
    ? frameForPrefix(serial.slice(0, 3), family)
    : null;
  const colorway = isGlassesFamily(family)
    ? COLORWAY_BY_CODE.get(serial[5]) ?? null
    : null;

  const productName = frame
    ? `${PRODUCT_NAME_BY_FAMILY.get(family)} ${frame.toUpperCase()}`
    : PRODUCT_NAME_BY_FAMILY.get(family);
  const frameLabel = frame
    ? `Frame ${frame.toUpperCase()}${FRAME_SHAPE.get(frame) ? ` (${FRAME_SHAPE.get(frame)})` : ""}`
    : null;
  const colorLabel = colorway ? COLORWAY_LABEL.get(colorway) : null;

  return {
    serial,
    family,
    // Four-character model code, matching the vendor app's `matchModel`.
    modelCode: serial.length >= 4 ? serial.slice(0, 4) : null,
    frame,
    frameShape: frame ? FRAME_SHAPE.get(frame) : null,
    colorway,
    productName,
    frameLabel,
    colorLabel,
    // "Even G2 B (square) · Brown", or whichever halves decoded.
    variantSummary:
      [frameLabel, colorLabel].filter(Boolean).join(" · ") || null,
    displayName: colorLabel ? `${productName} · ${colorLabel}` : productName,
  };
}

// A one-line description for a log line or a report field.
export function describeGlassesSerial(value) {
  const decoded = decodeGlassesSerial(value);
  if (!decoded) {
    const serial = normalizeGlassesSerial(value);
    return serial ? `${serial} (unrecognised serial format)` : null;
  }
  return `${decoded.serial} · ${decoded.displayName}`;
}

// Do the two temples belong to the same pair?
//
// A G2 is two independent Bluetooth peripherals, each carrying its own Device
// Information serial. They read identically on a matched set. They do not when
// two pairs share a bench, when an arm is swapped in, or when a replacement
// temple is fitted.
//
// This matters more here than in a companion app. Flashing is per-temple and
// per-side, so an operator who paired the left arm of one set and the right arm
// of another will happily drive two halves of two different pairs to a state
// neither owner asked for, and the tool would never have said a word.
//
// `verdict` is one of:
//   "matched"    both temples answered with the same serial
//   "unknown"    at least one temple has not reported a serial yet
//   "mismatched" the temples identify different pairs
export function compareTempleSerials(left, right) {
  const leftSerial = String(left ?? "").trim();
  const rightSerial = String(right ?? "").trim();
  if (!leftSerial || !rightSerial) {
    return { verdict: "unknown", left: leftSerial || null, right: rightSerial || null };
  }
  // Compare on the decoded serial when both decode, so an arm suffix or a
  // casing difference in the reported string is not read as different hardware.
  const leftKey =
    decodeGlassesSerial(leftSerial)?.serial ?? normalizeGlassesSerial(leftSerial);
  const rightKey =
    decodeGlassesSerial(rightSerial)?.serial ?? normalizeGlassesSerial(rightSerial);
  if (leftKey && leftKey === rightKey) {
    return { verdict: "matched", left: leftKey, right: rightKey, serial: leftKey };
  }
  return {
    verdict: "mismatched",
    left: leftSerial,
    right: rightSerial,
  };
}

// One sentence naming what is wrong and what to do, or null when nothing is.
// Deliberately concrete about the serials and the visible difference: the
// operator has to sort physical temples on a bench, and the printed serial and
// the frame shape are what they can sort them by.
export function templeSerialMismatchWarning(comparison) {
  if (comparison?.verdict !== "mismatched") return null;
  const left = decodeGlassesSerial(comparison.left);
  const right = decodeGlassesSerial(comparison.right);
  let message =
    `The left and right temples report different serial numbers ` +
    `(left ${comparison.left}, right ${comparison.right}).`;
  if (left?.displayName && right?.displayName && left.displayName !== right.displayName) {
    message += ` They are not even the same model: ${left.displayName} and ${right.displayName}.`;
  }
  message +=
    ` These are arms from two different pairs. Check the serial printed inside` +
    ` each temple and connect a matched set before flashing.`;
  return message;
}

// Do the two temples at least agree on the SKU? Used to explain a mismatch,
// never to approve one - two temples of the same model from different pairs
// still fail `compareTempleSerials`.
export function sameGlassesVariant(left, right) {
  const first = decodeGlassesSerial(left);
  const second = decodeGlassesSerial(right);
  if (!first || !second) return null;
  return first.family === second.family &&
    first.frame === second.frame &&
    first.colorway === second.colorway;
}

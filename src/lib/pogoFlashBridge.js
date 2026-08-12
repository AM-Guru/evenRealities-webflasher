import { equalBytes, readU32LE, sha256Hex } from "./firmware.js";
import { findTempleFlashTarget } from "./templeFlashTargets.js";
import {
  YHM_PROFILE_OBSERVED_33,
  YHM_PROFILE_OBSERVED_45,
  YHM_PROFILE_REVIEWED_22,
  identifyYhmBaselineProfile,
  isYhmBaselineAllowed,
  requireYhmProfile,
  yhmProfileRegister8,
} from "./yhmProfiles.js";

export { TEMPLE_FLASH_TARGETS, findTempleFlashTarget } from "./templeFlashTargets.js";

export const POGO_FLASH_BRIDGE_ADDRESS = 0x20010000;
export const POGO_FLASH_BRIDGE_BYTES = 2952;
export const POGO_FLASH_BRIDGE_SHA256 =
  "eba56380f04bf00ad9d87dffbc40c3292ec5b3cee458d3607c8cffd0dcbe335b";
export const POGO_FLASH_BRIDGE_OBSERVED_33_SHA256 =
  "b341adc44630ffe87b572523ace82b2581785892fff6d7de4e3cf1b0c87861d2";
export const POGO_FLASH_BRIDGE_OBSERVED_45_SHA256 =
  "12746a8c540cde92e893dced10b4c1ef5079410a59b18eef95cea10754b1a431";
// Regression pins for register-8 values already exercised end-to-end; other
// observed profiles verify by construction from the reviewed pin plus the
// bounded four-offset patch.
export const POGO_FLASH_BRIDGE_PROFILE_SHA256 = Object.freeze({
  [YHM_PROFILE_REVIEWED_22]: POGO_FLASH_BRIDGE_SHA256,
  [YHM_PROFILE_OBSERVED_33]: POGO_FLASH_BRIDGE_OBSERVED_33_SHA256,
  [YHM_PROFILE_OBSERVED_45]: POGO_FLASH_BRIDGE_OBSERVED_45_SHA256,
});
export const POGO_FLASH_BRIDGE_BANNER = new TextEncoder().encode(
  "G2_POGO_FLASH_BRIDGE_V7\n",
);
export const POGO_FLASH_RESULT_ADDRESS = 0x20011a00;
export const POGO_FLASH_RESULT_LENGTH = 128;
export const POGO_FLASH_PROOF_ADDRESS = 0x20011b00;
export const POGO_FLASH_PROOF = new Uint8Array([
  0x47, 0x46, 0x52, 0x50, 0xde, 0xc0, 0xde, 0xc0,
]);
export const REVIEWED_CFW_IMAGE_SHA256 =
  "105032302d02ccf943b785070cf15877a918c120b7ca1332bb6261f70eb6d683";
export const REVIEWED_CFW_MAIN_SHA256 =
  "2d82addd4c9916781b50f7be377645b797f10856a460bc5190f3172e7161614e";
export const REVIEWED_CFW_MAIN_BYTES = 3543523;
export const REVIEWED_CFW_BASE_VERSION = "2.2.6.10";
export const REVIEWED_CFW_VERSION = "2.2.6.11";
export const REVIEWED_CASE_VERSION = "1.2.57";
export const POGO_FLASH_STATUS = Object.freeze({
  0: "ok",
  1: "bad host request",
  2: "command or OTA state rejected",
  3: "YHM baseline is not an allowlisted seated-idle state",
  4: "YHM route selection failed",
  5: "temple UART transmit failed",
  6: "no complete framed temple response",
  7: "YHM baseline restoration failed",
  16: "host request timeout",
});

const POGO_FLASH_BRIDGE_BASE64 = "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";
const POGO_FLASH_BRIDGE_PROFILE_PATCH_OFFSETS = Object.freeze([
  2826, 2836, 2846, 2856,
]);

function asBytes(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function bytesFromBase64(value) {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

function sum8(input) {
  return [...asBytes(input)].reduce((sum, value) => (sum + value) & 0xff, 0);
}

function concatBytes(...parts) {
  const arrays = parts.map(asBytes);
  const result = new Uint8Array(
    arrays.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of arrays) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function ordinaryChecksum(prefix) {
  const bytes = asBytes(prefix);
  return concatBytes(
    bytes,
    new Uint8Array([((bytes.length + 1 + 0x7d + sum8(bytes)) & 0xff)]),
  );
}

export class RetryablePogoFlashError extends Error {}
export class TempleRejectedError extends RetryablePogoFlashError {
  constructor(message, { command = null, status = null } = {}) {
    super(message);
    this.command = command;
    this.status = status;
  }
}
export class PogoFlashSafetyError extends Error {}

export const WIRED_START_NO_FRAME_RECOVERY = Object.freeze({
  classification: "wired_start_no_frame_zero_byte_boundary",
  firmwareBytesAccepted: 0,
  startOrHeaderReplayAllowed: false,
  recommendedNextTransport:
    "Fresh BLE full-package session if the temple advertises",
  recoveryRecommendation:
    "Do not replay START in this session or loop fresh wired attempts. After verified Case/YHM cleanup, issue the bilateral DEB0 reset. If the temple still advertises, use a fresh BLE connection to install the complete six-component hash-pinned package, then finish with DEB0 and read-only bilateral liveness.",
});

export const YHM_SETUP_NON_IDLE_RECOVERY = Object.freeze({
  classification: "yhm_setup_non_idle_zero_byte_boundary",
  firmwareBytesAccepted: 0,
  otaMutationAttempted: false,
  wiredRetryPolicy: "bounded_cleanup_deb0_then_fresh_setup",
  recoveryRecommendation:
    "Do not bypass the YHM allowlist. After exact retained proof that setup stopped before route selection or OTA bytes, clear the volatile record, return the Case to firmware 1.2.57, issue a bounded bilateral DEB0 reset/liveness check, and retry only from a fresh setup. Retain the existing Stock/CFW provenance because no OTA mutation began.",
});

export function classifyPogoFlashRecoveryBoundary(
  error,
  retainedResult,
  failureStage,
) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    failureStage === "setup" &&
    message.includes("YHM baseline is not an allowlisted seated-idle state")
  ) {
    return { ...YHM_SETUP_NON_IDLE_RECOVERY };
  }
  if (
    failureStage !== "START" ||
    !message.includes("no complete temple frame") ||
    retainedResult?.declaredSize !== 0 ||
    retainedResult?.acceptedSize !== 0
  ) {
    return null;
  }
  return { ...WIRED_START_NO_FRAME_RECOVERY };
}

export async function getVerifiedPogoFlashBridgePayload(
  profile = YHM_PROFILE_REVIEWED_22,
) {
  requireYhmProfile(profile);
  const reviewedPayload = bytesFromBase64(POGO_FLASH_BRIDGE_BASE64);
  const reviewedDigest = await sha256Hex(reviewedPayload);
  if (
    reviewedPayload.length !== POGO_FLASH_BRIDGE_BYTES ||
    reviewedDigest !== POGO_FLASH_BRIDGE_SHA256
  ) {
    throw new PogoFlashSafetyError(
      `The volatile flash bridge differs from the reviewed build (${reviewedPayload.length} bytes, ${reviewedDigest}).`,
    );
  }
  let payload = reviewedPayload;
  if (profile !== YHM_PROFILE_REVIEWED_22) {
    payload = reviewedPayload.slice();
    for (const offset of POGO_FLASH_BRIDGE_PROFILE_PATCH_OFFSETS) {
      if (payload[offset] !== 0x22) {
        throw new PogoFlashSafetyError(
          "The volatile flash bridge YHM profile table differs from the reviewed layout.",
        );
      }
      payload[offset] = yhmProfileRegister8(profile);
    }
    const digest = await sha256Hex(payload);
    const regressionPin = POGO_FLASH_BRIDGE_PROFILE_SHA256[profile];
    if (regressionPin && digest !== regressionPin) {
      throw new PogoFlashSafetyError(
        `The ${profile} volatile flash bridge differs from its trust pin (${digest}).`,
      );
    }
  }
  if (
    readU32LE(payload, 0) !== 0x2001f000 ||
    readU32LE(payload, 4) !== 0x20010009
  ) {
    throw new PogoFlashSafetyError(
      "The volatile flash bridge vector differs from the reviewed layout.",
    );
  }
  return payload;
}

export function crc16CcittFalse(input) {
  let crc = 0xffff;
  for (const value of asBytes(input)) {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function makeTempleVersionRequest() {
  return ordinaryChecksum(new Uint8Array([0x24, 0, 1, 0]));
}

export function makeOtaStartRequest() {
  return ordinaryChecksum(new Uint8Array([0x52, 0, 0, 0]));
}

export function makeOtaHeaderRequest(header) {
  const bytes = asBytes(header);
  if (bytes.length !== 128) {
    throw new PogoFlashSafetyError("The Apollo main component header must be 128 bytes.");
  }
  return ordinaryChecksum(concatBytes(new Uint8Array([0x53, 0, 0, 0x80]), bytes));
}

export function makeOtaDataRequest(data, final, sequence) {
  const bytes = asBytes(data);
  if (bytes.length > 1000 || (!final && bytes.length !== 1000)) {
    throw new PogoFlashSafetyError("Each non-final 0x54 record must contain 1,000 bytes.");
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xff) {
    throw new PogoFlashSafetyError("The 0x54 sequence must fit in one byte.");
  }
  const header = new Uint8Array(7);
  header.set([0x54, 0, 0]);
  const innerLength = bytes.length + 4;
  header[3] = innerLength & 0xff;
  header[4] = innerLength >>> 8;
  header[5] = final ? 1 : 0;
  header[6] = sequence;
  const crc = crc16CcittFalse(bytes);
  return concatBytes(header, bytes, new Uint8Array([crc & 0xff, crc >>> 8]));
}

export function makeOtaFinishRequest() {
  return ordinaryChecksum(new Uint8Array([0x55, 0, 0, 0]));
}

export function parseTempleFrame(frame) {
  const bytes = asBytes(frame);
  if (
    bytes.length < 5 ||
    bytes[0] !== 0x5a ||
    bytes[1] !== 0xa5 ||
    bytes[2] !== 0xff
  ) {
    throw new RetryablePogoFlashError("The temple response is not a 5A A5 FF frame.");
  }
  if (bytes.length !== bytes[3] + 5) {
    throw new RetryablePogoFlashError("The temple response length is inconsistent.");
  }
  if (bytes.at(-1) !== sum8(bytes.subarray(0, -1))) {
    throw new RetryablePogoFlashError("The temple response checksum is invalid.");
  }
  return bytes.subarray(4, -1);
}

export function decodeTempleVersion(frame) {
  const payload = parseTempleFrame(frame);
  if (
    payload.length !== 9 ||
    payload[0] !== 0x24 ||
    !equalBytes(payload.subarray(1, 4), new Uint8Array([1, 3, 5]))
  ) {
    throw new RetryablePogoFlashError("The temple version response shape is invalid.");
  }
  return {
    firmware: [...payload.subarray(4, 8)].join("."),
    hardware: payload[8],
  };
}

export function requireOtaAcknowledgement(frame, expectedCommand) {
  const payload = parseTempleFrame(frame);
  if (
    payload.length !== 5 ||
    payload[0] !== expectedCommand ||
    !equalBytes(payload.subarray(1, 4), new Uint8Array([1, 3, 1]))
  ) {
    throw new RetryablePogoFlashError(
      `The temple reply does not acknowledge 0x${expectedCommand.toString(16)}.`,
    );
  }
  if (payload[4] !== 0) {
    throw new TempleRejectedError(
      `The temple rejected 0x${expectedCommand.toString(16)} with status ${payload[4]}.`,
      { command: expectedCommand, status: payload[4] },
    );
  }
}

export function makePogoFlashSetup(
  route,
  sequence = 0x42,
  requireRoutePhase = true,
) {
  if (!["left", "right"].includes(route)) {
    throw new PogoFlashSafetyError("The flash route must be left or right.");
  }
  const request = new Uint8Array(10);
  request.set(new TextEncoder().encode("G2FW"));
  request.set(
    [1, route === "left" ? 0 : 1, requireRoutePhase ? 1 : 0, sequence, 0],
    4,
  );
  request[9] = sum8(request.subarray(0, 9));
  return request;
}

export function parsePogoFlashReady(response, setup) {
  const bytes = asBytes(response);
  const request = asBytes(setup);
  if (
    bytes.length !== 13 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== "G2RD" ||
    bytes[4] !== 1 ||
    bytes[6] !== request[5] ||
    bytes[7] !== request[7] ||
    bytes[12] !== sum8(bytes.subarray(0, 12))
  ) {
    throw new PogoFlashSafetyError("The Case bridge ready response is invalid.");
  }
  const baselineMask = bytes[8] | (bytes[9] << 8);
  const selectedMask = bytes[10] | (bytes[11] << 8);
  if (bytes[5] !== 0) {
    throw new PogoFlashSafetyError(
      `The Case bridge stopped during setup: ${POGO_FLASH_STATUS[bytes[5]] ?? `status ${bytes[5]}`}.`,
    );
  }
  if (baselineMask !== 0x3ff || selectedMask !== 0x3ff) {
    throw new PogoFlashSafetyError(
      "The Case bridge did not prove complete baseline and selected-route reads.",
    );
  }
  return { route: bytes[6] === 0 ? "left" : "right", baselineMask, selectedMask };
}

export function makePogoFlashTransactionHeader(sequence, payloadLength) {
  return makePogoFlashHostHeader("G2TX", sequence, payloadLength);
}

export function makePogoFlashHostStressHeader(sequence, payloadLength) {
  return makePogoFlashHostHeader("G2TS", sequence, payloadLength);
}

function makePogoFlashHostHeader(magic, sequence, payloadLength) {
  if (!Number.isInteger(payloadLength) || payloadLength < 0 || payloadLength > 1009) {
    throw new PogoFlashSafetyError("The bridge transaction length is outside 0–1,009.");
  }
  const header = new Uint8Array(10);
  header.set(new TextEncoder().encode(magic));
  header.set([1, sequence, payloadLength & 0xff, payloadLength >>> 8, 0], 4);
  header[9] = sum8(header.subarray(0, 9));
  return header;
}

export function parsePogoFlashResponse(header, tail, expectedSequence) {
  const prefix = asBytes(header);
  const suffix = asBytes(tail);
  if (
    prefix.length !== 11 ||
    new TextDecoder().decode(prefix.subarray(0, 4)) !== "G2RX" ||
    prefix[4] !== 1 ||
    prefix[5] !== expectedSequence ||
    prefix[8] > 64 ||
    suffix.length !== prefix[8] + 1
  ) {
    throw new RetryablePogoFlashError("The Case bridge response header is invalid.");
  }
  const complete = concatBytes(prefix, suffix);
  if (complete.at(-1) !== sum8(complete.subarray(0, -1))) {
    throw new RetryablePogoFlashError("The Case bridge response checksum is invalid.");
  }
  return {
    sequence: prefix[5],
    status: prefix[6],
    uartErrors: prefix[7],
    otaState: prefix[9],
    captured: suffix.slice(0, -1),
  };
}

export function decodePogoFlashRetainedResult(result) {
  const bytes = asBytes(result);
  if (bytes.length !== POGO_FLASH_RESULT_LENGTH) {
    throw new PogoFlashSafetyError("The retained flash result length is invalid.");
  }
  const words = Array.from(
    { length: POGO_FLASH_RESULT_LENGTH / 4 },
    (_, index) => readU32LE(bytes, index * 4),
  );
  return {
    magic: words[0],
    progress: words[1],
    routeValue: words[2],
    route: words[2] === 0 ? "left" : "right",
    sequenceValue: words[3],
    sequence: words[3] & 0xff,
    status: words[4],
    baselineMask: words[5],
    selectedMask: words[6],
    restoredMask: words[7],
    writeMask: words[8],
    otaState: words[9],
    expectedSequence: words[10],
    declaredSize: words[11],
    acceptedSize: words[12],
    templeTxCount: words[13],
    templeRxCount: words[14],
    templeUartErrors: words[15],
    baseline: bytes.slice(64, 74),
    selected: bytes.slice(74, 84),
    restored: bytes.slice(84, 94),
    hostTxRecoveries: words[24],
    hostTxAborts: words[25],
    hostTxLastIsr: words[26],
    hostRxTimeouts: words[27],
    hostRxErrors: words[28],
    hostTcTimeouts: words[29],
    hostStage: words[30],
    hostChunkOffset: words[31],
  };
}

export function verifyPogoFlashZeroWriteSetupStop(
  result,
  proof,
  attemptedRoute,
  yhmProfile = YHM_PROFILE_REVIEWED_22,
) {
  requireYhmProfile(yhmProfile);
  const proofBytes = asBytes(proof);
  if (
    !["left", "right"].includes(attemptedRoute) ||
    !equalBytes(proofBytes, POGO_FLASH_PROOF)
  ) {
    return null;
  }
  let report;
  try {
    report = decodePogoFlashRetainedResult(result);
  } catch {
    return null;
  }
  const baselineHex = [...report.baseline]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const zeroBytes = (bytes) => bytes.every((value) => value === 0);
  if (
    report.magic !== 0x57463247 ||
    report.progress !== 3 ||
    report.routeValue !== (attemptedRoute === "left" ? 0 : 1) ||
    report.sequenceValue !== 0x42 ||
    report.status !== 3 ||
    report.baselineMask !== 0x3ff ||
    report.selectedMask !== 0 ||
    report.restoredMask !== 0 ||
    report.writeMask !== 0 ||
    report.otaState !== 0 ||
    report.expectedSequence !== 0 ||
    report.declaredSize !== 0 ||
    report.acceptedSize !== 0 ||
    report.templeTxCount !== 0 ||
    report.templeRxCount !== 0 ||
    report.templeUartErrors !== 0 ||
    !zeroBytes(report.selected) ||
    !zeroBytes(report.restored)
  ) {
    return null;
  }
  const baselineProfile = identifyYhmBaselineProfile(baselineHex);
  const baselineAllowlisted = isYhmBaselineAllowed(
    yhmProfile,
    baselineHex,
  );
  const phaseCompatibleRoute = baselineAllowlisted
    ? report.baseline[1] & 1
      ? "right"
      : "left"
    : null;
  return {
    ...report,
    baselineHex,
    baselineProfile,
    baselineAllowlisted,
    yhmProfile,
    phaseCompatibleRoute,
    noMutationSetupStopVerified: true,
  };
}

export function verifyPogoFlashOppositePhaseStop(
  result,
  proof,
  attemptedRoute,
  yhmProfile = YHM_PROFILE_REVIEWED_22,
) {
  const report = verifyPogoFlashZeroWriteSetupStop(
    result,
    proof,
    attemptedRoute,
    yhmProfile,
  );
  if (
    !report?.baselineAllowlisted ||
    report.phaseCompatibleRoute === attemptedRoute
  ) {
    return null;
  }
  return {
    ...report,
    noMutationPhaseStopVerified: true,
  };
}

export function verifyPogoFlashHostTimeoutRestoration(
  result,
  proof,
  attemptedRoute,
  yhmProfile = YHM_PROFILE_REVIEWED_22,
) {
  requireYhmProfile(yhmProfile);
  const proofBytes = asBytes(proof);
  if (
    !["left", "right"].includes(attemptedRoute) ||
    !equalBytes(proofBytes, POGO_FLASH_PROOF)
  ) {
    return null;
  }
  let report;
  try {
    report = decodePogoFlashRetainedResult(result);
  } catch {
    return null;
  }
  const baselineHex = [...report.baseline]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (
    report.magic !== 0x57463247 ||
    report.progress !== 3 ||
    report.routeValue !== (attemptedRoute === "left" ? 0 : 1) ||
    report.route !== attemptedRoute ||
    report.status !== 16 ||
    report.baselineMask !== 0x3ff ||
    report.selectedMask !== 0x3ff ||
    report.restoredMask !== 0x3ff ||
    report.templeUartErrors !== 0 ||
    !isYhmBaselineAllowed(yhmProfile, baselineHex) ||
    !equalBytes(report.baseline, report.restored)
  ) {
    return null;
  }
  return {
    ...report,
    yhmProfile,
    hostTimeoutRestorationVerified: true,
  };
}

export function parsePogoFlashRetainedResult(
  result,
  proof,
  route,
  finalSequence,
  {
    expectedAcceptedSize = null,
    expectedOtaSequence = null,
    yhmProfile = YHM_PROFILE_REVIEWED_22,
  } = {},
) {
  requireYhmProfile(yhmProfile);
  const proofBytes = asBytes(proof);
  if (!equalBytes(proofBytes, POGO_FLASH_PROOF)) {
    throw new PogoFlashSafetyError("The volatile flash bridge proof is invalid.");
  }
  const report = decodePogoFlashRetainedResult(result);
  const baselineHex = [...report.baseline]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (
    report.magic !== 0x57463247 ||
    report.progress !== 3 ||
    report.routeValue !== (route === "left" ? 0 : 1) ||
    report.route !== route ||
    report.sequenceValue !== finalSequence ||
    report.sequence !== finalSequence ||
    report.status !== 0 ||
    report.baselineMask !== 0x3ff ||
    report.selectedMask !== 0x3ff ||
    report.restoredMask !== 0x3ff ||
    report.templeUartErrors !== 0 ||
    !isYhmBaselineAllowed(yhmProfile, baselineHex) ||
    (expectedAcceptedSize !== null &&
      (report.declaredSize !== expectedAcceptedSize ||
        report.acceptedSize !== expectedAcceptedSize)) ||
    (expectedOtaSequence !== null &&
      report.expectedSequence !== expectedOtaSequence) ||
    !equalBytes(report.baseline, report.restored)
  ) {
    throw new PogoFlashSafetyError(
      "The retained bridge result does not prove a complete byte-for-byte route restoration.",
    );
  }
  return { ...report, yhmProfile };
}

export async function assertPinnedTempleFlashCandidate(firmware) {
  // The bundle digest only selects which pin to check against; every field
  // below is still verified, and the payload is re-hashed here rather than
  // trusting the digest the parser reported.
  const target =
    firmware?.kind === "bundle" ? findTempleFlashTarget(firmware.fileSha256) : null;
  const observedMainSha256 = firmware?.mainComponent?.payload
    ? await sha256Hex(firmware.mainComponent.payload)
    : null;
  if (
    !target ||
    firmware.mainComponent?.name !== "ota/s200_firmware_ota.bin" ||
    firmware.mainComponent?.typeId !== 0 ||
    firmware.mainComponent?.header?.length !== 128 ||
    firmware.mainComponent?.payload?.length !== target.mainBytes ||
    firmware.mainComponent?.payloadSha256 !== target.mainSha256 ||
    observedMainSha256 !== target.mainSha256 ||
    firmware.g2Version !== target.version
  ) {
    throw new PogoFlashSafetyError(
      "Temple flashing accepts only a pinned Apollo-main component from the verified firmware library.",
    );
  }
  return { mainComponent: firmware.mainComponent, target };
}

/** @deprecated Retained so the reviewed-CFW pin stays independently asserted. */
export async function assertReviewedCfwFlashCandidate(firmware) {
  const { mainComponent } = await assertPinnedTempleFlashCandidate(firmware);
  if (
    firmware.fileSha256 !== REVIEWED_CFW_IMAGE_SHA256 ||
    mainComponent.payload.length !== REVIEWED_CFW_MAIN_BYTES ||
    mainComponent.payloadSha256 !== REVIEWED_CFW_MAIN_SHA256 ||
    firmware.g2Version !== REVIEWED_CFW_VERSION
  ) {
    throw new PogoFlashSafetyError(
      "Temple flashing accepts only the exact reviewed 2.2.6.11 CFW Apollo-main component.",
    );
  }
  return mainComponent;
}

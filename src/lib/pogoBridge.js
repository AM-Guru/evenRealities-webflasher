import { equalBytes, hexBytes, readU32LE, sha256Hex } from "./firmware.js";
import {
  YHM_PROFILE_OBSERVED_33,
  YHM_PROFILE_OBSERVED_45,
  YHM_PROFILE_REVIEWED_22,
  requireYhmProfile,
  yhmProfileRegister8,
} from "./yhmProfiles.js";

export const POGO_BRIDGE_ADDRESS = 0x20010000;
export const POGO_BRIDGE_RESULT_ADDRESS = 0x20011a00;
export const POGO_BRIDGE_RESULT_LENGTH = 160;
export const POGO_BRIDGE_PROOF_ADDRESS = 0x20011b00;
export const POGO_BRIDGE_SHA256 =
  "e30e143d522e5a5d0b10a92a15610badcc6aef014333716a94eae183b14dc258";
export const POGO_BRIDGE_OBSERVED_33_SHA256 =
  "3ca8ed1d8d37b2edef62dcb6915b5ec4b1d439160da0a89e93aa74901d760ef6";
export const POGO_BRIDGE_OBSERVED_45_SHA256 =
  "1a4cde093bc804e1b7e176229b0af346b0423c3a1d85fc5c908f1e38233ed45c";
// Regression pins for register-8 values already exercised end-to-end. Any
// other observed profile is verified by construction instead: the reviewed
// payload's pin is checked first, and the derivation touches only the four
// baseline-table register-8 offsets.
export const POGO_BRIDGE_PROFILE_SHA256 = Object.freeze({
  [YHM_PROFILE_REVIEWED_22]: POGO_BRIDGE_SHA256,
  [YHM_PROFILE_OBSERVED_33]: POGO_BRIDGE_OBSERVED_33_SHA256,
  [YHM_PROFILE_OBSERVED_45]: POGO_BRIDGE_OBSERVED_45_SHA256,
});
export const POGO_BRIDGE_BANNER = new TextEncoder().encode("G2_POGO_BRIDGE_V1\n");
export const POGO_BRIDGE_PROOF = new Uint8Array([
  0x47, 0x42, 0x52, 0x50, 0xde, 0xc0, 0xde, 0xc0,
]);

const POGO_BRIDGE_BASE64 = `
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
`;

const POGO_BRIDGE_PROFILE_PATCH_OFFSETS = Object.freeze([
  1670, 1680, 1690, 1700,
]);

export const POGO_BRIDGE_STATUS = Object.freeze({
  0: "ok",
  1: "bad host request",
  2: "operation or route rejected",
  3: "YHM baseline was not an allowlisted seated-idle state",
  4: "YHM route selection failed",
  5: "temple request transmission failed",
  6: "no framed temple response",
  7: "YHM baseline restoration failed",
  16: "host request timeout",
});

function decodeBase64(value) {
  const binary = globalThis.atob(value.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function getVerifiedPogoBridgePayload(
  profile = YHM_PROFILE_REVIEWED_22,
) {
  requireYhmProfile(profile);
  const reviewedPayload = decodeBase64(POGO_BRIDGE_BASE64);
  if (reviewedPayload.length !== 1720 || reviewedPayload.length % 4 !== 0) {
    throw new Error("The pinned pogo bridge payload has an unexpected size.");
  }
  const reviewedDigest = await sha256Hex(reviewedPayload);
  if (reviewedDigest !== POGO_BRIDGE_SHA256) {
    throw new Error("The pinned pogo bridge payload failed its SHA-256 check.");
  }
  if (profile === YHM_PROFILE_REVIEWED_22) return reviewedPayload;

  const payload = reviewedPayload.slice();
  for (const offset of POGO_BRIDGE_PROFILE_PATCH_OFFSETS) {
    if (payload[offset] !== 0x22) {
      throw new Error(
        "The pinned pogo bridge YHM profile table differs from the reviewed layout.",
      );
    }
    payload[offset] = yhmProfileRegister8(profile);
  }
  const digest = await sha256Hex(payload);
  const regressionPin = POGO_BRIDGE_PROFILE_SHA256[profile];
  if (regressionPin && digest !== regressionPin) {
    throw new Error(
      `The pinned ${profile} pogo bridge failed its SHA-256 check.`,
    );
  }
  return payload;
}

export function makePogoBridgeRequest(operation, route, sequence = 0x42) {
  const operationValue = { status: 1, version: 2, exit: 0x7f }[operation];
  const routeValue = { left: 0, right: 1 }[route];
  if (operationValue == null || routeValue == null) {
    throw new Error("Unsupported pogo bridge operation or route.");
  }
  if (operation === "exit" && route !== "left") {
    throw new Error("The no-contact bridge exit self-test uses the left route field.");
  }
  const request = new Uint8Array([
    0x47, 0x32, 0x52, 0x51,
    1,
    operationValue,
    routeValue,
    sequence,
    0,
    0,
  ]);
  request[9] = request.subarray(0, 9).reduce((sum, value) => sum + value, 0) & 0xff;
  return request;
}

export function parsePogoBridgeResponse(header, tail, request) {
  const response = new Uint8Array(header.length + tail.length);
  response.set(header);
  response.set(tail, header.length);
  if (
    header.length !== 12 ||
    header[0] !== 0x47 ||
    header[1] !== 0x32 ||
    header[2] !== 0x52 ||
    header[3] !== 0x53 ||
    header[4] !== 1
  ) {
    throw new Error(`Invalid pogo bridge response header: ${hexBytes(header)}`);
  }
  const capturedLength = header[9];
  if (capturedLength > 64 || tail.length !== capturedLength + 1) {
    throw new Error("The pogo bridge returned an invalid capture length.");
  }
  const checksum = response.subarray(0, -1).reduce((sum, value) => sum + value, 0) & 0xff;
  if (response.at(-1) !== checksum) {
    throw new Error("The pogo bridge response checksum is invalid.");
  }
  if (
    request &&
    (response[5] !== request[5] ||
      response[6] !== request[6] ||
      response[7] !== request[7])
  ) {
    throw new Error("The pogo bridge response does not echo the host request.");
  }
  return {
    raw: response,
    operation: response[5],
    route: response[6],
    sequence: response[7],
    status: response[8],
    statusLabel: POGO_BRIDGE_STATUS[response[8]] ?? "unknown bridge status",
    uartErrorMask: response[10],
    captured: response.slice(12, 12 + capturedLength),
  };
}

export function parseTempleFrame(frame, operation) {
  if (
    frame.length < 5 ||
    frame[0] !== 0x5a ||
    frame[1] !== 0xa5 ||
    frame[2] !== 0xff
  ) {
    throw new Error("The temple response is not a 5A A5 FF frame.");
  }
  if (frame.length !== frame[3] + 5) {
    throw new Error("The temple response length does not match its declaration.");
  }
  const checksum = frame.subarray(0, -1).reduce((sum, value) => sum + value, 0) & 0xff;
  if (frame.at(-1) !== checksum) {
    throw new Error("The temple response additive checksum is invalid.");
  }
  if (operation === "status") {
    if (frame.length !== 15 || frame[4] !== 0x13) {
      throw new Error("The temple did not return the expected status response.");
    }
    return {
      kind: "status",
      statusFlag: frame[8],
      voltageMv: (frame[9] << 8) | frame[10],
      batteryPercent: frame[11],
      currentNonpositive: frame[12] !== 0,
      currentMagnitude: frame[13],
    };
  }
  if (operation === "version") {
    if (frame.length !== 14 || frame[4] !== 0x24) {
      throw new Error("The temple did not return the expected version response.");
    }
    return {
      kind: "version",
      firmwareVersion: `${frame[8]}.${frame[9]}.${frame[10]}.${frame[11]}`,
      hardwareRevision: frame[12],
    };
  }
  throw new Error("Only status and version temple frames are accepted.");
}

export function validatePogoBridgeRetainedResult(
  result,
  response,
  operation,
  route,
) {
  if (
    result.length !== POGO_BRIDGE_RESULT_LENGTH ||
    result[0] !== 0x47 ||
    result[1] !== 0x42 ||
    result[2] !== 0x52 ||
    result[3] !== 0x47
  ) {
    throw new Error("The retained pogo bridge result magic is invalid.");
  }
  const words = [];
  for (let offset = 4; offset < 56; offset += 4) {
    words.push(readU32LE(result, offset));
  }
  const [
    progress,
    retainedOperation,
    retainedRoute,
    sequence,
    status,
    baselineMask,
    selectedMask,
    restoredMask,
    writeMask,
    transmitted,
    total,
    stored,
    errors,
  ] = words;
  const expectedOperation = { status: 1, version: 2 }[operation];
  const expectedRoute = { left: 0, right: 1 }[route];
  if (progress !== 2) throw new Error("The retained pogo bridge run is incomplete.");
  if (retainedOperation !== expectedOperation || retainedRoute !== expectedRoute) {
    throw new Error("The retained pogo bridge operation or route differs.");
  }
  if (
    sequence !== response.sequence ||
    status !== response.status ||
    errors !== response.uartErrorMask
  ) {
    throw new Error("The retained pogo bridge result differs from its USB response.");
  }
  if (stored > 64) throw new Error("The retained pogo capture length is invalid.");
  if (!equalBytes(result.subarray(86, 86 + stored), response.captured)) {
    throw new Error("The retained temple bytes differ from the USB response.");
  }

  if (status === 0) {
    const expectedTransmitted = operation === "status" ? 7 : 5;
    if (
      baselineMask !== 0x3ff ||
      selectedMask !== 0x3ff ||
      restoredMask !== 0x3ff ||
      writeMask !== 0x1ff ||
      transmitted !== expectedTransmitted ||
      total !== stored ||
      errors !== 0 ||
      !equalBytes(result.subarray(56, 66), result.subarray(76, 86))
    ) {
      throw new Error("The retained pogo transport or YHM restoration proof failed.");
    }
  }
  const baseline = result.slice(56, 66);
  const zeroBytes = (bytes) => bytes.every((value) => value === 0);
  const zeroWriteBaselineStopVerified =
    status === 3 &&
    baselineMask === 0x3ff &&
    selectedMask === 0 &&
    restoredMask === 0 &&
    writeMask === 0 &&
    transmitted === 0 &&
    total === 0 &&
    stored === 0 &&
    errors === 0 &&
    zeroBytes(result.subarray(66, 76)) &&
    zeroBytes(result.subarray(76, 86));
  if (status === 3 && !zeroWriteBaselineStopVerified) {
    throw new Error(
      "The retained YHM baseline stop does not prove a zero-write, zero-transmission exit.",
    );
  }
  return {
    baselineMask,
    selectedMask,
    restoredMask,
    writeMask,
    transmitted,
    stored,
    errors,
    baseline,
    baselineHex: hexBytes(baseline, "").toLowerCase(),
    zeroWriteBaselineStopVerified,
  };
}

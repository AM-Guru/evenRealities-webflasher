import {
  BANK_SIZE,
  FLASH_BASE,
  FLASH_PAGE_SIZE,
  FLASH_SIZE,
  OPTION_BASE,
  OPTION_SIZE,
  decodeOptionBytes,
  detectCaseVersion,
  equalBytes,
  isPlausibleCaseImage,
  parseConsoleReport,
  sha256Hex,
  toggledBankOptionBytes,
} from "./firmware.js";
import { caseDeviceKey } from "./deviceIdentity.js";
import {
  POGO_BRIDGE_ADDRESS,
  POGO_BRIDGE_BANNER,
  POGO_BRIDGE_PROOF,
  POGO_BRIDGE_PROOF_ADDRESS,
  POGO_BRIDGE_PROFILE_SHA256,
  POGO_BRIDGE_RESULT_ADDRESS,
  POGO_BRIDGE_RESULT_LENGTH,
  POGO_BRIDGE_SHA256,
  POGO_BRIDGE_STATUS,
  getVerifiedPogoBridgePayload,
  makePogoBridgeRequest,
  parsePogoBridgeResponse,
  parseTempleFrame,
  validatePogoBridgeRetainedResult,
} from "./pogoBridge.js";
import {
  POGO_FLASH_BRIDGE_ADDRESS,
  POGO_FLASH_BRIDGE_BANNER,
  POGO_FLASH_BRIDGE_PROFILE_SHA256,
  POGO_FLASH_BRIDGE_SHA256,
  POGO_FLASH_PROOF,
  POGO_FLASH_PROOF_ADDRESS,
  POGO_FLASH_RESULT_ADDRESS,
  POGO_FLASH_RESULT_LENGTH,
  POGO_FLASH_STATUS,
  REVIEWED_CASE_VERSION,
  RetryablePogoFlashError,
  TempleRejectedError,
  PogoFlashSafetyError,
  assertPinnedTempleFlashCandidate,
  classifyPogoFlashRecoveryBoundary,
  decodePogoFlashRetainedResult,
  decodeTempleVersion,
  getVerifiedPogoFlashBridgePayload,
  makeOtaDataRequest,
  makeOtaFinishRequest,
  makeOtaHeaderRequest,
  makeOtaStartRequest,
  makePogoFlashHostStressHeader,
  makePogoFlashSetup,
  makePogoFlashTransactionHeader,
  makeTempleVersionRequest,
  parsePogoFlashReady,
  parsePogoFlashResponse,
  parsePogoFlashRetainedResult,
  requireOtaAcknowledgement,
  verifyPogoFlashHostTimeoutRestoration,
  verifyPogoFlashOppositePhaseStop,
  verifyPogoFlashZeroWriteSetupStop,
} from "./pogoFlashBridge.js";
import { buildBundleDifferencePlan } from "./differential.js";

function encodeRemoteBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
import {
  YHM_PROFILE_OBSERVED_33,
  YHM_PROFILE_OBSERVED_45,
  YHM_PROFILE_REVIEWED_22,
  identifyYhmBaselineProfile,
  requireYhmProfile,
} from "./yhmProfiles.js";
import {
  isG2CaseUsbDevice,
  requestG2CaseUsbPort,
  webUsbSupported,
} from "./webusb.js";

const ACK = 0x79;
const NACK = 0x1f;
const SYNC = 0x7f;
const GET = 0x00;
const GET_ID = 0x02;
const READ_MEMORY = 0x11;
const GO = 0x21;
const WRITE_MEMORY = 0x31;
const EXTENDED_ERASE = 0x44;
const INACTIVE_ALIAS = FLASH_BASE + BANK_SIZE;
const REVIEWED_CASE_ROM_COMMANDS = Object.freeze([
  0x00, 0x01, 0x02, READ_MEMORY, GO, WRITE_MEMORY, EXTENDED_ERASE,
  0x63, 0x73, 0x82, 0x92,
]);
// Repeated read-only probes consumed the same short app-mode route needed by
// START on hardware. One checksum-valid version query is the just-in-time
// liveness gate; it is not a multi-query stability claim.
const POGO_STABILITY_READ_QUERIES = 1;
const POGO_STABILITY_INTERVAL_MS = 25;
const POGO_DEFERRED_BATCH_BYTES = 6000;
const POGO_SERIALIZED_BATCH_BYTES = 1000;
const POGO_DATA_BATCH_SETTLE_MS = 1000;
const POGO_DATA_LATE_BATCH_SETTLE_MS = 2000;
const POGO_DATA_FINAL_SETTLE_MS = 15000;
const POGO_MAXIMUM_DEFERRED_EARLY_SETTLE_MS = 8000;
const POGO_MAXIMUM_DEFERRED_LATE_SETTLE_MS = 12000;
const POGO_DATA_LATE_SETTLE_NUMERATOR = 3;
const POGO_DATA_LATE_SETTLE_DENOMINATOR = 4;
// Whole-component restart budget after a DATA failure with exact cleanup
// proof. Pacing escalates across the budget: the first attempt runs at the
// remembered level, every intermediate restart at tier 2, and the final
// restart at maximum pacing (templeDataPacingMultiplierForRestart). Raising
// this widens the tier-2 band rather than changing where maximum pacing
// lands, so a marginal link gets more conservative attempts before the run
// gives up. Exported so the escalation spec is asserted against the budget
// instead of a hardcoded attempt number.
export const POGO_COMPONENT_RESTART_LIMIT = 4;
// A verified host-timeout restoration is a cleaner failure than a plain DATA
// rejection, so it gets a wider budget than POGO_COMPONENT_RESTART_LIMIT.
export const POGO_HOST_TIMEOUT_COMPONENT_RESTART_LIMIT = 6;
const POGO_PERSISTENT_REJECTION_WINDOW_RECORDS = 64;
const POGO_BILATERAL_ROUTE_ADAPTATION_LIMIT = 4;
const POGO_SETUP_RESET_LIMIT = 2;
// A temple can accept and commit an image (FINISH acknowledged) yet keep
// reporting the previous version until a later reset. Measured on hardware
// across a full postflight window plus an intervening analysis.
const POGO_ACTIVATION_RESET_ATTEMPTS = 2;
const POGO_INTERMEDIATE_RESET_ATTEMPTS = 2;
const POGO_FINAL_RESET_ATTEMPTS = 2;
// After a B0/DEB0 reset the seated temples renegotiate charging with the
// Case, and the pogo route can stay non-idle (status 3) or silent (status 6)
// for on the order of ten minutes on hardware. The ladder must outlast that
// window; resets do not shorten it — they restart it.
export const POGO_READ_ONLY_PHASE_SETTLE_MS = Object.freeze([
  15_000, 45_000, 90_000, 180_000, 300_000,
]);
// The 15 s opening rung is right for the read-only version path — measured
// clearing a post-reset route on hardware — but measurably too short for the
// writer's zero-write setup stop. On 2026-07-28 the writer hit the 15 s rung
// twice on a temple at 100 % battery and cleared only on 45 s, so the opening
// rung cost a wasted setup round trip on every run. The writer starts one rung
// in; the ladder itself is unchanged for every other caller.
export const POGO_SETUP_STOP_FIRST_SETTLE_INDEX = 1;
// How long a temple gets to restart onto a committed image before the run
// falls through to the bounded activation-reset path, and how often that wait
// is narrated. Measured: a temple can run this whole window still reporting
// the previous version and then activate on the first activation reset.
const POGO_POSTFLIGHT_WINDOW_MS = 180_000;
const POGO_POSTFLIGHT_HEARTBEAT_MS = 15_000;
export const WEB_SERIAL_ROM_READ_SIZE = 31;
const ROM_ENTRY_ATTEMPTS = 3;

// The CH340 packet boundary is a property of this host's USB serial stack,
// not of one loader session. Remember the first detection so later ROM
// sessions start at the working read size instead of rediscovering the
// boundary with a failed large read plus an extra loader re-entry each time.
let webSerialRomPacketBoundaryObserved = false;

export function hasObservedWebSerialRomPacketBoundary() {
  return webSerialRomPacketBoundaryObserved;
}

export function noteWebSerialRomPacketBoundaryObserved() {
  webSerialRomPacketBoundaryObserved = true;
}

// Hardware sessions on macOS have shown bursts of truncated CH340 reads
// through the Web Serial driver stack; the direct WebUSB transport bypasses
// that driver entirely. After enough retries in one page lifetime, surface
// the alternative once instead of letting the user wonder about the churn.
const WEB_SERIAL_SHORT_READ_HINT_THRESHOLD = 12;
let webSerialShortReadRetryCount = 0;
let webSerialShortReadHintLogged = false;

export function noteWebSerialShortReadRetry(port, log) {
  if (port?.transportKind === "webusb" || port?.transportKind === "remote") {
    return;
  }
  webSerialShortReadRetryCount += 1;
  if (
    webSerialShortReadRetryCount >= WEB_SERIAL_SHORT_READ_HINT_THRESHOLD &&
    !webSerialShortReadHintLogged
  ) {
    webSerialShortReadHintLogged = true;
    log?.(
      `This host has truncated ${webSerialShortReadRetryCount} CH340 reads over Web Serial this session; every one was recovered by a bounded retry. The direct WebUSB transport in Connect bypasses the host serial driver and may be more reliable here.`,
      "warn",
    );
  }
}

export function isExplicitTempleDataRejection(error) {
  return error instanceof TempleRejectedError;
}

// In-place DATA record recovery. Every audited case-bridge failure shares one
// signature: hostChunkOffset 1009 (the full record left the host), zero host
// and temple UART error counters, and acceptedSize frozen at exactly
// expectedSequence × 1000 — the record vanished between the Case's pogo TX
// and the temple's OTA parser without so much as a framing error, during a
// charge-management window in which the route is silent (the same silence the
// post-reset ladder documents at status 6). The record was therefore never
// accepted, and resending the identical bytes with the identical sequence
// byte is protocol-correct: the temple's own sequence guard accepts the
// record it is waiting for, rejects a duplicate of one it already committed
// with status 1, and rejects anything desynchronized. Recovery is bounded per
// record and per component attempt, and a transient never touches pacing
// memory (it is not evidence the temple was overrun).
export const POGO_DATA_INPLACE_RESEND_LIMIT = 3;
export const POGO_DATA_INPLACE_RECOVERY_BUDGET = 12;
export const POGO_DATA_INPLACE_SETTLE_MS = Object.freeze([
  2_000, 8_000, 20_000,
]);

export function classifyInPlaceDataRecovery(
  error,
  { resendsForRecord, recoveriesThisAttempt },
) {
  if (
    !Number.isInteger(resendsForRecord) ||
    resendsForRecord < 0 ||
    !Number.isInteger(recoveriesThisAttempt) ||
    recoveriesThisAttempt < 0
  ) {
    throw new Error("In-place recovery counters must be nonnegative integers.");
  }
  if (isExplicitTempleDataRejection(error)) {
    // A status-1 rejection of a RESEND is the lost-ACK disambiguation: the
    // temple committed the record, advanced its expected sequence, and its
    // guard refused the duplicate. Advance to the next record. If this read
    // is wrong — a genuine desynchronization — the next record is rejected
    // with a zero resend count and aborts through the normal path. A
    // first-transmission rejection is real temple evidence and always aborts.
    if (resendsForRecord > 0 && error.status === 1) {
      return { action: "advance" };
    }
    return { action: "abort" };
  }
  if (
    resendsForRecord >= POGO_DATA_INPLACE_RESEND_LIMIT ||
    recoveriesThisAttempt >= POGO_DATA_INPLACE_RECOVERY_BUDGET
  ) {
    return { action: "abort" };
  }
  return {
    action: "resend",
    settleMs:
      POGO_DATA_INPLACE_SETTLE_MS[
        Math.min(resendsForRecord, POGO_DATA_INPLACE_SETTLE_MS.length - 1)
      ],
  };
}

export function isPogoRoutePhaseMismatch(error) {
  return Boolean(
    error instanceof PogoFlashSafetyError &&
      error.message.includes(
        "YHM baseline is not an allowlisted seated-idle state",
      ),
  );
}

export function isRetryablePostResetLivenessFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    // Transient transport faults during the read-only reset/liveness sequence
    // are as recoverable as a missing telemetry line: the bounded second
    // DEB0 replays the whole traced sequence from a fresh port.
    message.includes("Failed to open serial port") ||
    message.includes("CH340 bulk") ||
    message.includes("no framed temple response") ||
    message.includes("YHM baseline was not an allowlisted seated-idle state") ||
    message.includes("contact did not return after the final B0 reset") ||
    message.includes("Fresh Case telemetry did not return") ||
    message.includes("fresh GLS_L/GLS_R telemetry was not observed") ||
    message.includes("normal B200 application banner was not observed") ||
    message.includes(
      "Case did not confirm the traced B0 left/right temple reset command",
    )
  );
}

export function templeDataSettleMilliseconds(acceptedBytes, totalBytes) {
  if (
    !Number.isInteger(acceptedBytes) ||
    !Number.isInteger(totalBytes) ||
    acceptedBytes < 0 ||
    totalBytes < 1 ||
    acceptedBytes > totalBytes
  ) {
    throw new Error("Temple DATA pacing requires valid accepted and total byte counts.");
  }
  const final = acceptedBytes === totalBytes;
  if (!final && acceptedBytes % POGO_DEFERRED_BATCH_BYTES !== 0) return 0;
  if (final) return POGO_DATA_FINAL_SETTLE_MS;
  const lateTransfer =
    acceptedBytes * POGO_DATA_LATE_SETTLE_DENOMINATOR >=
    totalBytes * POGO_DATA_LATE_SETTLE_NUMERATOR;
  return lateTransfer
    ? POGO_DATA_LATE_BATCH_SETTLE_MS
    : POGO_DATA_BATCH_SETTLE_MS;
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Adaptive DATA pacing, calibrated on hardware 2026-07-27.
//
// The fixed 1 s/2 s batch settles (level 3) cost ~12 minutes per temple. Four
// temple transfers at level 3 completed with zero DATA rejections, so it is
// the proven baseline. Level 0 (no early settle) was measured across three
// attempts and produced two explicit 0x54 rejections — at 76% of one transfer
// and at 25% of another — so a near-zero settle is genuinely unsafe on this
// hardware, in both transfer phases.
//
// The same runs disproved the original congestion model: ACK latency stayed
// flat (mean 230 ms) right up to both rejections and never triggered a single
// backoff. The temple does not slow its ACKs before refusing a record, so
// within-run latency adaptation has no leading signal and easing down mid-run
// is unjustified — it also silently undid the escalation a restart had just
// applied. Latency escalation is retained only as a sticky safety net.
//
// The signal that does exist is per-run and unambiguous: did the component
// finish without a rejection? Optimization therefore lives across runs — a
// level is adopted only after repeated clean runs, and any rejection returns
// pacing to the proven baseline.
export const TEMPLE_DATA_PACING_LEVELS = Object.freeze([
  Object.freeze({ early: 0, late: 250, batchBytes: POGO_DEFERRED_BATCH_BYTES }),
  Object.freeze({
    early: 250,
    late: 500,
    batchBytes: POGO_DEFERRED_BATCH_BYTES,
  }),
  Object.freeze({
    early: 500,
    late: 1000,
    batchBytes: POGO_DEFERRED_BATCH_BYTES,
  }),
  Object.freeze({
    early: 1000,
    late: 2000,
    batchBytes: POGO_DEFERRED_BATCH_BYTES,
  }),
  Object.freeze({
    early: 2000,
    late: 4000,
    batchBytes: POGO_DEFERRED_BATCH_BYTES,
  }),
  // Build e8110e4 rejected record 800 two records after the 798 KiB deferred
  // storage boundary, with zero UART errors, after a three-second boundary
  // settle. Build 449b15c then rejected record 542 two records after the
  // 540 KiB boundary after serializing every record but granting the boundary
  // itself only one second. The receiver queues its actual storage work only
  // at six-record boundaries, so maximum pacing must preserve both properties:
  // serialize ordinary records and grant the real deferred commit an
  // uninterrupted, separately conservative window.
  Object.freeze({
    early: 1000,
    late: 2000,
    batchBytes: POGO_SERIALIZED_BATCH_BYTES,
    deferredEarly: POGO_MAXIMUM_DEFERRED_EARLY_SETTLE_MS,
    deferredLate: POGO_MAXIMUM_DEFERRED_LATE_SETTLE_MS,
  }),
]);
export const TEMPLE_DATA_PACING_STOCK_LEVEL = 3;
// Level 0 rejected 2 of 3 measured attempts; never select it automatically.
export const TEMPLE_DATA_PACING_MIN_AUTOMATIC_LEVEL = 1;
export const TEMPLE_DATA_PACING_DEFAULT_START_LEVEL = 2;
// Consecutive clean components required before probing one level faster.
export const TEMPLE_DATA_PACING_PROBE_STREAK = 2;
const PACING_CONGESTION_ABSOLUTE_MS = 1500;
const PACING_CONGESTION_BASELINE_FACTOR = 4;
const PACING_BASELINE_WARMUP_RECORDS = 24;
const PACING_CHANGE_COOLDOWN_RECORDS = 60;
const PACING_CONGESTION_EVENT_LOG_LIMIT = 20;
// Pacing is remembered per temple, per Case. Hardware measurement forced this:
// on one device the right temple carried 2,695 records with no settle at all
// while the left rejected at record 866 under the same setting, and later
// rejected again at the most conservative level. A single shared level is the
// wrong model — it slows a good route to protect a bad one, and speeds a bad
// route because a good one succeeded. Keying by Case as well keeps one unit's
// characteristics from being applied to another.
const PACING_MEMORY_KEY = "g2wf.temple-data-pacing.v3";
const PACING_UNKNOWN_DEVICE_KEY = "unidentified-case";

function clampAutomaticLevel(level) {
  return Math.min(
    Math.max(level, TEMPLE_DATA_PACING_MIN_AUTOMATIC_LEVEL),
    TEMPLE_DATA_PACING_LEVELS.length - 1,
  );
}

function readPacingStore() {
  try {
    const parsed = JSON.parse(
      globalThis.localStorage?.getItem(PACING_MEMORY_KEY) ?? "null",
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readTempleDataPacingMemory(
  deviceKey = PACING_UNKNOWN_DEVICE_KEY,
  route = "both",
) {
  const stored = readPacingStore()?.[deviceKey]?.[route];
  if (
    Number.isInteger(stored?.level) &&
    Number.isInteger(stored?.cleanStreak) &&
    stored.cleanStreak >= 0
  ) {
    return {
      level: clampAutomaticLevel(stored.level),
      cleanStreak: stored.cleanStreak,
    };
  }
  return {
    level: TEMPLE_DATA_PACING_DEFAULT_START_LEVEL,
    cleanStreak: 0,
  };
}

export function writeTempleDataPacingMemory(
  memory,
  deviceKey = PACING_UNKNOWN_DEVICE_KEY,
  route = "both",
) {
  try {
    const store = readPacingStore();
    store[deviceKey] = { ...(store[deviceKey] ?? {}), [route]: memory };
    globalThis.localStorage?.setItem(PACING_MEMORY_KEY, JSON.stringify(store));
  } catch {
    // Memory is an optimization, never a gate.
  }
}

// Given the memory before a component and how that component ended, return
// the memory to carry forward.
export function nextTempleDataPacingMemory(memory, outcome, levelUsed) {
  const level = clampAutomaticLevel(levelUsed ?? memory.level);
  if (outcome !== "clean") {
    return {
      level: clampAutomaticLevel(
        Math.max(level + 1, TEMPLE_DATA_PACING_STOCK_LEVEL),
      ),
      cleanStreak: 0,
    };
  }
  const cleanStreak = memory.cleanStreak + 1;
  if (
    cleanStreak >= TEMPLE_DATA_PACING_PROBE_STREAK &&
    level > TEMPLE_DATA_PACING_MIN_AUTOMATIC_LEVEL
  ) {
    return { level: clampAutomaticLevel(level - 1), cleanStreak: 0 };
  }
  return { level, cleanStreak };
}

const YHM_ROUTE_PROFILE_MEMORY_KEY = "g2wf.yhm-route-profiles.v1";
const YHM_ROUTE_PROFILE_MEMORY_LIMIT = 32;

// Last-proven YHM bridge profile per case serial and route. A repeat support
// session for the same case then starts from the profile its temples actually
// idle in, instead of walking the reviewed-22 settle ladder again. Memory is
// an optimization, never a gate: it only reorders which separately pinned
// bridge is tried first.
export function readYhmRouteProfileMemory(serialNumber) {
  const remembered = {};
  try {
    const parsed = JSON.parse(
      globalThis.localStorage?.getItem(YHM_ROUTE_PROFILE_MEMORY_KEY) ?? "null",
    );
    for (const route of ["left", "right"]) {
      const profile = parsed?.[serialNumber]?.[route];
      if (typeof profile !== "string") continue;
      try {
        requireYhmProfile(profile);
      } catch {
        continue;
      }
      remembered[route] = profile;
    }
  } catch {
    // Storage may be unavailable or hold an older shape; start fresh.
  }
  return remembered;
}

export function writeYhmRouteProfileMemory(serialNumber, route, profile) {
  try {
    const parsed = JSON.parse(
      globalThis.localStorage?.getItem(YHM_ROUTE_PROFILE_MEMORY_KEY) ?? "null",
    );
    const store =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    store[serialNumber] = {
      ...(store[serialNumber] && typeof store[serialNumber] === "object"
        ? store[serialNumber]
        : {}),
      [route]: profile,
      updatedAt: Date.now(),
    };
    const serials = Object.keys(store);
    if (serials.length > YHM_ROUTE_PROFILE_MEMORY_LIMIT) {
      serials.sort(
        (a, b) => (store[a]?.updatedAt ?? 0) - (store[b]?.updatedAt ?? 0),
      );
      for (const stale of serials.slice(
        0,
        serials.length - YHM_ROUTE_PROFILE_MEMORY_LIMIT,
      )) {
        delete store[stale];
      }
    }
    globalThis.localStorage?.setItem(
      YHM_ROUTE_PROFILE_MEMORY_KEY,
      JSON.stringify(store),
    );
  } catch {
    // Memory is an optimization, never a gate.
  }
}

export function resolveTempleDataPacingStartLevel(
  dataPacingMultiplier,
  rememberedLevel = readTempleDataPacingMemory().level,
) {
  const remembered = clampAutomaticLevel(rememberedLevel);
  const restartFloor =
    dataPacingMultiplier >= 3
      ? TEMPLE_DATA_PACING_LEVELS.length - 1
      : dataPacingMultiplier === 2
        ? TEMPLE_DATA_PACING_LEVELS.length - 2
        : TEMPLE_DATA_PACING_MIN_AUTOMATIC_LEVEL;
  // A restart tier is a minimum, never permission to undo what the exact
  // Case/temple learned from a previous explicit rejection. The 2026-07-30
  // recovery committed level 5 after a level-4 rejection, then the tier-2
  // resolver silently selected level 4 again for the third right attempt.
  return Math.max(remembered, restartFloor);
}

export function templeDataPacingMultiplierForRestart(restartCount) {
  if (!Number.isInteger(restartCount) || restartCount < 0) {
    throw new Error("Temple component restart count must be a nonnegative integer.");
  }
  if (restartCount >= POGO_COMPONENT_RESTART_LIMIT) return 3;
  if (restartCount > 0) return 2;
  return 1;
}

// True when the browser is throttling this page's timers. Only the hidden
// state is observable from script, and it is the one that matters here.
export function defaultPacingThrottleProbe() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export class TempleDataPacingController {
  constructor({
    startLevel = TEMPLE_DATA_PACING_DEFAULT_START_LEVEL,
    totalBytes,
    log = null,
    linkOverheadMs = 0,
    deviceKey = PACING_UNKNOWN_DEVICE_KEY,
    route = "both",
    isThrottled = defaultPacingThrottleProbe,
  } = {}) {
    if (!Number.isInteger(totalBytes) || totalBytes <= 0) {
      throw new Error("Adaptive pacing requires the total payload size.");
    }
    // What this level was learned from, so one temple's behaviour is never
    // applied to the other, nor one Case's to another.
    this.deviceKey = deviceKey || PACING_UNKNOWN_DEVICE_KEY;
    this.route = route || "both";
    this.level = Math.min(
      Math.max(startLevel, 0),
      TEMPLE_DATA_PACING_LEVELS.length - 1,
    );
    this.startLevel = this.level;
    this.totalBytes = totalBytes;
    this.log = log;
    // Measured transport round-trip overhead (a remote-support relay adds a
    // full round trip on each side of a transact) subtracted from every ACK
    // latency, so link distance is never mistaken for temple congestion.
    this.linkOverheadMs = Math.max(0, Number(linkOverheadMs) || 0);
    // A backgrounded tab has its timers throttled by the browser, which
    // inflates the measured ACK by far more than any temple delay: 372 ms
    // per record foregrounded versus 967 ms hidden, on the same link and
    // firmware (measured 2026-07-28). Those samples describe the operator's
    // event loop, not the temple, so they must never drive escalation.
    this.isThrottled = isThrottled;
    this.throttledSamples = 0;
    this.baselineMs = null;
    this.warmupLatencies = [];
    this.cooldownRecords = 0;
    this.escalations = 0;
    this.congestionEvents = [];
    this.ackCount = 0;
    this.ackTotalMs = 0;
    this.ackMaxMs = 0;
    this.settleTotalMs = 0;
  }

  congestionThresholdMs() {
    if (this.baselineMs == null) return PACING_CONGESTION_ABSOLUTE_MS;
    return Math.max(
      PACING_CONGESTION_ABSOLUTE_MS,
      this.baselineMs * PACING_CONGESTION_BASELINE_FACTOR,
    );
  }

  // Returns an immediate extra settle in milliseconds when the ACK latency
  // signals congestion; 0 otherwise.
  noteAckLatency(recordIndex, latencyMs, throttled = this.isThrottled()) {
    latencyMs = Math.max(0, latencyMs - this.linkOverheadMs);
    if (throttled) {
      // Counted so the summary can explain a slow transfer, but excluded
      // from the baseline and from every escalation decision.
      this.throttledSamples += 1;
      if (this.throttledSamples === 1) {
        this.log?.(
          "the tab is in the background, so its timers are throttled; ACK samples taken while hidden are excluded from congestion decisions. Keep this tab in front for full speed.",
          "warn",
        );
      }
      return 0;
    }
    this.ackCount += 1;
    this.ackTotalMs += latencyMs;
    if (latencyMs > this.ackMaxMs) this.ackMaxMs = latencyMs;
    if (this.baselineMs == null) {
      this.warmupLatencies.push(latencyMs);
      if (this.warmupLatencies.length >= PACING_BASELINE_WARMUP_RECORDS) {
        const sorted = [...this.warmupLatencies].sort((a, b) => a - b);
        this.baselineMs = sorted[Math.floor(sorted.length / 2)];
      }
    } else {
      // Slow EWMA so the baseline tracks drift without chasing spikes.
      this.baselineMs = this.baselineMs * 0.95 + latencyMs * 0.05;
    }
    if (this.cooldownRecords > 0) {
      this.cooldownRecords -= 1;
      return 0;
    }
    // Escalation only. Measured rejections arrived with flat ACK latency, so
    // a calm stretch is not evidence that a lower level is safe; the level a
    // run starts at is never reduced mid-transfer.
    if (latencyMs <= this.congestionThresholdMs()) return 0;
    const fromLevel = this.level;
    this.level = Math.min(this.level + 1, TEMPLE_DATA_PACING_LEVELS.length - 1);
    this.escalations += 1;
    this.cooldownRecords = PACING_CHANGE_COOLDOWN_RECORDS;
    if (this.congestionEvents.length < PACING_CONGESTION_EVENT_LOG_LIMIT) {
      this.congestionEvents.push({
        record: recordIndex + 1,
        latencyMs: Math.round(latencyMs),
        thresholdMs: Math.round(this.congestionThresholdMs()),
        fromLevel,
        toLevel: this.level,
      });
    }
    const injected = TEMPLE_DATA_PACING_LEVELS[this.level].late;
    this.settleTotalMs += injected;
    this.log?.(
      `pacing backoff: record ${recordIndex + 1} ACK took ${Math.round(latencyMs)} ms (threshold ${Math.round(this.congestionThresholdMs())} ms); level ${fromLevel} → ${this.level}, settling ${injected} ms now.`,
      "warn",
    );
    return injected;
  }

  settleFor(acceptedBytes) {
    const final = acceptedBytes === this.totalBytes;
    const policy = TEMPLE_DATA_PACING_LEVELS[this.level];
    if (final) {
      // Match the settle the previous fixed policy granted escalated runs.
      const finalMs = Math.max(
        POGO_DATA_FINAL_SETTLE_MS,
        policy.late * 7.5,
      );
      this.settleTotalMs += finalMs;
      return finalMs;
    }
    const lateTransfer =
      acceptedBytes * POGO_DATA_LATE_SETTLE_DENOMINATOR >=
      this.totalBytes * POGO_DATA_LATE_SETTLE_NUMERATOR;
    const deferredBoundary =
      acceptedBytes % POGO_DEFERRED_BATCH_BYTES === 0 &&
      Number.isFinite(policy.deferredEarly) &&
      Number.isFinite(policy.deferredLate);
    if (!deferredBoundary && acceptedBytes % policy.batchBytes !== 0) return 0;
    const settle = deferredBoundary
      ? lateTransfer
        ? policy.deferredLate
        : policy.deferredEarly
      : lateTransfer
        ? policy.late
        : policy.early;
    this.settleTotalMs += settle;
    return settle;
  }

  // Fold this component's result into the cross-run memory. A component that
  // needed a latency backoff is not evidence that its starting level is safe,
  // so it counts as unclean for probing purposes.
  commitMemory(outcome) {
    const clean = outcome === "clean" && this.escalations === 0;
    const memory = nextTempleDataPacingMemory(
      readTempleDataPacingMemory(this.deviceKey, this.route),
      clean ? "clean" : "failed",
      this.level,
    );
    writeTempleDataPacingMemory(memory, this.deviceKey, this.route);
    return memory;
  }

  summary() {
    return {
      mode: "adaptive",
      startLevel: this.startLevel,
      finalLevel: this.level,
      escalations: this.escalations,
      congestionEvents: this.congestionEvents,
      ackCount: this.ackCount,
      ackMeanMs: this.ackCount
        ? Math.round(this.ackTotalMs / this.ackCount)
        : null,
      ackMaxMs: this.ackMaxMs,
      baselineMs:
        this.baselineMs == null ? null : Math.round(this.baselineMs),
      linkOverheadMs: this.linkOverheadMs,
      throttledSamples: this.throttledSamples,
      settleTotalMs: this.settleTotalMs,
    };
  }
}

export async function retryReadOnlyBlock(
  read,
  resynchronize,
  { attempts = 5, onRetry = () => {} } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Read-only retry attempts must be a positive integer.");
  }
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      onRetry(error, attempt, attempts - 1);
      try {
        await resynchronize(attempt);
      } catch (resynchronizeError) {
        // A failed re-entry (for example the Case momentarily booting its
        // application instead of the ROM loader) is itself transient; spend
        // the remaining attempts instead of abandoning the read here.
        lastError = resynchronizeError;
      }
    }
  }
  throw lastError;
}

export function isWebSerialRomPacketBoundary(error, requestedSize) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    requestedSize > WEB_SERIAL_ROM_READ_SIZE &&
    message.includes(
      `received ${WEB_SERIAL_ROM_READ_SIZE} of ${requestedSize} bytes`,
    )
  );
}

export async function readRomBlockWithBoundaryRecovery(
  read,
  resynchronize,
  {
    requestedSize,
    attempts = 5,
    onRetry = () => {},
    onPacketBoundary = () => {},
  } = {},
) {
  if (!Number.isInteger(requestedSize) || requestedSize < 1) {
    throw new Error("A positive ROM read size is required.");
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("ROM read attempts must be a positive integer.");
  }
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return {
        block: await read(attempt),
        packetBoundaryDetected: false,
      };
    } catch (error) {
      lastError = error;
      if (isWebSerialRomPacketBoundary(error, requestedSize)) {
        onPacketBoundary(error, attempt);
        try {
          await resynchronize(attempt);
        } catch {
          // The caller re-reads this block at the reduced size, and that
          // cycle re-synchronizes again on its first failed attempt.
        }
        return {
          block: null,
          packetBoundaryDetected: true,
        };
      }
      if (attempt === attempts) break;
      onRetry(error, attempt + 1, attempts);
      try {
        await resynchronize(attempt);
      } catch (resynchronizeError) {
        // A failed re-entry (for example the Case momentarily booting its
        // application instead of the ROM loader) is itself transient; spend
        // the remaining attempts instead of abandoning the read here.
        lastError = resynchronizeError;
      }
    }
  }
  throw lastError;
}

export async function writePogoFlashTransactionHeader(
  bridge,
  header,
  sleeper = delay,
) {
  if (!(header instanceof Uint8Array) || header.length !== 10) {
    throw new PogoFlashSafetyError(
      "The Case flash bridge transaction header must be exactly 10 bytes.",
    );
  }
  // The physical CH340 captured only five bytes from one 10-byte write after
  // the former two-second pre-start idle. Independently flush both halves so the
  // bridge either receives the complete header or times out before any temple
  // request payload can be sent.
  await bridge.write(header.subarray(0, 5));
  await sleeper(5);
  await bridge.write(header.subarray(5));
}

const POGO_FLASH_RESPONSE_MAGIC = new TextEncoder().encode("G2RX");
const POGO_FLASH_RESPONSE_SCAN_LIMIT = 256;
const POGO_FLASH_HEADER_BYTE_GAP_MS = 2000;

function isSerialReadTimeout(error) {
  return /^Timed out reading .+: received \d+ of \d+ bytes\.$/.test(
    error instanceof Error ? error.message : String(error ?? ""),
  );
}

export async function readPogoFlashResponseHeader(
  bridge,
  timeoutMs,
  onResynchronized = () => {},
  onIncompleteCandidate = () => {},
) {
  if (
    !bridge?.readExact ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new PogoFlashSafetyError(
      "A readable Case bridge and positive response deadline are required.",
    );
  }
  const deadline = Date.now() + timeoutMs;
  const window = [];
  let candidate = null;
  let inspected = 0;
  while (inspected < POGO_FLASH_RESPONSE_SCAN_LIMIT) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new RetryablePogoFlashError(
        `Timed out locating a complete flash bridge response after ${inspected} bytes.`,
      );
    }
    let byte;
    try {
      byte = (
        await bridge.readExact(
          1,
          candidate
            ? Math.min(POGO_FLASH_HEADER_BYTE_GAP_MS, remaining)
            : remaining,
          candidate
            ? "flash bridge response header byte"
            : "flash bridge response synchronization byte",
        )
      )[0];
    } catch (error) {
      if (candidate && isSerialReadTimeout(error)) {
        onIncompleteCandidate(candidate.length - POGO_FLASH_RESPONSE_MAGIC.length);
        window.splice(
          0,
          window.length,
          ...candidate.slice(
            Math.max(
              0,
              candidate.length - (POGO_FLASH_RESPONSE_MAGIC.length - 1),
            ),
          ),
        );
        candidate = null;
        continue;
      }
      throw error;
    }
    inspected += 1;
    if (candidate) {
      candidate.push(byte);
      const nestedMagic =
        candidate.length > POGO_FLASH_RESPONSE_MAGIC.length &&
        candidate
          .slice(-POGO_FLASH_RESPONSE_MAGIC.length)
          .every(
            (value, index) => value === POGO_FLASH_RESPONSE_MAGIC[index],
          );
      if (nestedMagic) {
        onIncompleteCandidate(
          candidate.length - POGO_FLASH_RESPONSE_MAGIC.length * 2,
        );
        candidate = [...POGO_FLASH_RESPONSE_MAGIC];
        continue;
      }
      if (candidate.length === 11) {
        return Uint8Array.from(candidate);
      }
      continue;
    }
    window.push(byte);
    if (window.length > POGO_FLASH_RESPONSE_MAGIC.length) window.shift();
    if (
      window.length === POGO_FLASH_RESPONSE_MAGIC.length &&
      window.every(
        (value, index) => value === POGO_FLASH_RESPONSE_MAGIC[index],
      )
    ) {
      const discardedBytes = inspected - POGO_FLASH_RESPONSE_MAGIC.length;
      if (discardedBytes > 0) onResynchronized(discardedBytes);
      candidate = [...POGO_FLASH_RESPONSE_MAGIC];
    }
  }
  throw new RetryablePogoFlashError(
    `The Case bridge emitted ${POGO_FLASH_RESPONSE_SCAN_LIMIT} bytes without a complete G2RX response header.`,
  );
}

function describeIncompletePogoFlashFrame(candidate) {
  if (candidate.length < 11) {
    return {
      stage: "header",
      receivedBytes: Math.max(
        0,
        candidate.length - POGO_FLASH_RESPONSE_MAGIC.length,
      ),
      expectedBytes: 11 - POGO_FLASH_RESPONSE_MAGIC.length,
      sequence: candidate.length > 5 ? candidate[5] : null,
      capturedLength: null,
    };
  }
  return {
    stage: "payload",
    receivedBytes: candidate.length - 11,
    expectedBytes: candidate[8] + 1,
    sequence: candidate[5],
    capturedLength: candidate[8],
  };
}

export async function readPogoFlashResponseFrame(
  bridge,
  timeoutMs,
  expectedSequence,
  {
    onResynchronized = () => {},
    onIncompleteCandidate = () => {},
    onRejectedCandidate = () => {},
  } = {},
) {
  if (
    !bridge?.readExact ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(expectedSequence) ||
    expectedSequence < 0 ||
    expectedSequence > 0xff
  ) {
    throw new PogoFlashSafetyError(
      "A readable Case bridge, positive response deadline, and byte-sized sequence are required.",
    );
  }
  const deadline = Date.now() + timeoutMs;
  const window = [];
  let candidate = null;
  let expectedFrameLength = null;
  let inspected = 0;
  let lastCandidateProblem = null;

  const abandonCandidate = (reason = null, stageOverride = null) => {
    if (!candidate) return;
    const described = describeIncompletePogoFlashFrame(candidate);
    const problem =
      stageOverride === "header"
        ? {
            ...described,
            stage: "header",
            receivedBytes:
              candidate.length - POGO_FLASH_RESPONSE_MAGIC.length,
            expectedBytes: 11 - POGO_FLASH_RESPONSE_MAGIC.length,
          }
        : described;
    lastCandidateProblem = reason ? { ...problem, reason } : problem;
    if (reason) onRejectedCandidate(lastCandidateProblem);
    else onIncompleteCandidate(problem);
    window.splice(
      0,
      window.length,
      ...candidate.slice(
        Math.max(
          0,
          candidate.length - (POGO_FLASH_RESPONSE_MAGIC.length - 1),
        ),
      ),
    );
    candidate = null;
    expectedFrameLength = null;
  };

  while (inspected < POGO_FLASH_RESPONSE_SCAN_LIMIT) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let byte;
    try {
      byte = (
        await bridge.readExact(
          1,
          candidate
            ? Math.min(POGO_FLASH_HEADER_BYTE_GAP_MS, remaining)
            : remaining,
          candidate
            ? candidate.length < 11
              ? "flash bridge response header byte"
              : "flash bridge response payload byte"
            : "flash bridge response synchronization byte",
        )
      )[0];
    } catch (error) {
      if (candidate && isSerialReadTimeout(error)) {
        abandonCandidate();
        continue;
      }
      if (
        !candidate &&
        isSerialReadTimeout(error) &&
        lastCandidateProblem
      ) {
        break;
      }
      throw error;
    }
    inspected += 1;

    if (!candidate) {
      window.push(byte);
      if (window.length > POGO_FLASH_RESPONSE_MAGIC.length) window.shift();
      if (
        window.length === POGO_FLASH_RESPONSE_MAGIC.length &&
        window.every(
          (value, index) => value === POGO_FLASH_RESPONSE_MAGIC[index],
        )
      ) {
        const discardedBytes = inspected - POGO_FLASH_RESPONSE_MAGIC.length;
        if (discardedBytes > 0) onResynchronized(discardedBytes);
        candidate = [...POGO_FLASH_RESPONSE_MAGIC];
        expectedFrameLength = null;
      }
      continue;
    }

    candidate.push(byte);
    const nestedMagic =
      candidate.length > POGO_FLASH_RESPONSE_MAGIC.length &&
      candidate
        .slice(-POGO_FLASH_RESPONSE_MAGIC.length)
        .every(
          (value, index) => value === POGO_FLASH_RESPONSE_MAGIC[index],
        );
    if (nestedMagic) {
      const priorCandidate = candidate.slice(
        0,
        candidate.length - POGO_FLASH_RESPONSE_MAGIC.length,
      );
      const incomplete = describeIncompletePogoFlashFrame(priorCandidate);
      lastCandidateProblem = incomplete;
      onIncompleteCandidate(incomplete);
      candidate = [...POGO_FLASH_RESPONSE_MAGIC];
      expectedFrameLength = null;
      continue;
    }

    if (candidate.length === 11) {
      if (candidate[4] !== 1) {
        abandonCandidate(
          `unsupported response version ${candidate[4]}`,
          "header",
        );
        continue;
      }
      if (candidate[5] !== expectedSequence) {
        abandonCandidate(
          `stale response sequence ${candidate[5]}, expected ${expectedSequence}`,
          "header",
        );
        continue;
      }
      if (candidate[8] > 64) {
        abandonCandidate(
          `capture length ${candidate[8]} exceeds 64`,
          "header",
        );
        continue;
      }
      expectedFrameLength = 11 + candidate[8] + 1;
    }

    if (
      expectedFrameLength !== null &&
      candidate.length === expectedFrameLength
    ) {
      const frame = Uint8Array.from(candidate);
      try {
        return parsePogoFlashResponse(
          frame.subarray(0, 11),
          frame.subarray(11),
          expectedSequence,
        );
      } catch (error) {
        if (!(error instanceof RetryablePogoFlashError)) throw error;
        abandonCandidate(error.message);
      }
    }
  }

  if (lastCandidateProblem?.reason) {
    throw new RetryablePogoFlashError(
      `Timed out locating a complete flash bridge response after ${inspected} bytes; the last cached ${lastCandidateProblem.stage} candidate was rejected because ${lastCandidateProblem.reason}.`,
    );
  }
  if (lastCandidateProblem) {
    throw new RetryablePogoFlashError(
      `Timed out locating a complete flash bridge response after ${inspected} bytes; the last cached ${lastCandidateProblem.stage} stopped after ${lastCandidateProblem.receivedBytes}/${lastCandidateProblem.expectedBytes} bytes${lastCandidateProblem.sequence === null ? "" : ` for sequence ${lastCandidateProblem.sequence}`}.`,
    );
  }
  throw new RetryablePogoFlashError(
    `The Case bridge emitted ${inspected} bytes without a complete checksum-valid G2RX response frame.`,
  );
}

export function canRunFinalResetAfterFailure(routeResults) {
  return (
    Array.isArray(routeResults) &&
    routeResults.length > 0 &&
    routeResults.every(
      (result) =>
        result?.caseRestoreVerified === true &&
        result?.caseApplicationVersion === REVIEWED_CASE_VERSION,
    )
  );
}

export function canRestartFailedTempleComponent(
  routeResult,
  restartCount = 0,
) {
  const exactHostTimeoutRestoration =
    routeResult?.retainedResult?.status === 16 &&
    routeResult?.retainedResult?.hostTimeoutRestorationVerified === true;
  const restartLimit =
    exactHostTimeoutRestoration
      ? POGO_HOST_TIMEOUT_COMPONENT_RESTART_LIMIT
      : POGO_COMPONENT_RESTART_LIMIT;
  return (
    Number.isInteger(restartCount) &&
    restartCount >= 0 &&
    restartCount < restartLimit &&
    routeResult?.outcome === "failed_or_uncertain" &&
    routeResult?.otaMutationAttempted === true &&
    /^DATA:\d+$/.test(routeResult?.failureStage ?? "") &&
    routeResult?.transfer === null &&
    routeResult?.caseRestoreVerified === true &&
    routeResult?.caseApplicationVersion === REVIEWED_CASE_VERSION &&
    routeResult?.retainedResult?.baselineMask === 0x3ff &&
    routeResult?.retainedResult?.selectedMask === 0x3ff &&
    routeResult?.retainedResult?.restoredMask === 0x3ff &&
    routeResult?.retainedResult?.templeUartErrors === 0
  );
}

function exactRestoredTempleDataFailure(routeResult) {
  return Boolean(
    routeResult?.outcome === "failed_or_uncertain" &&
      routeResult?.otaMutationAttempted === true &&
      /^DATA:\d+$/.test(routeResult?.failureStage ?? "") &&
      routeResult?.transfer === null &&
      routeResult?.caseRestoreVerified === true &&
      routeResult?.caseApplicationVersion === REVIEWED_CASE_VERSION &&
      routeResult?.retainedResult?.baselineMask === 0x3ff &&
      routeResult?.retainedResult?.selectedMask === 0x3ff &&
      routeResult?.retainedResult?.restoredMask === 0x3ff &&
      routeResult?.retainedResult?.templeUartErrors === 0
  );
}

export function classifyPersistentTempleDataRejection(
  routeResult,
  priorFailures = [],
  recordWindow = POGO_PERSISTENT_REJECTION_WINDOW_RECORDS,
) {
  const current = routeResult?.dataRejection;
  if (
    !exactRestoredTempleDataFailure(routeResult) ||
    !Array.isArray(priorFailures) ||
    !Number.isInteger(recordWindow) ||
    recordWindow < 0 ||
    current?.command !== 0x54 ||
    current?.status !== 1 ||
    !Number.isInteger(current.record) ||
    current.record < 1 ||
    !Number.isInteger(current.acceptedBytes) ||
    current.acceptedBytes < 0 ||
    !Number.isInteger(current.totalBytes) ||
    current.totalBytes < 1
  ) {
    return null;
  }
  const prior = [...priorFailures].reverse().find((candidate) => {
    const rejection = candidate?.dataRejection;
    return (
      exactRestoredTempleDataFailure(candidate) &&
      candidate.route === routeResult.route &&
      rejection?.command === current.command &&
      rejection?.status === current.status &&
      rejection?.totalBytes === current.totalBytes &&
      Number.isInteger(rejection.record) &&
      Math.abs(rejection.record - current.record) <= recordWindow
    );
  });
  if (!prior) return null;
  return {
    classification: "persistent_temple_data_rejection_boundary",
    route: routeResult.route,
    command: current.command,
    status: current.status,
    priorRecord: prior.dataRejection.record,
    currentRecord: current.record,
    recordDistance: Math.abs(
      prior.dataRejection.record - current.record,
    ),
    priorAcceptedBytes: prior.dataRejection.acceptedBytes,
    currentAcceptedBytes: current.acceptedBytes,
    totalBytes: current.totalBytes,
    recordWindow,
    additionalWholeComponentRestartAllowed: false,
    recoveryRecommendation:
      "Repeated Case-USB full-component retries are blocked for this image region. Preserve the audit and use the reviewed fresh-BLE full-package recovery path or device service unless new hardware evidence justifies another wired attempt.",
  };
}

export function classifyMaximumPacingTempleDataRejection(routeResult) {
  const current = routeResult?.dataRejection;
  const maximumLevel = TEMPLE_DATA_PACING_LEVELS.length - 1;
  if (
    !exactRestoredTempleDataFailure(routeResult) ||
    current?.command !== 0x54 ||
    current?.status !== 1 ||
    routeResult?.dataPacingPolicy?.startLevel !== maximumLevel
  ) {
    return null;
  }
  return {
    classification: "maximum_pacing_temple_data_rejection_boundary",
    route: routeResult.route,
    command: current.command,
    status: current.status,
    record: current.record,
    acceptedBytes: current.acceptedBytes,
    totalBytes: current.totalBytes,
    pacingLevel: maximumLevel,
    pacing: TEMPLE_DATA_PACING_LEVELS[maximumLevel],
    additionalWholeComponentRestartAllowed: false,
    recoveryRecommendation:
      "The temple explicitly rejected DATA after this attempt began at the maximum reviewed Case-USB pacing. Preserve the audit and use the reviewed fresh-BLE full-package recovery path or device service; do not loop another wired START.",
  };
}

export function canResetAfterZeroWriteSetupStop(
  routeResult,
  resetCount = 0,
) {
  return (
    Number.isInteger(resetCount) &&
    resetCount >= 0 &&
    resetCount < POGO_SETUP_RESET_LIMIT &&
    routeResult?.outcome === "failed_or_uncertain" &&
    routeResult?.failureStage === "setup" &&
    routeResult?.otaMutationAttempted === false &&
    routeResult?.acceptedFirmwareBytes === 0 &&
    routeResult?.caseRestoreVerified === true &&
    routeResult?.caseApplicationVersion === REVIEWED_CASE_VERSION &&
    routeResult?.retainedResult?.status === 3 &&
    routeResult?.retainedResult?.selectedMask === 0 &&
    routeResult?.retainedResult?.restoredMask === 0 &&
    routeResult?.retainedResult?.writeMask === 0 &&
    routeResult?.retainedResult?.declaredSize === 0 &&
    routeResult?.retainedResult?.acceptedSize === 0 &&
    routeResult?.retainedResult?.templeTxCount === 0 &&
    routeResult?.retainedResult?.templeRxCount === 0 &&
    routeResult?.retainedResult?.noMutationSetupStopVerified === true &&
    routeResult?.recoveryBoundary?.classification ===
      "yhm_setup_non_idle_zero_byte_boundary"
  );
}

export function classifyExhaustedYhmSetupBoundary(
  routeResult,
  {
    settleAttempts = 0,
    settleLimit =
      POGO_READ_ONLY_PHASE_SETTLE_MS.length -
      POGO_SETUP_STOP_FIRST_SETTLE_INDEX,
    resetAttempts = 0,
    resetLimit = POGO_SETUP_RESET_LIMIT,
  } = {},
) {
  if (
    !canResetAfterZeroWriteSetupStop(routeResult, 0) ||
    !Number.isInteger(settleAttempts) ||
    !Number.isInteger(settleLimit) ||
    !Number.isInteger(resetAttempts) ||
    !Number.isInteger(resetLimit) ||
    settleLimit < 1 ||
    resetLimit < 1 ||
    settleAttempts < settleLimit ||
    resetAttempts < resetLimit
  ) {
    return null;
  }
  return {
    classification: "yhm_setup_exhausted_zero_byte_boundary",
    route: routeResult.route,
    firmwareBytesAccepted: 0,
    otaMutationAttempted: false,
    settleAttempts,
    resetAttempts,
    additionalWiredSetupAllowed: false,
    recommendedNextTransport: "fresh Bluetooth full-package recovery",
    recoveryRecommendation:
      "The Case-to-pogo writer exhausted its bounded settle and reset/recheck attempts before route selection, with immutable proof that no firmware bytes were sent on this route. Preserve every route already verified at the target and do not loop another wired Apply. Use the Direct recovery fallback to install the complete pinned package over a fresh Bluetooth connection; target-proven routes can be retained without rewriting them.",
  };
}

function compactHex(input) {
  return [...(input ?? [])]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function requireReviewedCaseRom(loader) {
  if (loader.version !== 0x31 || loader.productId !== 0x0467) {
    throw new PogoFlashSafetyError(
      `The Case ROM identity differs from the reviewed device (protocol=0x${loader.version
        ?.toString(16)}, product=0x${loader.productId?.toString(16)}).`,
    );
  }
  if (
    loader.commands.length !== REVIEWED_CASE_ROM_COMMANDS.length ||
    !REVIEWED_CASE_ROM_COMMANDS.every((command) =>
      loader.commands.includes(command))
  ) {
    throw new PogoFlashSafetyError(
      `The Case ROM command table differs from the reviewed device (${loader.commands
        .map((command) => command.toString(16).padStart(2, "0"))
        .join(" ")}).`,
    );
  }
}

function xor(bytes) {
  return bytes.reduce((result, value) => result ^ value, 0);
}

function addressPacket(address) {
  const bytes = new Uint8Array([
    (address >>> 24) & 0xff,
    (address >>> 16) & 0xff,
    (address >>> 8) & 0xff,
    address & 0xff,
  ]);
  return new Uint8Array([...bytes, xor([...bytes])]);
}

export class SerialTransport {
  constructor(port, log) {
    this.port = port;
    this.log = log;
    this.reader = null;
    this.writer = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.waiters = new Set();
    this.readError = null;
    this.pumpPromise = null;
  }

  async open(options) {
    await this.port.open(options);
    if (!this.port.readable || !this.port.writable) {
      // The port itself opened, so it must be released here — the caller
      // cannot tell this partial state apart from open() failing outright.
      try {
        await this.port.close();
      } catch {
        // The half-opened port may already be unusable.
      }
      throw new Error("The serial port did not expose readable and writable streams.");
    }
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.pumpPromise = this.pump();
  }

  async pump() {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value?.length) {
          this.queue.push(value);
          this.queuedBytes += value.length;
          this.notify();
        }
      }
    } catch (error) {
      // Deliberate teardown is detected by state, not by error name: close()
      // nulls this.reader before cancelling, so a rejection that arrives with
      // no reader is teardown noise. Everything else is a real transport
      // failure and is recorded — including the NetworkError DOMException a
      // stalled-but-still-enumerated CH340 produces, which the old
      // name-based filter silently discarded, degrading every later read
      // into a timeout with the cause lost.
      if (this.reader) {
        this.readError = error;
      }
      this.notify();
    }
  }

  notify() {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  async setSignals(dataTerminalReady, requestToSend) {
    await this.port.setSignals({ dataTerminalReady, requestToSend });
  }

  async write(data) {
    if (!this.writer) throw new Error("The serial writer is not open.");
    await this.writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  clear() {
    // Drops buffered bytes only. A recorded pump error is preserved: once the
    // reader loop has exited, clearing the error cannot restore data flow —
    // it can only replace the real transport failure with a later, misleading
    // timeout. The postflight loop drains this transport every 2 seconds, and
    // an erased USB stall there turned into "no checksum-valid postflight
    // version arrived within 180 seconds" with the actual cause lost.
    this.queue = [];
    this.queuedBytes = 0;
  }

  take(count = this.queuedBytes) {
    const target = Math.min(count, this.queuedBytes);
    const result = new Uint8Array(target);
    let written = 0;
    while (written < target) {
      const chunk = this.queue[0];
      const needed = target - written;
      const used = Math.min(needed, chunk.length);
      result.set(chunk.subarray(0, used), written);
      written += used;
      this.queuedBytes -= used;
      if (used === chunk.length) {
        this.queue.shift();
      } else {
        this.queue[0] = chunk.subarray(used);
      }
    }
    return result;
  }

  async waitForData(timeoutMs) {
    if (this.queuedBytes || this.readError) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(onData);
        resolve();
      }, timeoutMs);
      const onData = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.waiters.add(onData);
    });
  }

  async readExact(count, timeoutMs = 3000, label = "serial response") {
    const deadline = Date.now() + timeoutMs;
    while (this.queuedBytes < count && !this.readError && Date.now() < deadline) {
      await this.waitForData(Math.max(1, deadline - Date.now()));
    }
    // Serve a complete, already-buffered response before surfacing a pump
    // error: a device that answered in full and THEN dropped the link has
    // still answered, and discarding those bytes converted a recoverable
    // "last ACK arrived, then the cable moved" into a hard abort. The error
    // is still sticky and surfaces on the next read that actually needs data.
    if (this.queuedBytes >= count) return this.take(count);
    if (this.readError) throw this.readError;
    throw new Error(
      `Timed out reading ${label}: received ${this.queuedBytes} of ${count} bytes.`,
    );
  }

  async collectFor(milliseconds) {
    await delay(milliseconds);
    return this.take();
  }

  async close() {
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // A hardware reset can close the stream before cancellation.
      }
      try {
        await this.pumpPromise;
      } catch {
        // The read error is surfaced by readExact when it matters.
      }
      try {
        reader.releaseLock();
      } catch {
        // Already released by the browser.
      }
    }
    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch {
        // Already released by the browser.
      }
      this.writer = null;
    }
    try {
      await this.port.close();
    } catch {
      // The device may have reset immediately after option-byte programming.
    }
  }
}

// Drain the serial line until it stays silent for one slice, so the STM32
// sync byte is not answered with leftover application chatter.
//
// Draining once is not enough: bytes the reset spewed can still be in flight,
// and over a remote-support relay a whole round trip of them lands after the
// local queue was emptied. That produced an "Unexpected 0x.." sync rejection
// on attempt 1 of essentially every entry. If the Case booted its application
// instead of the loader it never goes quiet, so the wait is bounded by a slice
// count and the caller's existing boot-select retry still handles that.
export async function drainUntilQuietLine(
  transport,
  { remote = false, linkRttMs = null, sleeper = delay } = {},
) {
  const sliceMs = remote
    ? Math.max(200, Math.min(600, Math.round(linkRttMs ?? 300)))
    : 120;
  const maxSlices = Math.max(1, Math.ceil((remote ? 2500 : 900) / sliceMs));
  transport.clear();
  for (let slice = 0; slice < maxSlices; slice += 1) {
    await sleeper(sliceMs);
    if (transport.queuedBytes === 0) return true;
    transport.clear();
  }
  transport.clear();
  return false;
}

export class Stm32Bootloader {
  constructor(port, log) {
    this.port = port;
    this.log = log;
    this.transport = null;
    this.commands = [];
    this.version = null;
    this.productId = null;
    this.maximumReadSize = hasObservedWebSerialRomPacketBoundary()
      ? WEB_SERIAL_ROM_READ_SIZE
      : 256;
  }

  async connect() {
    this.transport = new SerialTransport(this.port, this.log);
    await this.transport.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "even",
      flowControl: "none",
      bufferSize: 4096,
    });
    await this.enterRomLoader();
    const identity = await this.get();
    this.version = identity.version;
    this.commands = identity.commands;
    this.productId = await this.getId();
    if (this.productId !== 0x0467) {
      throw new Error(
        `Unexpected STM32 product ID 0x${this.productId.toString(16).padStart(4, "0")}.`,
      );
    }
  }

  // Drive the Case into its ROM loader and synchronize.
  //
  // The boot select line must already be settled when reset is released, so
  // the sequence starts from an explicitly asserted state rather than from
  // whatever the previous session left on the adapter — the normal-console
  // entry does the same thing, and skipping it is why a WebUSB session could
  // answer the sync with running application output ("Unexpected 0x4c").
  // Each attempt gives the loader a little longer to come up before the
  // sync byte.
  async waitForQuietLine() {
    return drainUntilQuietLine(this.transport, {
      remote: this.port?.transportKind === "remote",
      linkRttMs: this.port?.linkRttMs ?? null,
    });
  }

  async enterRomLoader(attempts = ROM_ENTRY_ATTEMPTS) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.transport.setSignals(true, true);
        await delay(60);
        await this.transport.setSignals(false, true);
        await delay(60);
        await this.transport.setSignals(false, false);
        await delay(180 * attempt);
        await this.waitForQuietLine();
        await this.transport.write(new Uint8Array([SYNC]));
        await this.expectAck("bootloader synchronization", 3000);
        if (attempt > 1) {
          this.log?.(
            `Entered the STM32 ROM loader on boot-select attempt ${attempt}/${attempts}.`,
            "warn",
          );
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
        this.log?.(
          `The Case did not answer the ROM sync on attempt ${attempt}/${attempts} (${error.message}); repeating the boot-select reset.`,
          "warn",
        );
      }
    }
    throw lastError;
  }

  async close() {
    await this.transport?.close();
    this.transport = null;
  }

  takeTransport() {
    if (!this.transport) {
      throw new Error("The STM32 ROM transport is not open.");
    }
    const transport = this.transport;
    this.transport = null;
    return transport;
  }

  requireCommand(command, label) {
    if (!this.commands.includes(command)) {
      throw new Error(`The Case ROM loader does not advertise ${label}.`);
    }
  }

  async sendCommand(command, label) {
    await this.transport.write(new Uint8Array([command, command ^ 0xff]));
    await this.expectAck(label);
  }

  async expectAck(label, timeoutMs = 3000) {
    const value = (await this.transport.readExact(1, timeoutMs, `${label} ACK`))[0];
    if (value === NACK) throw new Error(`The Case returned NACK during ${label}.`);
    if (value !== ACK) {
      throw new Error(
        `Unexpected 0x${value.toString(16).padStart(2, "0")} during ${label}.`,
      );
    }
  }

  async get() {
    await this.transport.write(new Uint8Array([GET, GET ^ 0xff]));
    await this.expectAck("Get command");
    const countMinusOne = (await this.transport.readExact(1, 1000, "Get length"))[0];
    const response = await this.transport.readExact(
      countMinusOne + 1,
      1000,
      "Get payload",
    );
    await this.expectAck("Get completion");
    return { version: response[0], commands: [...response.subarray(1)] };
  }

  async getId() {
    await this.transport.write(new Uint8Array([GET_ID, GET_ID ^ 0xff]));
    await this.expectAck("Get ID command");
    const countMinusOne = (await this.transport.readExact(1, 1000, "Get ID length"))[0];
    const response = await this.transport.readExact(
      countMinusOne + 1,
      1000,
      "Get ID payload",
    );
    await this.expectAck("Get ID completion");
    return response.reduce((result, value) => (result << 8) | value, 0);
  }

  async readMemory(address, size) {
    if (size < 1 || size > 256) throw new Error("ROM reads must be 1–256 bytes.");
    this.requireCommand(READ_MEMORY, "Read Memory");
    await this.sendCommand(READ_MEMORY, "Read Memory command");
    await this.transport.write(addressPacket(address));
    await this.expectAck("Read Memory address");
    const encodedSize = size - 1;
    await this.transport.write(new Uint8Array([encodedSize, encodedSize ^ 0xff]));
    await this.expectAck("Read Memory length");
    return this.transport.readExact(size, 3000, `memory at 0x${address.toString(16)}`);
  }

  async readRange(address, size, onProgress) {
    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(this.maximumReadSize, size - offset);
      const blockAddress = address + offset;
      const resynchronize = async () => {
        await this.close();
        await delay(120);
        await this.connect();
      };
      const readResult = await readRomBlockWithBoundaryRecovery(
        () => this.readMemory(blockAddress, length),
        resynchronize,
        {
          requestedSize: length,
          attempts: 5,
          onPacketBoundary: () =>
            this.log(
              `Detected the CH340 Web Serial packet boundary at 0x${blockAddress.toString(16)}; discarding the partial reply and switching to ${WEB_SERIAL_ROM_READ_SIZE}-byte ROM reads.`,
              "warn",
            ),
          onRetry: (retryError, nextAttempt, attemptCount) => {
            this.log(
              `ROM read retry ${nextAttempt}/${attemptCount} at 0x${blockAddress.toString(16)} after ${retryError.message}`,
              "warn",
            );
            noteWebSerialShortReadRetry(this.port, this.log);
          },
        },
      );
      if (readResult.packetBoundaryDetected) {
        this.maximumReadSize = WEB_SERIAL_ROM_READ_SIZE;
        noteWebSerialRomPacketBoundaryObserved();
        continue;
      }
      const block = readResult.block;
      output.set(block, offset);
      offset += length;
      onProgress?.(offset / size);
    }
    return output;
  }

  async go(address) {
    this.requireCommand(GO, "Go");
    try {
      await this.sendCommand(GO, "Go command");
    } catch (error) {
      // No address has been accepted, so the ROM provably has not jumped;
      // callers may re-enter the loader and reissue Go unconditionally.
      if (error && typeof error === "object") error.romGoStage = "command";
      throw error;
    }
    await this.transport.write(addressPacket(address));
    try {
      await this.expectAck("Go address");
    } catch (error) {
      // The transport's sticky readError is one shared object: an earlier
      // command-stage failure may have tagged this same instance, so the
      // address stage must overwrite the tag rather than trust a stale one.
      if (error && typeof error === "object") error.romGoStage = "address";
      throw error;
    }
  }

  // Launch bridge code that is already byte-verified in SRAM. The remote
  // Case link drops single ACK bytes (the same loss the 5-attempt read retry
  // absorbs), so Go gets a bounded recovery split by what each stage proves:
  // a command-stage failure means the ROM cannot have jumped, so a
  // boot-select re-entry — which retains SRAM — restores a known state and
  // Go is reissued; an address-stage failure cannot distinguish a lost ACK
  // from a lost address packet, and the jump may already have happened, so
  // Go is never reissued — the caller must treat the bridge banner as the
  // outcome proof instead.
  async goWithLostAckRecovery(address, { attempts = 3 } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.go(address);
        return { goAckLost: false };
      } catch (error) {
        if (error?.romGoStage === "address") {
          this.log?.(
            `The Go address ACK was not received (${error.message}); the jump may still have happened, so the bridge banner decides the outcome instead of a Go replay.`,
            "warn",
          );
          return { goAckLost: true };
        }
        if (attempt === attempts) throw error;
        this.log?.(
          `ROM Go retry ${attempt + 1}/${attempts} after ${error?.message ?? String(error)}`,
          "warn",
        );
        try {
          await this.close();
          await delay(120);
          await this.connect();
        } catch {
          // A failed re-entry is itself transient; the next Go attempt
          // surfaces it and is counted against the same bound.
        }
      }
    }
  }

  async releaseBootSelection() {
    await this.transport.setSignals(true, false);
  }

  async erasePages(pageNumbers) {
    this.requireCommand(EXTENDED_ERASE, "Extended Erase");
    if (!pageNumbers.length || pageNumbers.length > 128) {
      throw new Error("The bounded recovery path erases 1–128 pages.");
    }
    await this.sendCommand(EXTENDED_ERASE, "Extended Erase command");
    const count = pageNumbers.length - 1;
    const payload = [
      (count >>> 8) & 0xff,
      count & 0xff,
      ...pageNumbers.flatMap((page) => [(page >>> 8) & 0xff, page & 0xff]),
    ];
    await this.transport.write(new Uint8Array([...payload, xor(payload)]));
    await this.expectAck("page erase", 30000);
  }

  async writeMemory(address, input, timeoutMs = 5000) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!bytes.length || bytes.length > 256 || bytes.length % 4 !== 0) {
      throw new Error("ROM writes must contain 4–256 bytes in a multiple of four.");
    }
    this.requireCommand(WRITE_MEMORY, "Write Memory");
    try {
      await this.sendCommand(WRITE_MEMORY, "Write Memory command");
      await this.transport.write(addressPacket(address));
      await this.expectAck("Write Memory address");
    } catch (error) {
      // No data byte has been sent yet, so nothing can have been programmed;
      // callers may replay this write unconditionally.
      if (error && typeof error === "object") error.romWriteStage = "setup";
      throw error;
    }
    const encodedSize = bytes.length - 1;
    const body = [encodedSize, ...bytes];
    try {
      await this.transport.write(new Uint8Array([...body, xor(body)]));
      await this.expectAck("Write Memory data", timeoutMs);
    } catch (error) {
      // The transport's sticky readError is one shared object: an earlier
      // setup-stage failure may have tagged this same instance. A data-phase
      // failure must never carry the replay-safe tag, so strip a stale one.
      if (error && typeof error === "object" && error.romWriteStage) {
        delete error.romWriteStage;
      }
      throw error;
    }
  }

  async writeRange(address, input, onProgress) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    for (let offset = 0; offset < bytes.length; offset += 256) {
      const source = bytes.subarray(offset, Math.min(offset + 256, bytes.length));
      const paddedLength = Math.ceil(source.length / 4) * 4;
      const block = new Uint8Array(paddedLength);
      block.fill(0xff);
      block.set(source);
      const blockAddress = address + offset;
      // A staged Case image is ~2,000 consecutive single-ACK exchanges over
      // the same CH340 link whose reads needed a 5-attempt bounded retry.
      // Writes get the same treatment, but gated by what is provably safe to
      // replay: volatile SRAM is byte-for-byte idempotent at any stage, while
      // flash on this part refuses re-programming a non-erased word, so a
      // flash block is replayed only when the failure preceded the data
      // phase (romWriteStage "setup", nothing programmed).
      const sramTarget =
        blockAddress >= 0x20000000 && blockAddress < 0x20040000;
      const writeAttempts = 3;
      for (let attempt = 1; attempt <= writeAttempts; attempt += 1) {
        try {
          await this.writeMemory(blockAddress, block);
          break;
        } catch (error) {
          const replaySafe = sramTarget || error?.romWriteStage === "setup";
          if (!replaySafe || attempt === writeAttempts) throw error;
          this.log?.(
            `ROM write retry ${attempt + 1}/${writeAttempts} at 0x${blockAddress.toString(16)} after ${error?.message ?? String(error)}`,
            "warn",
          );
          try {
            await this.close();
            await delay(120);
            await this.connect();
          } catch {
            // A failed re-entry is itself transient; the next write attempt
            // surfaces it and is counted against the same bound.
          }
        }
      }
      onProgress?.((offset + source.length) / bytes.length);
    }
  }
}

async function openNormalConsole(port) {
  const transport = new SerialTransport(port);
  // A partial open must not strand the port: setSignals is a real CH340
  // control transfer that can fail after open() has already taken the
  // reader/writer locks, and leaving them held made every later open in the
  // page fail with "already open" until the tab was reloaded. But cleanup is
  // gated on OUR open having succeeded — when open() itself threw (for
  // example because another live transport already holds this shared port),
  // closing here would tear the port down under its legitimate user.
  let opened = false;
  try {
    await transport.open({
      baudRate: 1_000_000,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: 65536,
    });
    opened = true;
    await transport.setSignals(true, true);
    await delay(60);
    await transport.setSignals(true, false);
    return transport;
  } catch (error) {
    if (opened) {
      try {
        await transport.close();
      } catch {
        // The failed open may already have torn the port down.
      }
    }
    throw error;
  }
}

async function queryNormal(transport, command, duration = 850) {
  if (![0xa0, 0xa2, 0xa3, 0xa4].includes(command)) {
    throw new Error("Only the read-only A0/A2/A3/A4 query allowlist is available.");
  }
  transport.clear();
  const line = new TextEncoder().encode(`DE${command.toString(16).toUpperCase()}\n`);
  await transport.write(line);
  return new TextDecoder().decode(await transport.collectFor(duration));
}

async function resetTemples(transport) {
  transport.clear();
  await transport.write(new TextEncoder().encode("DEB0\n"));
  const resetOutput = new TextDecoder().decode(await transport.collectFor(2200));
  if (!/reset gls L & R, reason: cmd/i.test(resetOutput)) {
    throw new Error(
      "The Case did not confirm the traced B0 left/right temple reset command.",
    );
  }
  return resetOutput;
}

// Whether a record's token-paced loop runs in the person's browser as one
// batched exchange, and if not, which leg is missing it. Logged once per
// component so a slow remote transfer is diagnosable from the transcript
// alone rather than by measuring throughput.
export function describeRemoteTransactOffload(port) {
  if (port?.transportKind !== "remote") {
    return { offloaded: false, reason: "local transport" };
  }
  if (typeof port.supportsExchangeBatch !== "function") {
    return { offloaded: false, reason: "this WebFlasher build cannot batch" };
  }
  if (port.supportsExchangeBatch()) {
    return { offloaded: true, reason: null };
  }
  const relayOperations = port.connection?.serialOperations;
  if (!Array.isArray(relayOperations)) {
    return {
      offloaded: false,
      reason: "the relay does not advertise its serial operations",
    };
  }
  if (!relayOperations.includes("exchange_batch")) {
    return { offloaded: false, reason: "the relay does not forward batches" };
  }
  return {
    offloaded: false,
    reason: "the person's browser does not advertise batch support",
  };
}

class CasePogoFlashTransport {
  constructor(
    session,
    route,
    {
      progressBase = 0,
      progressSpan = 1,
      yhmProfile =
        session.routeYhmProfiles?.get(route) ?? YHM_PROFILE_REVIEWED_22,
    } = {},
  ) {
    if (!["left", "right"].includes(route)) {
      throw new PogoFlashSafetyError("The Case bridge route must be left or right.");
    }
    requireYhmProfile(yhmProfile);
    this.session = session;
    this.port = session.port;
    this.route = route;
    this.yhmProfile = yhmProfile;
    this.reportProgress = (fraction, detail) =>
      session.progress(progressBase + fraction * progressSpan, detail);
    this.loader = null;
    this.bridge = null;
    this.sequence = 0;
    this.bridgeLaunched = false;
    this.active = false;
    this.closed = false;
    this.restoreVerified = false;
    this.retainedResult = null;
    this.setupPhaseStopVerified = false;
    this.caseReport = null;
    this.completedTransfer = null;
    this.hostOnlyKeepalives = 0;
    this.routePhaseSetupAttempts = 0;
  }

  async closeTransport(name) {
    const transport = this[name];
    this[name] = null;
    if (!transport) return;
    try {
      await transport.close();
    } catch (error) {
      this.session.log(
        `${name === "bridge" ? "Flash bridge" : "ROM loader"} close was not confirmed: ${error.message}`,
        "warn",
      );
    }
  }

  async open() {
    this.routePhaseSetupAttempts = 1;
    await this.openOnce();
  }

  async openOnce() {
    const payload = await getVerifiedPogoFlashBridgePayload(this.yhmProfile);
    const bridgeSha256 =
      POGO_FLASH_BRIDGE_PROFILE_SHA256[this.yhmProfile] ??
      (await sha256Hex(payload));
    this.session.log(
      `${this.route}: loading the separately pinned ${this.yhmProfile} writer bridge · ${bridgeSha256.slice(0, 16)}….`,
    );
    const zeroProof = new Uint8Array(POGO_FLASH_PROOF.length);
    const zeroResult = new Uint8Array(POGO_FLASH_RESULT_LENGTH);
    try {
      this.loader = new Stm32Bootloader(this.port, this.session.log);
      await this.loader.connect();
      requireReviewedCaseRom(this.loader);

      await this.loader.writeRange(POGO_FLASH_PROOF_ADDRESS, zeroProof);
      await this.loader.writeRange(POGO_FLASH_RESULT_ADDRESS, zeroResult);
      const initialProof = await this.loader.readRange(
        POGO_FLASH_PROOF_ADDRESS,
        zeroProof.length,
      );
      const initialResult = await this.loader.readRange(
        POGO_FLASH_RESULT_ADDRESS,
        zeroResult.length,
      );
      if (
        !equalBytes(initialProof, zeroProof) ||
        !equalBytes(initialResult, zeroResult)
      ) {
        throw new PogoFlashSafetyError(
          "The volatile flash bridge proof/result locations did not clear.",
        );
      }
      for (let offset = 0; offset < payload.length; offset += 256) {
        const chunk = payload.subarray(offset, Math.min(offset + 256, payload.length));
        const address = POGO_FLASH_BRIDGE_ADDRESS + offset;
        await this.loader.writeRange(address, chunk);
        const readback = await this.loader.readRange(address, chunk.length);
        if (!equalBytes(readback, chunk)) {
          throw new PogoFlashSafetyError(
            `The volatile flash bridge readback differs at 0x${address.toString(16)}.`,
          );
        }
        this.reportProgress(
          0.02 + ((offset + chunk.length) / payload.length) * 0.04,
          `${this.route}: verifying volatile flash bridge`,
        );
      }
      const { goAckLost } = await this.loader.goWithLostAckRecovery(
        POGO_FLASH_BRIDGE_ADDRESS,
      );
      await this.loader.releaseBootSelection();
      this.bridgeLaunched = true;
      this.bridge = this.loader.takeTransport();
      this.loader = null;

      const banner = await this.bridge.readExact(
        POGO_FLASH_BRIDGE_BANNER.length,
        goAckLost ? 6000 : 3000,
        "flash bridge banner",
      );
      if (!equalBytes(banner, POGO_FLASH_BRIDGE_BANNER)) {
        throw new PogoFlashSafetyError("The volatile flash bridge banner is invalid.");
      }
      if (goAckLost) {
        this.session.log(
          `${this.route}: the verified flash bridge banner arrived after the lost Go ACK, proving the launch; continuing normally.`,
          "warn",
        );
      }

      const setup = makePogoFlashSetup(this.route);
      await this.bridge.write(setup);
      const ready = await this.bridge.readExact(13, 10000, "flash bridge ready response");
      parsePogoFlashReady(ready, setup);
      this.active = true;
      this.session.log(
        `${this.route}: verified the ${payload.length.toLocaleString("en-US")}-byte volatile writer and selected the mutation-compatible Case phase.`,
      );
    } catch (error) {
      await this.closeTransport("loader");
      await this.closeTransport("bridge");
      throw error;
    }
  }

  async readBridgeResponse(timeoutMs) {
    const responseTimeout = Math.max(20000, timeoutMs + 30000);
    return readPogoFlashResponseFrame(
      this.bridge,
      responseTimeout,
      this.sequence,
      {
        onResynchronized: (discardedBytes) =>
          this.session.log(
            `${this.route}: discarded ${discardedBytes} byte${discardedBytes === 1 ? "" : "s"} from a short Case response prefix and synchronized to a cached G2RX frame.`,
            "warn",
          ),
        onIncompleteCandidate: ({
          stage,
          receivedBytes,
          expectedBytes,
          sequence,
        }) =>
          this.session.log(
            `${this.route}: cached G2RX response ${stage} stopped after ${receivedBytes}/${expectedBytes} bytes${sequence === null ? "" : ` for sequence ${sequence}`}; passively waiting for another complete cached frame without replaying the temple request.`,
            "warn",
          ),
        onRejectedCandidate: ({
          stage,
          receivedBytes,
          expectedBytes,
          reason,
        }) =>
          this.session.log(
            `${this.route}: discarded a cached G2RX ${stage} candidate after ${receivedBytes}/${expectedBytes} bytes (${reason}); passively waiting for a checksum-valid frame without replaying the temple request.`,
            "warn",
          ),
      },
    );
  }

  // Writes one framed bridge request: the split 10-byte header, the payload
  // in 32-byte chunks each acknowledged by a 0xC3 flow-control token, then
  // the additive checksum byte. When the remote port, relay, and device
  // build all understand exchange batches, the entire paced loop executes in
  // the customer's browser as one declarative batch — one relay round trip
  // instead of one per token — with identical failure semantics.
  describeTransactOffload() {
    return describeRemoteTransactOffload(this.port);
  }

  async writeTokenPacedRequest({
    header,
    payload,
    checksumByte,
    headerTokenLabel,
    chunkTokenLabel,
    headerRejectionMessage,
    chunkRejectionMessage,
  }) {
    const port = this.port;
    if (
      typeof port?.supportsExchangeBatch !== "function" ||
      !port.supportsExchangeBatch()
    ) {
      await writePogoFlashTransactionHeader(this.bridge, header);
      const headerToken = await this.bridge.readExact(1, 8000, headerTokenLabel);
      if (headerToken[0] !== 0xc3) {
        throw new RetryablePogoFlashError(headerRejectionMessage);
      }
      for (let offset = 0; offset < payload.length; offset += 32) {
        await this.bridge.write(
          payload.subarray(offset, Math.min(offset + 32, payload.length)),
        );
        const token = await this.bridge.readExact(
          1,
          8000,
          chunkTokenLabel(offset),
        );
        if (token[0] !== 0xc3) {
          throw new RetryablePogoFlashError(chunkRejectionMessage(offset));
        }
      }
      await this.bridge.write(new Uint8Array([checksumByte]));
      return { offloaded: false };
    }
    // Tokens come from the bridge's tight SRAM loop within milliseconds of
    // each local write; 2 s per token keeps the batch inside its total
    // budget while remaining far above anything observed on hardware.
    const token = encodeRemoteBytes(new Uint8Array([0xc3]));
    const steps = [
      { op: "write", data: encodeRemoteBytes(header.subarray(0, 5)) },
      { op: "delay", ms: 5 },
      { op: "write", data: encodeRemoteBytes(header.subarray(5)) },
      { op: "expect", data: token, timeoutMs: 2000 },
    ];
    const tokenMeta = [
      null,
      null,
      null,
      { label: headerTokenLabel, rejection: headerRejectionMessage },
    ];
    for (let offset = 0; offset < payload.length; offset += 32) {
      steps.push({
        op: "write",
        data: encodeRemoteBytes(
          payload.subarray(offset, Math.min(offset + 32, payload.length)),
        ),
      });
      tokenMeta.push(null);
      steps.push({ op: "expect", data: token, timeoutMs: 2000 });
      tokenMeta.push({
        label: chunkTokenLabel(offset),
        rejection: chunkRejectionMessage(offset),
      });
    }
    steps.push({
      op: "write",
      data: encodeRemoteBytes(new Uint8Array([checksumByte])),
    });
    tokenMeta.push(null);
    let batch;
    try {
      batch = await port.exchangeBatch(steps);
    } catch (error) {
      throw new RetryablePogoFlashError(
        `The remote exchange batch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (batch?.ok === true) return { offloaded: true };
    const failedToken = tokenMeta[batch?.failedStep] ?? null;
    if (batch?.reason === "expect-mismatch" && failedToken) {
      throw new RetryablePogoFlashError(failedToken.rejection);
    }
    if (batch?.reason === "timeout" && failedToken) {
      throw new RetryablePogoFlashError(
        `Timed out reading ${failedToken.label}: received ${
          batch.receivedBytes ?? 0
        } of ${batch.expectedBytes ?? 1} bytes.`,
      );
    }
    throw new RetryablePogoFlashError(
      `The remote exchange batch stopped at step ${
        batch?.failedStep ?? "?"
      } (${batch?.reason ?? "unknown"}).`,
    );
  }

  // Median relay round trip doubled: a remote transact pays one round trip
  // for the batched write and one for the streamed response. Zero for local
  // transports.
  async measureLinkOverheadMs() {
    const port = this.port;
    if (
      port?.transportKind !== "remote" ||
      typeof port.measureLinkRtt !== "function"
    ) {
      return 0;
    }
    let rtt = port.linkRttMs;
    if (rtt == null) {
      try {
        rtt = await port.measureLinkRtt();
      } catch {
        return 0;
      }
    }
    return rtt ? Math.min(4000, rtt * 2) : 0;
  }

  async transact(request, timeoutMs) {
    if (!this.active || !this.bridge) {
      throw new PogoFlashSafetyError("The volatile flash bridge is not active.");
    }
    const bytes = request instanceof Uint8Array ? request : new Uint8Array(request);
    if (!bytes.length || bytes.length > 1009) {
      throw new PogoFlashSafetyError("The temple request is outside the bridge bounds.");
    }
    this.sequence = (this.sequence + 1) & 0xff;
    try {
      const checksum = [...bytes].reduce((sum, value) => (sum + value) & 0xff, 0);
      await this.writeTokenPacedRequest({
        header: makePogoFlashTransactionHeader(this.sequence, bytes.length),
        payload: bytes,
        checksumByte: checksum,
        headerTokenLabel: "transaction-header flow-control token",
        chunkTokenLabel: (offset) => `transaction flow-control token at ${offset}`,
        headerRejectionMessage:
          "The flash bridge rejected the transaction header.",
        chunkRejectionMessage: (offset) =>
          `The flash bridge did not consume the payload chunk at ${offset}.`,
      });
      const response = await this.readBridgeResponse(timeoutMs);
      if (response.uartErrors) {
        throw new RetryablePogoFlashError(
          `The pogo UART reported error mask 0x${response.uartErrors.toString(16)}.`,
        );
      }
      if (response.status === 6) {
        throw new RetryablePogoFlashError(
          "No complete temple response arrived through the Case bridge.",
        );
      }
      if (response.status !== 0) {
        throw new PogoFlashSafetyError(
          `The Case bridge stopped safely: ${POGO_FLASH_STATUS[response.status] ?? `status ${response.status}`}.`,
        );
      }
      return response.captured;
    } catch (error) {
      if (
        error instanceof RetryablePogoFlashError ||
        error instanceof PogoFlashSafetyError
      ) {
        throw error;
      }
      throw new RetryablePogoFlashError(error?.message ?? String(error));
    }
  }

  drainInput() {
    this.bridge?.clear();
  }

  async stressHostReceive(payloadSize = 1) {
    if (
      !this.active ||
      !this.bridge ||
      !Number.isInteger(payloadSize) ||
      payloadSize < 1 ||
      payloadSize > 1009
    ) {
      throw new PogoFlashSafetyError(
        "The Case host-only keepalive requires an active bridge and 1–1,009 bytes.",
      );
    }
    this.sequence = (this.sequence + 1) & 0xff;
    const payload = new Uint8Array(payloadSize);
    await this.writeTokenPacedRequest({
      header: makePogoFlashHostStressHeader(this.sequence, payload.length),
      payload,
      checksumByte: 0,
      headerTokenLabel: "host-only keepalive header token",
      chunkTokenLabel: () => "host-only keepalive payload token",
      headerRejectionMessage:
        "The flash bridge rejected the host-only keepalive header.",
      chunkRejectionMessage: () =>
        "The flash bridge did not consume the host-only keepalive payload.",
    });
    const response = await this.readBridgeResponse(8000);
    if (
      response.status !== 0 ||
      response.uartErrors !== 0 ||
      response.captured.length !== 0
    ) {
      throw new RetryablePogoFlashError(
        "The host-only keepalive response was not empty and checksum-valid.",
      );
    }
    this.hostOnlyKeepalives += 1;
  }

  async settleTempleStorage(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new PogoFlashSafetyError("Temple storage settle time is invalid.");
    }
    // Deadline accounting: each keepalive's round trip counts toward the
    // settle instead of stretching it, so a long settle ends when it should.
    const deadline = Date.now() + milliseconds;
    let remaining = milliseconds;
    while (remaining > 5000) {
      await delay(5000);
      // The keepalive protects the host link while the temple digests; it is
      // host-only and never reaches the temple. One transient failure must
      // not abort the DATA transfer this settle is protecting — retry once
      // on a drained line, and only a second consecutive failure surfaces.
      try {
        await this.stressHostReceive(1);
      } catch (error) {
        if (!(error instanceof RetryablePogoFlashError)) throw error;
        this.session.log(
          `One host-only keepalive failed transiently during the storage settle (${error.message}); retrying once on a drained line.`,
          "warn",
        );
        this.drainInput();
        await delay(250);
        await this.stressHostReceive(1);
      }
      remaining = deadline - Date.now();
    }
    if (remaining > 0) await delay(remaining);
  }

  async requestExit() {
    if (!this.active || !this.bridge) return null;
    this.sequence = (this.sequence + 1) & 0xff;
    await writePogoFlashTransactionHeader(
      this.bridge,
      makePogoFlashTransactionHeader(this.sequence, 0),
    );
    const response = await this.readBridgeResponse(10000);
    if (
      response.status !== 0 ||
      response.uartErrors !== 0 ||
      response.captured.length !== 10
    ) {
      throw new PogoFlashSafetyError(
        `The bridge exit did not return a restored route (status=${response.status}, errors=${response.uartErrors}, bytes=${response.captured.length}).`,
      );
    }
    this.active = false;
    return response.captured;
  }

  async verifyAndClearRetainedResult() {
    const zeroProof = new Uint8Array(POGO_FLASH_PROOF.length);
    const zeroResult = new Uint8Array(POGO_FLASH_RESULT_LENGTH);
    let validationError = null;
    try {
      // Bounded like openProbeLoader's ROM re-entry. This runs in the
      // mandatory teardown of every route: a single CH340/boot-select glitch
      // here used to mark a fully verified transfer failed_or_uncertain, so
      // the proof-read must tolerate the same transient re-entry flakiness
      // enterRomLoader already retries for.
      this.loader = await retryReadOnlyBlock(
        async () => {
          const candidate = new Stm32Bootloader(this.port, this.session.log);
          try {
            await candidate.connect();
            requireReviewedCaseRom(candidate);
            return candidate;
          } catch (error) {
            await candidate.close();
            throw error;
          }
        },
        async () => delay(400),
        {
          attempts: 3,
          onRetry: (error, attempt) =>
            this.session.log(
              `${this.route}: retained-proof loader synchronization retry ${attempt}/2 after ${error.message}`,
              "warn",
            ),
        },
      );
      const proof = await this.loader.readRange(
        POGO_FLASH_PROOF_ADDRESS,
        POGO_FLASH_PROOF.length,
      );
      const result = await this.loader.readRange(
        POGO_FLASH_RESULT_ADDRESS,
        POGO_FLASH_RESULT_LENGTH,
      );
      try {
        this.retainedResult = decodePogoFlashRetainedResult(result);
        const retainedResult = parsePogoFlashRetainedResult(
          result,
          proof,
          this.route,
          this.sequence,
          {
            expectedAcceptedSize: this.completedTransfer?.payloadBytes ?? null,
            expectedOtaSequence: this.completedTransfer?.records ?? null,
            yhmProfile: this.yhmProfile,
          },
        );
        this.retainedResult = retainedResult;
      } catch (error) {
        const hostTimeoutRestoration =
          verifyPogoFlashHostTimeoutRestoration(
            result,
            proof,
            this.route,
            this.yhmProfile,
          );
        const phaseStop =
          hostTimeoutRestoration === null
            ? verifyPogoFlashOppositePhaseStop(
                result,
                proof,
                this.route,
                this.yhmProfile,
              )
            : null;
        const setupStop =
          hostTimeoutRestoration === null && phaseStop === null
            ? verifyPogoFlashZeroWriteSetupStop(
                result,
                proof,
                this.route,
                this.yhmProfile,
              )
            : null;
        if (hostTimeoutRestoration) {
          this.retainedResult = hostTimeoutRestoration;
          this.restoreVerified = true;
          this.session.log(
            `${this.route}: the retained host-timeout record proves exact byte-for-byte route restoration after ${hostTimeoutRestoration.acceptedSize.toLocaleString("en-US")} accepted firmware bytes; no temple record will be replayed.`,
            "warn",
          );
        } else if (phaseStop) {
          this.retainedResult = phaseStop;
          this.setupPhaseStopVerified = true;
          this.restoreVerified = true;
          this.session.log(
            `${this.route}: verified a zero-write setup stop in the ${phaseStop.phaseCompatibleRoute}-compatible allowlisted Case phase.`,
            "warn",
          );
        } else if (setupStop) {
          this.retainedResult = setupStop;
          this.setupPhaseStopVerified = true;
          this.restoreVerified = true;
          if (
            setupStop.baselineProfile &&
            setupStop.baselineProfile !== this.yhmProfile
          ) {
            this.session.rememberRouteYhmProfile(
              this.route,
              setupStop.baselineProfile,
            );
            this.session.log(
              `${this.route}: exact zero-write evidence identified YHM profile ${setupStop.baselineProfile}; the next bounded fresh setup will use its separately hash-pinned bridge.`,
              "warn",
            );
          }
          this.session.log(
            `${this.route}: verified an exact zero-write setup stop before YHM route selection; baseline ${setupStop.baselineHex} remains outside the mutation allowlist.`,
            "warn",
          );
        } else {
          validationError = error;
        }
      }
      if (this.retainedResult) {
        const diagnosticLevel =
          this.retainedResult.status === 0 ? undefined : "warn";
        this.session.log(
          `${this.route}: retained route diagnostics · profile=${this.yhmProfile}, status=${this.retainedResult.status}, progress=${this.retainedResult.progress}, sequence=${this.retainedResult.sequenceValue}, masks=${this.retainedResult.baselineMask.toString(16)}/${this.retainedResult.selectedMask.toString(16)}/${this.retainedResult.restoredMask.toString(16)}, writeMask=0x${this.retainedResult.writeMask.toString(16)}, otaState=${this.retainedResult.otaState}, expectedOtaSequence=${this.retainedResult.expectedSequence}, declared=${this.retainedResult.declaredSize}, accepted=${this.retainedResult.acceptedSize}, templeTx/Rx=${this.retainedResult.templeTxCount}/${this.retainedResult.templeRxCount}, templeUartErrors=0x${this.retainedResult.templeUartErrors.toString(16)}.`,
          diagnosticLevel,
        );
        this.session.log(
          `${this.route}: retained host diagnostics · txRecoveries=${this.retainedResult.hostTxRecoveries}, txAborts=${this.retainedResult.hostTxAborts}, lastIsr=0x${this.retainedResult.hostTxLastIsr.toString(16).padStart(8, "0")}, rxTimeouts=${this.retainedResult.hostRxTimeouts}, rxErrors=${this.retainedResult.hostRxErrors}, tcTimeouts=${this.retainedResult.hostTcTimeouts}, stage=${this.retainedResult.hostStage}, chunkOffset=${this.retainedResult.hostChunkOffset}; baseline=${compactHex(this.retainedResult.baseline)}, selected=${compactHex(this.retainedResult.selected)}, restored=${compactHex(this.retainedResult.restored)}.`,
          diagnosticLevel,
        );
      }

      await this.loader.writeRange(POGO_FLASH_PROOF_ADDRESS, zeroProof);
      await this.loader.writeRange(POGO_FLASH_RESULT_ADDRESS, zeroResult);
      const proofCheck = await this.loader.readRange(
        POGO_FLASH_PROOF_ADDRESS,
        zeroProof.length,
      );
      const resultCheck = await this.loader.readRange(
        POGO_FLASH_RESULT_ADDRESS,
        zeroResult.length,
      );
      if (!equalBytes(proofCheck, zeroProof) || !equalBytes(resultCheck, zeroResult)) {
        throw new PogoFlashSafetyError(
          "The volatile flash bridge proof/result could not be cleared.",
        );
      }
      if (validationError) throw validationError;
      this.restoreVerified = true;
    } finally {
      await this.closeTransport("loader");
    }
  }

  async close() {
    if (this.closed) {
      if (!this.restoreVerified || !this.caseReport) {
        throw new PogoFlashSafetyError(
          "The flash bridge cleanup did not previously complete.",
        );
      }
      return;
    }
    this.closed = true;
    const errors = [];
    let bridgeExitError = null;
    if (this.bridge) {
      try {
        await this.requestExit();
      } catch (error) {
        bridgeExitError = error;
      }
      await this.closeTransport("bridge");
    }
    await this.closeTransport("loader");
    await delay(350);

    if (this.bridgeLaunched) {
      try {
        await this.verifyAndClearRetainedResult();
      } catch (error) {
        errors.push(`retained route-restoration proof: ${error.message}`);
      }
    }
    if (bridgeExitError) {
      if (this.restoreVerified) {
        this.session.log(
          `${this.route}: ignored the incomplete live EXIT reply because immutable-ROM readback proved the route was already restored byte-for-byte.`,
          "warn",
        );
      } else {
        errors.push(`bridge exit: ${bridgeExitError.message}`);
      }
    }
    try {
      this.caseReport = await this.session.restoreNormal({
        requireVersion: true,
        expectedVersion: REVIEWED_CASE_VERSION,
      });
    } catch (error) {
      errors.push(`Case application return: ${error.message}`);
    }
    if (errors.length) {
      throw new PogoFlashSafetyError(errors.join("; "));
    }
  }
}

export class G2CaseSession {
  constructor(
    port,
    {
      log = () => {},
      progress = () => {},
      openNormal = openNormalConsole,
      wait = delay,
    } = {},
  ) {
    this.port = port;
    this.log = log;
    this.progress = progress;
    this.openNormal = openNormal;
    this.wait = wait;
    this.routeYhmProfiles = new Map();
    // Set once the Case has been analyzed so per-device records (pacing
    // memory, audit fingerprints) attach to the right physical unit.
    this.deviceKey = PACING_UNKNOWN_DEVICE_KEY;
    this.caseStorageSerial = null;
  }

  // Narrate long settles the way the postflight window narrates its wait:
  // the settle ladder holds the Case deliberately untouched for up to 300 s
  // per rung, and one log line followed by minutes of silence reads as a
  // hang at exactly the moment the operator must not pull the cable. The
  // heartbeat runs on wall-clock time beside the single this.wait call, so
  // injected test waits observe the identical call sequence.
  async waitNarrated(milliseconds, narrate) {
    if (
      !Number.isFinite(milliseconds) ||
      milliseconds <= POGO_POSTFLIGHT_HEARTBEAT_MS ||
      typeof narrate !== "function"
    ) {
      return this.wait(milliseconds);
    }
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const remainingSeconds = Math.max(
        0,
        Math.round(milliseconds / 1000 - elapsedSeconds),
      );
      narrate(elapsedSeconds, remainingSeconds);
    }, POGO_POSTFLIGHT_HEARTBEAT_MS);
    try {
      return await this.wait(milliseconds);
    } finally {
      clearInterval(heartbeat);
    }
  }

  // Called once telemetry identifies the exact case. Seeds this session's
  // per-route YHM profile map from the profiles proven for this case in
  // earlier sessions, but never overrides a profile this session has already
  // established from live evidence.
  //
  // Keyed on caseDeviceKey so YHM memory files under the same identity as
  // pacing memory and device history. Before that it keyed on the raw console
  // serial, which is only ever printed in the Case power-up banner: a capture
  // that missed or corrupted the banner silently filed the same physical Case
  // under a second, memory-less identity, and the next session re-derived every
  // observed profile from scratch. The "unidentified-case" placeholder is
  // deliberately excluded - seeding from a bucket shared by every anonymous
  // Case would make the log line below untrue, and the profile is only ever a
  // starting hint that live evidence still has to confirm.
  adoptCaseIdentity(consoleReport) {
    const report =
      typeof consoleReport === "string"
        ? { serialNumber: consoleReport }
        : consoleReport;
    const deviceKey = caseDeviceKey({ console: report ?? {} });
    if (!deviceKey || deviceKey === PACING_UNKNOWN_DEVICE_KEY) return;
    if (this.caseStorageSerial === deviceKey) return;
    this.caseStorageSerial = deviceKey;
    this.deviceKey = deviceKey;
    let remembered = readYhmRouteProfileMemory(deviceKey);
    // Records written before this keyed on the bare console serial. Carry them
    // forward on first sight rather than making every already-serviced Case
    // re-derive its observed profile.
    const legacyKey = report?.serialNumber;
    if (
      !Object.keys(remembered).length &&
      typeof legacyKey === "string" &&
      legacyKey &&
      legacyKey !== deviceKey
    ) {
      const legacy = readYhmRouteProfileMemory(legacyKey);
      for (const [route, profile] of Object.entries(legacy)) {
        writeYhmRouteProfileMemory(deviceKey, route, profile);
      }
      remembered = legacy;
    }
    for (const [route, profile] of Object.entries(remembered)) {
      if (this.routeYhmProfiles.has(route)) continue;
      this.routeYhmProfiles.set(route, profile);
      this.log(
        `${route}: starting with YHM profile ${profile}, proven for this exact Case in an earlier session.`,
      );
    }
  }

  rememberRouteYhmProfile(route, profile) {
    this.routeYhmProfiles.set(route, profile);
    if (this.caseStorageSerial) {
      writeYhmRouteProfileMemory(this.caseStorageSerial, route, profile);
    }
  }

  // One read-only factory-console pass: open (which resets the Case and makes
  // it reprint its power-up banner), collect the banner, then run the A0/A2/A3/A4
  // query allowlist. Writes nothing.
  async captureConsoleReport() {
    const normal = await openNormalConsole(this.port);
    let bootText;
    const replies = {};
    try {
      bootText = new TextDecoder().decode(await normal.collectFor(2500));
      for (const command of [0xa0, 0xa2, 0xa3, 0xa4]) {
        replies[command] = await queryNormal(normal, command);
      }
    } finally {
      await normal.close();
    }
    return parseConsoleReport(
      bootText,
      replies[0xa0],
      replies[0xa2],
      replies[0xa3],
      replies[0xa4],
    );
  }

  async analyze({ progressBase = 0, progressSpan = 1 } = {}) {
    const reportProgress = (fraction, detail) =>
      this.progress(progressBase + fraction * progressSpan, detail);
    const info = this.port.getInfo?.() ?? {};
    this.log("Opening the 1 Mbaud read-only factory console.");
    let consoleReport = await this.captureConsoleReport();
    // The 96-bit Case UID is printed once, in the power-up banner that the
    // console open provokes; none of the A0/A2/A3/A4 replies repeat it. The
    // first bytes after that reset are the least reliable ones on the link -
    // over the remote-support relay they routinely arrive as mojibake - so a
    // missing serial is far more often a clipped banner than a Case that has
    // none. One extra read-only capture costs a few seconds and keeps the
    // device key stable across sessions instead of splitting one physical Case
    // between its real identity and the anonymous placeholder.
    if (!consoleReport.serialNumber) {
      this.log(
        "The power-up banner arrived without a readable Case identifier; repeating the read-only console capture once before filing this session's per-Case records.",
        "warn",
      );
      const retry = await this.captureConsoleReport();
      if (retry.serialNumber) {
        consoleReport = {
          ...consoleReport,
          text: `${consoleReport.text}\n${retry.text}`,
          serialNumber: retry.serialNumber,
          identifier: consoleReport.identifier ?? retry.identifier,
        };
        this.log(
          "The repeated capture recovered the Case identifier; per-Case pacing and YHM profile memory apply to this session.",
        );
      } else {
        this.log(
          "The repeated capture also reported no Case identifier; this session's per-Case memory stays disabled rather than sharing an anonymous record.",
          "warn",
        );
      }
    }
    reportProgress(0.32, "Factory telemetry captured");
    this.log("Factory telemetry and identifiers captured.");
    this.adoptCaseIdentity(consoleReport);

    const loader = new Stm32Bootloader(this.port, this.log);
    try {
      this.log("Entering the immutable STM32 ROM loader for bank inspection.");
      await loader.connect();
      reportProgress(0.42, "ROM loader identified");
      const optionBytes = await loader.readRange(OPTION_BASE, OPTION_SIZE);
      const options = decodeOptionBytes(optionBytes);
      const activeHead = await loader.readRange(FLASH_BASE, 0x4000, (fraction) =>
        reportProgress(0.45 + fraction * 0.18, "Reading active bank"),
      );
      const inactiveHead = await loader.readRange(
        FLASH_BASE + BANK_SIZE,
        0x4000,
        (fraction) =>
          reportProgress(0.63 + fraction * 0.18, "Reading inactive bank"),
      );
      return {
        usb: {
          vendorId: info.usbVendorId ?? null,
          productId: info.usbProductId ?? null,
          transport: g2CaseTransportLabel(this.port),
          bridgeRevision:
            this.port?.transportKind === "webusb" &&
            Number.isInteger(this.port?.version)
              ? this.port.version
              : null,
        },
        console: consoleReport,
        rom: {
          protocolVersion: loader.version,
          productId: loader.productId,
          commands: loader.commands,
        },
        options,
        optionBytes,
        banks: {
          active: {
            aliasAddress: FLASH_BASE,
            physicalBank: options.activePhysicalBank,
            version: detectCaseVersion(activeHead),
            vectorValid: isPlausibleCaseImage(activeHead),
          },
          inactive: {
            aliasAddress: FLASH_BASE + BANK_SIZE,
            physicalBank: options.inactivePhysicalBank,
            version: detectCaseVersion(inactiveHead),
            vectorValid: isPlausibleCaseImage(inactiveHead),
          },
        },
      };
    } finally {
      await loader.close();
      await this.restoreNormal();
      reportProgress(1, "Analysis complete");
    }
  }

  async restoreNormal({ requireVersion = false, expectedVersion = null } = {}) {
    try {
      const normal = await openNormalConsole(this.port);
      let text;
      try {
        text = new TextDecoder().decode(
          await normal.collectFor(requireVersion ? 5000 : 900),
        );
      } finally {
        await normal.close();
      }
      const report = parseConsoleReport(text);
      if (requireVersion && !report.caseVersion) {
        throw new Error("The normal B200 application banner was not observed.");
      }
      if (expectedVersion && report.caseVersion !== expectedVersion) {
        throw new Error(
          `The Case returned firmware ${report.caseVersion ?? "unknown"}, expected ${expectedVersion}.`,
        );
      }
      this.log(
        `Case returned to its normal application${report.caseVersion ? ` · B200 ${report.caseVersion}` : ""}.`,
      );
      return report;
    } catch (error) {
      this.log(`Normal-application return was not confirmed: ${error.message}`, "warn");
      if (requireVersion) throw error;
      return null;
    }
  }

  async backup({ progressBase = 0, progressSpan = 1 } = {}) {
    const reportProgress = (fraction, detail) =>
      this.progress(progressBase + fraction * progressSpan, detail);
    const loader = new Stm32Bootloader(this.port, this.log);
    try {
      this.log("Starting a read-only 512 KiB Case backup.");
      await loader.connect();
      const flash = await loader.readRange(FLASH_BASE, FLASH_SIZE, (fraction) =>
        reportProgress(
          fraction * 0.96,
          `Backing up Case · ${Math.round(fraction * 100)}%`,
        ),
      );
      const optionBytes = await loader.readRange(OPTION_BASE, OPTION_SIZE);
      const flashSha256 = await sha256Hex(flash);
      const optionSha256 = await sha256Hex(optionBytes);
      reportProgress(1, "Case backup verified");
      this.log(`Case backup verified · ${flashSha256.slice(0, 16)}…`);
      return { flash, optionBytes, flashSha256, optionSha256 };
    } finally {
      await loader.close();
      await this.restoreNormal();
    }
  }

  async readPostResetCaseTelemetry(attempts = 3) {
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new Error("Post-reset telemetry attempts must be a positive integer.");
    }
    const errors = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let normal = null;
      try {
        normal = await this.openNormal(this.port);
        const boot = new TextDecoder().decode(await normal.collectFor(2500));
        const version = await queryNormal(normal, 0xa0, 900);
        const telemetry = await queryNormal(normal, 0xa3, 1000);
        const report = parseConsoleReport(boot, version, telemetry);
        if (report.caseVersion !== REVIEWED_CASE_VERSION) {
          throw new Error(
            `the Case returned firmware ${report.caseVersion ?? "unknown"}, expected ${REVIEWED_CASE_VERSION}`,
          );
        }
        if (!report.telemetry) {
          throw new Error("fresh GLS_L/GLS_R telemetry was not observed");
        }
        return {
          ...report,
          postResetTelemetrySession: "reopened",
          postResetTelemetryAttempt: attempt,
        };
      } catch (error) {
        errors.push(`attempt ${attempt}: ${error.message}`);
        this.log(
          `Post-reset Case-console attempt ${attempt}/${attempts} did not return complete telemetry: ${error.message}`,
          "warn",
        );
      } finally {
        if (normal) await normal.close();
      }
      if (attempt !== attempts) await this.wait(500);
    }
    throw new Error(
      `Fresh Case telemetry did not return after ${attempts} reopened serial sessions (${errors.join("; ")}).`,
    );
  }

  async confirmCaseFirmwareVersion(expectedVersion, attempts = 3) {
    if (!expectedVersion) {
      throw new Error("An expected Case firmware version is required.");
    }
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new Error(
        "Case firmware confirmation attempts must be a positive integer.",
      );
    }

    const observations = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let normal = null;
      try {
        this.log(
          `Opening fresh Case console ${attempt}/${attempts} for explicit DEA0 firmware confirmation.`,
        );
        normal = await this.openNormal(this.port);
        const boot = new TextDecoder().decode(await normal.collectFor(2500));
        const versionReply = await queryNormal(normal, 0xa0, 1000);
        const report = parseConsoleReport(boot, versionReply);
        const dea0Report = parseConsoleReport(versionReply);
        const confirmedVersion = dea0Report.caseVersion;
        observations.push(
          `DEA0 ${confirmedVersion ?? "unknown"}${report.caseVersion && report.caseVersion !== confirmedVersion ? ` (banner ${report.caseVersion})` : ""}`,
        );
        if (confirmedVersion === expectedVersion) {
          this.log(
            `Fresh DEA0 confirmation passed · Charging Case ${expectedVersion} · attempt ${attempt}/${attempts}.`,
            "success",
          );
          return {
            ...report,
            expectedVersion,
            confirmedVersion,
            confirmationCommand: "DEA0",
            confirmationAttempt: attempt,
            confirmationAttempts: attempts,
            confirmedAt: new Date().toISOString(),
          };
        }
        this.log(
          `Fresh DEA0 confirmation attempt ${attempt}/${attempts} reported Case ${confirmedVersion ?? "unknown"}, expected ${expectedVersion}.`,
          "warn",
        );
      } catch (error) {
        observations.push(`error: ${error.message}`);
        this.log(
          `Fresh DEA0 confirmation attempt ${attempt}/${attempts} failed: ${error.message}`,
          "warn",
        );
      } finally {
        if (normal) await normal.close();
      }
      if (attempt !== attempts) await this.wait(750 * attempt);
    }

    throw new PogoFlashSafetyError(
      `Charging Case ${expectedVersion} was not confirmed by ${attempts} fresh DEA0 sessions (${observations.join("; ")}). Smart Glasses flashing was not started.`,
    );
  }

  async restartAndRecheck() {
    this.log("Starting the traced stock reset for both seated G2 temples.");
    const normal = await this.openNormal(this.port);
    let boot;
    let resetOutput;
    try {
      boot = new TextDecoder().decode(await normal.collectFor(3000));
      resetOutput = await resetTemples(normal);
      this.log("The Case confirmed its left/right hardware reset sequence.");
    } finally {
      await normal.close();
    }
    this.log(
      "Reset confirmation captured; reopening the Case console for fresh post-reset telemetry.",
    );
    await this.wait(6500);
    const telemetryReport = await this.readPostResetCaseTelemetry();
    const resetReport = parseConsoleReport(boot, resetOutput);
    return {
      ...resetReport,
      ...telemetryReport,
      text: [resetReport.text, telemetryReport.text].filter(Boolean).join("\n"),
      serialNumber: telemetryReport.serialNumber ?? resetReport.serialNumber,
      identifier: telemetryReport.identifier ?? resetReport.identifier,
      resetConfirmed: true,
      resetConfirmationSession: "pre-restart",
    };
  }

  async probeRunningTemple(
    operation,
    route,
    options = {},
  ) {
    const attempts = [];
    const maximumAttempts = POGO_READ_ONLY_PHASE_SETTLE_MS.length + 2;
    let settleIndex = 0;
    let yhmProfile =
      options.yhmProfile ??
      this.routeYhmProfiles.get(route) ??
      YHM_PROFILE_REVIEWED_22;
    requireYhmProfile(yhmProfile);
    const attemptedProfiles = new Set();
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      attemptedProfiles.add(yhmProfile);
      try {
        const result = await this.probeRunningTempleOnce(operation, route, {
          ...options,
          yhmProfile,
        });
        this.rememberRouteYhmProfile(route, yhmProfile);
        return result;
      } catch (error) {
        const evidence = error?.pogoBridgeEvidence;
        const verifiedZeroWriteStop =
          evidence?.zeroWriteBaselineStopVerified === true;
        // Status 6 is thrown only after the route restoration proof was
        // verified byte-for-byte: the request went out, the temple stayed
        // silent, and every YHM register was restored. During the post-reset
        // charging renegotiation this is as safe to settle-retry as a
        // zero-write setup stop.
        const restoredSilentTempleStop = evidence?.responseStatus === 6;
        attempts.push({
          attempt,
          outcome: "failed",
          error: error instanceof Error ? error.message : String(error),
          baseline: evidence?.baselineHex ?? null,
          yhmProfile,
          zeroYhmWritesVerified: verifiedZeroWriteStop,
          templeBytesTransmitted: evidence?.transmitted ?? null,
        });
        if (!verifiedZeroWriteStop && !restoredSilentTempleStop) {
          if (error && typeof error === "object") {
            error.readOnlyPhaseAttempts = attempts;
          }
          throw error;
        }
        const observedProfile = verifiedZeroWriteStop
          ? identifyYhmBaselineProfile(evidence.baselineHex)
          : null;
        if (
          observedProfile &&
          observedProfile !== yhmProfile &&
          !attemptedProfiles.has(observedProfile)
        ) {
          const readiness = await this.readTempleFlashPreflight([route]);
          this.log(
            `${route} ${operation}: exact retained zero-write evidence maps baseline ${evidence.baselineHex} to YHM profile ${observedProfile}; Case ${readiness.caseVersion} and seated contact were re-confirmed before retrying read-only liveness with its separately hash-pinned bridge.`,
            "warn",
          );
          yhmProfile = observedProfile;
          this.rememberRouteYhmProfile(route, yhmProfile);
          continue;
        }
        if (settleIndex === POGO_READ_ONLY_PHASE_SETTLE_MS.length) {
          const baselines = attempts
            .map(({ baseline }) => baseline)
            .filter(Boolean)
            .join(", ");
          const finalError = new PogoFlashSafetyError(
            restoredSilentTempleStop
              ? `The pogo bridge stopped safely: the ${route} temple returned no framed response after ${attempts.length} fully-restored probes across the bounded settle ladder. The route was byte-for-byte restored each time.`
              : `The pogo bridge stopped safely: YHM baseline was not an allowlisted seated-idle state after ${attempts.length} verified zero-write probes${baselines ? ` (${baselines})` : ""}. No YHM writes or temple transmissions occurred.`,
          );
          finalError.pogoBridgeEvidence = evidence;
          finalError.readOnlyPhaseAttempts = attempts;
          throw finalError;
        }
        const settleMilliseconds =
          POGO_READ_ONLY_PHASE_SETTLE_MS[settleIndex];
        settleIndex += 1;
        const settleSeconds = settleMilliseconds / 1000;
        this.log(
          restoredSilentTempleStop
            ? `${route} ${operation}: the temple stayed silent through a fully-restored route (bridge status 6), consistent with post-reset charging renegotiation. Leaving the normal Case app undisturbed for ${settleSeconds} seconds before bounded stock-app settle ${settleIndex}/${POGO_READ_ONLY_PHASE_SETTLE_MS.length}.`
            : `${route} ${operation}: YHM baseline ${evidence.baselineHex} is outside the active seated-idle profile; retained SRAM proves zero YHM writes and zero temple bytes. Leaving the normal Case app undisturbed for ${settleSeconds} seconds before bounded stock-app settle ${settleIndex}/${POGO_READ_ONLY_PHASE_SETTLE_MS.length}.`,
          "warn",
        );
        await this.waitNarrated(settleMilliseconds, (elapsed, remaining) =>
          this.log(
            `${route} ${operation}: still settling · ${elapsed} s elapsed, ${remaining} s remaining in this bounded stock-app settle. The Case is deliberately untouched; do not disconnect.`,
          ),
        );
        // Bounded so one transient console failure cannot discard the settle
        // this rung just spent minutes earning.
        const readiness = await retryReadOnlyBlock(
          () => this.readTempleFlashPreflight([route]),
          async () => this.wait(1200),
          {
            attempts: 2,
            onRetry: (error) =>
              this.log(
                `${route} ${operation}: the post-settle contact re-check failed transiently (${error.message}); one bounded retry follows so the completed ${settleSeconds}-second settle is not discarded.`,
                "warn",
              ),
          },
        );
        this.log(
          `${route} ${operation}: Case ${readiness.caseVersion} and seated contact re-confirmed after the ${settleSeconds}-second stock-app settle.`,
        );
      }
    }
    throw new Error("The bounded read-only temple retry loop ended unexpectedly.");
  }

  async probeRunningTempleOnce(
    operation,
    route,
    {
      progressBase = 0,
      progressSpan = 1,
      yhmProfile = YHM_PROFILE_REVIEWED_22,
    } = {},
  ) {
    const reportProgress = (fraction, detail) =>
      this.progress(progressBase + fraction * progressSpan, detail);
    if (!["status", "version"].includes(operation)) {
      throw new Error("The reviewed pogo bridge permits only status or version.");
    }
    if (!["left", "right"].includes(route)) {
      throw new Error("Select the left or right temple route.");
    }

    requireYhmProfile(yhmProfile);
    const payload = await getVerifiedPogoBridgePayload(yhmProfile);
    const bridgeSha256 =
      POGO_BRIDGE_PROFILE_SHA256[yhmProfile] ?? (await sha256Hex(payload));
    const zeroProof = new Uint8Array(POGO_BRIDGE_PROOF.length);
    const zeroResult = new Uint8Array(POGO_BRIDGE_RESULT_LENGTH);
    let loader = null;
    let bridge = null;
    let bridgeLoaded = false;
    let residueCleared = false;
    let templeQueried = false;

    const openProbeLoader = async (purpose) =>
      retryReadOnlyBlock(
        async () => {
          const candidate = new Stm32Bootloader(this.port, this.log);
          try {
            await candidate.connect();
            return candidate;
          } catch (error) {
            await candidate.close();
            throw error;
          }
        },
        async () => this.wait(400),
        {
          attempts: 3,
          onRetry: (error, attempt) =>
            this.log(
              `${purpose} loader synchronization retry ${attempt}/2 after ${error.message}`,
              "warn",
            ),
        },
      );

    const closeOpenTransports = async () => {
      if (bridge) {
        try {
          await bridge.close();
        } catch (error) {
          this.log(`Bridge transport close was not confirmed: ${error.message}`, "warn");
        } finally {
          bridge = null;
        }
      }
      if (loader) {
        try {
          await loader.close();
        } catch (error) {
          this.log(`ROM-loader transport close was not confirmed: ${error.message}`, "warn");
        } finally {
          loader = null;
        }
      }
    };

    const clearRetainedBridgeData = async () => {
      const cleanupLoader = await openProbeLoader("Pogo cleanup");
      try {
        await cleanupLoader.writeRange(POGO_BRIDGE_PROOF_ADDRESS, zeroProof);
        await cleanupLoader.writeRange(POGO_BRIDGE_RESULT_ADDRESS, zeroResult);
        const proofCheck = await cleanupLoader.readRange(
          POGO_BRIDGE_PROOF_ADDRESS,
          zeroProof.length,
        );
        const resultCheck = await cleanupLoader.readRange(
          POGO_BRIDGE_RESULT_ADDRESS,
          zeroResult.length,
        );
        if (!equalBytes(proofCheck, zeroProof) || !equalBytes(resultCheck, zeroResult)) {
          throw new Error("The volatile pogo bridge proof/result could not be cleared.");
        }
        residueCleared = true;
      } finally {
        await cleanupLoader.close();
      }
    };

    try {
      this.log(
        `Loading the pinned read-only pogo bridge for ${route} ${operation} · YHM profile ${yhmProfile} · ${bridgeSha256.slice(0, 16)}….`,
      );
      loader = await openProbeLoader(`${route} ${operation}`);
      if (loader.version !== 0x31) {
        throw new Error(
          `Unexpected STM32 ROM protocol 0x${loader.version.toString(16)} for the reviewed bridge.`,
        );
      }
      for (const [command, label] of [
        [READ_MEMORY, "Read Memory"],
        [GO, "Go"],
        [WRITE_MEMORY, "Write Memory"],
      ]) {
        loader.requireCommand(command, label);
      }

      await loader.writeRange(POGO_BRIDGE_PROOF_ADDRESS, zeroProof);
      await loader.writeRange(POGO_BRIDGE_RESULT_ADDRESS, zeroResult);
      for (let offset = 0; offset < payload.length; offset += 256) {
        const chunk = payload.subarray(offset, Math.min(offset + 256, payload.length));
        const address = POGO_BRIDGE_ADDRESS + offset;
        await loader.writeRange(address, chunk);
        const readback = await loader.readRange(address, chunk.length);
        if (!equalBytes(readback, chunk)) {
          throw new Error(
            `The volatile bridge readback differs at 0x${address.toString(16)}.`,
          );
        }
        reportProgress(
          0.1 + ((offset + chunk.length) / payload.length) * 0.42,
          "Verifying volatile read-only bridge",
        );
      }
      bridgeLoaded = true;
      this.log(`Verified all ${payload.length} pinned SRAM bridge bytes.`);

      const { goAckLost } = await loader.goWithLostAckRecovery(
        POGO_BRIDGE_ADDRESS,
      );
      // Both pinned bridges deliberately retain the ROM loader's 115200 8E1
      // host framing. Keep one Web Serial session so CH340 close/open control
      // transitions cannot reset the Case between GO and the bridge banner.
      await loader.releaseBootSelection();
      bridge = loader.takeTransport();
      loader = null;

      const banner = await bridge.readExact(
        POGO_BRIDGE_BANNER.length,
        goAckLost ? 6000 : 3000,
        "pogo bridge banner",
      );
      if (!equalBytes(banner, POGO_BRIDGE_BANNER)) {
        throw new Error("The volatile pogo bridge banner is invalid.");
      }
      if (goAckLost) {
        this.log(
          `${route} ${operation}: the verified bridge banner arrived after the lost Go ACK, proving the launch; continuing normally.`,
          "warn",
        );
      }
      const request = makePogoBridgeRequest(operation, route);
      templeQueried = true;
      await bridge.write(request);
      const header = await bridge.readExact(12, 5000, "pogo bridge response header");
      const capturedLength = header[9];
      if (capturedLength > 64) {
        throw new Error("The pogo bridge declared an invalid capture length.");
      }
      const tail = await bridge.readExact(
        capturedLength + 1,
        3000,
        "pogo bridge response payload",
      );
      const response = parsePogoBridgeResponse(header, tail, request);
      await bridge.close();
      bridge = null;
      // The bridge transaction completing is not the same as the temple
      // answering; keep the progress label and log honest about the status
      // the bridge actually reported.
      if (response.status === 0) {
        reportProgress(0.66, "Temple response captured");
      } else {
        const statusLabel =
          POGO_BRIDGE_STATUS[response.status] ??
          `unknown bridge status ${response.status}`;
        reportProgress(
          0.66,
          `Bridge result captured · status ${response.status}`,
        );
        this.log(
          `${route} ${operation}: the Case bridge completed its transaction but reported status ${response.status} (${statusLabel}); verifying route restoration before deciding.`,
          "warn",
        );
      }

      await delay(300);
      loader = await openProbeLoader(`${route} restoration proof`);
      const proof = await loader.readRange(
        POGO_BRIDGE_PROOF_ADDRESS,
        POGO_BRIDGE_PROOF.length,
      );
      if (!equalBytes(proof, POGO_BRIDGE_PROOF)) {
        throw new Error("The volatile pogo bridge execution proof was not retained.");
      }
      const retainedResult = await loader.readRange(
        POGO_BRIDGE_RESULT_ADDRESS,
        POGO_BRIDGE_RESULT_LENGTH,
      );
      const transportProof = validatePogoBridgeRetainedResult(
        retainedResult,
        response,
        operation,
        route,
      );
      reportProgress(0.84, "Router restoration proof verified");

      await loader.writeRange(POGO_BRIDGE_PROOF_ADDRESS, zeroProof);
      await loader.writeRange(POGO_BRIDGE_RESULT_ADDRESS, zeroResult);
      const proofCheck = await loader.readRange(
        POGO_BRIDGE_PROOF_ADDRESS,
        zeroProof.length,
      );
      const resultCheck = await loader.readRange(
        POGO_BRIDGE_RESULT_ADDRESS,
        zeroResult.length,
      );
      if (!equalBytes(proofCheck, zeroProof) || !equalBytes(resultCheck, zeroResult)) {
        throw new Error("The volatile pogo bridge proof/result could not be cleared.");
      }
      residueCleared = true;

      if (response.status !== 0) {
        const bridgeError = new Error(
          `The pogo bridge stopped safely: ${POGO_BRIDGE_STATUS[response.status] ?? `status ${response.status}`}.`,
        );
        bridgeError.pogoBridgeEvidence = {
          ...transportProof,
          responseStatus: response.status,
          responseStatusLabel:
            POGO_BRIDGE_STATUS[response.status] ?? "unknown bridge status",
        };
        throw bridgeError;
      }
      const decoded = parseTempleFrame(response.captured, operation);
      this.log(
        `Verified ${route} ${operation} response and byte-for-byte YHM restoration.`,
        "success",
      );
      reportProgress(0.94, "Read-only pogo diagnostics verified");
      return {
        operation,
        route,
        decoded,
        captured: response.captured,
        transportProof,
        yhmProfile,
      };
    } catch (error) {
      // Failures on the Case-side ROM/serial transport before the bridge
      // request ever went out carry no evidence about the temple; tag them
      // so evidence and recovery planning do not misattribute a Case link
      // fault as an unresponsive temple.
      if (!templeQueried && error && typeof error === "object") {
        error.caseTransportFailure = true;
      }
      throw error;
    } finally {
      await closeOpenTransports();
      if (bridgeLoaded && !residueCleared) {
        try {
          await clearRetainedBridgeData();
          this.log("Cleared retained volatile pogo bridge proof after interruption.");
        } catch (cleanupError) {
          this.log(
            `Could not confirm volatile pogo bridge cleanup: ${cleanupError.message}`,
            "warn",
          );
        }
      }
      await this.restoreNormal();
      if (residueCleared) reportProgress(1, "Case application restored");
    }
  }

  async readTempleFlashPreflight(
    routes,
    { requiredCaseVersion = REVIEWED_CASE_VERSION } = {},
  ) {
    this.log("Refreshing Case firmware and seated-temple telemetry before flashing.");
    const normal = await openNormalConsole(this.port);
    try {
      const bootText = new TextDecoder().decode(await normal.collectFor(2500));
      const telemetryText = await queryNormal(normal, 0xa3, 1000);
      const report = parseConsoleReport(bootText, telemetryText);
      if (
        requiredCaseVersion &&
        report.caseVersion !== requiredCaseVersion
      ) {
        throw new PogoFlashSafetyError(
          `The volatile writer is pinned to Case ${requiredCaseVersion}; this Case reports ${report.caseVersion ?? "unknown"}.`,
        );
      }
      if (!report.telemetry) {
        throw new PogoFlashSafetyError(
          "Fresh Case telemetry was not available before the mutating operation.",
        );
      }
      for (const route of routes) {
        const present =
          route === "left"
            ? report.telemetry.leftPresent
            : report.telemetry.rightPresent;
        if (!present) {
          throw new PogoFlashSafetyError(
            `Fresh Case telemetry does not report the ${route} temple as seated.`,
          );
        }
      }
      return report;
    } finally {
      await normal.close();
    }
  }

  async verifyPostResetTempleLiveness(
    resetReport,
    routes,
    {
      expectedVersion = null,
      progressBase = 0.95,
      progressSpan = 0.04,
    } = {},
  ) {
    if (resetReport.caseVersion !== REVIEWED_CASE_VERSION) {
      throw new PogoFlashSafetyError(
        `The final reset returned Case ${resetReport.caseVersion ?? "unknown"}, expected ${REVIEWED_CASE_VERSION}.`,
      );
    }
    if (!resetReport.telemetry) {
      throw new PogoFlashSafetyError(
        "Fresh Case telemetry did not return after the final B0 reset.",
      );
    }
    for (const route of routes) {
      const present =
        route === "left"
          ? resetReport.telemetry.leftPresent
          : resetReport.telemetry.rightPresent;
      if (!present) {
        throw new PogoFlashSafetyError(
          `${route}: contact did not return after the final B0 reset.`,
        );
      }
    }

    const versions = {};
    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index];
      const probe = await this.probeRunningTemple("version", route, {
        progressBase: progressBase + (index / routes.length) * progressSpan,
        progressSpan: progressSpan / routes.length,
      });
      const version = probe.decoded;
      // A bilateral reset in the middle of a cross-version update sees the
      // two temples on different images: one already carries the target, the
      // other still carries the source. Resolve the expectation per route
      // rather than asserting a single version across both.
      const routeExpectedVersion =
        expectedVersion && typeof expectedVersion === "object"
          ? expectedVersion[route] ?? null
          : expectedVersion;
      if (
        version.hardwareRevision !== 5 ||
        (routeExpectedVersion &&
          version.firmwareVersion !== routeExpectedVersion)
      ) {
        const expected = routeExpectedVersion
          ? `${routeExpectedVersion}/hardware 5`
          : "hardware 5";
        throw new PogoFlashSafetyError(
          `${route}: post-reset expected ${expected}, observed ${version.firmwareVersion}/hardware ${version.hardwareRevision}.`,
        );
      }
      versions[route] = {
        firmware: version.firmwareVersion,
        hardware: version.hardwareRevision,
        yhmRestoreVerified: probe.transportProof?.restoredMask === 0x3ff,
      };
    }
    const finalCase = await this.restoreNormal({
      requireVersion: true,
      expectedVersion: REVIEWED_CASE_VERSION,
    });
    return { versions, finalCase };
  }

  async resetAndVerifyTemplesBounded(
    routes,
    {
      expectedVersion = null,
      progressBase = 0.6,
      progressSpan = 0.38,
      purpose = "bilateral reset",
    } = {},
  ) {
    const attempts = [];
    for (let attempt = 1; attempt <= POGO_FINAL_RESET_ATTEMPTS; attempt += 1) {
      try {
        const resetReport = await this.restartAndRecheck();
        const verification = await this.verifyPostResetTempleLiveness(
          resetReport,
          routes,
          { expectedVersion, progressBase, progressSpan },
        );
        attempts.push({ attempt, outcome: "success" });
        if (attempt > 1) {
          this.log(
            `${purpose}: reset, contacts, and liveness passed on bounded attempt ${attempt}/${POGO_FINAL_RESET_ATTEMPTS}.`,
            "success",
          );
        }
        return { resetReport, ...verification, attempts };
      } catch (error) {
        attempts.push({
          attempt,
          outcome: "failed",
          error: error.message,
        });
        if (
          attempt === POGO_FINAL_RESET_ATTEMPTS ||
          !isRetryablePostResetLivenessFailure(error)
        ) {
          error.resetAttempts = attempts;
          throw error;
        }
        this.log(
          `${purpose}: the first reset did not return complete contacts and checksum-valid liveness; issuing one bounded second DEB0 reset.`,
          "warn",
        );
        await this.wait(1500);
      }
    }
    throw new PogoFlashSafetyError(
      "The bounded final reset loop ended unexpectedly.",
    );
  }

  async restartAndVerifyBothTemples({
    expectedVersion = null,
    progressBase = 0.6,
    progressSpan = 0.38,
    purpose = "Standalone verification",
  } = {}) {
    const { resetReport, versions, finalCase, attempts } =
      await this.resetAndVerifyTemplesBounded(
        ["right", "left"],
        {
          expectedVersion,
          progressBase,
          progressSpan,
          purpose,
        },
      );
    this.progress(
      Math.min(1, progressBase + progressSpan),
      "Reset, contacts, and temple liveness verified",
    );
    this.log(
      "B0 reset confirmed; reopened Case telemetry and checksum-valid left/right version replies verified.",
      "success",
    );
    return {
      ...resetReport,
      caseVersion: finalCase.caseVersion,
      versions,
      resetAttempts: attempts,
      applicationLivenessVerified: true,
      firmwareBytesTransmitted: 0,
    };
  }

  async finalizeTempleRestore(routes, expectedVersion) {
    this.log(
      "All selected routes and the Case application are restored; sending the final traced B0 dual-temple reset.",
    );
    this.progress(0.93, "Final dual-temple reset");
    const { resetReport, versions, finalCase, attempts } =
      await this.resetAndVerifyTemplesBounded(
        routes,
        {
          expectedVersion,
          progressBase: 0.95,
          progressSpan: 0.04,
          purpose: "Final bilateral verification",
        },
      );
    this.progress(1, "Final reset and temple liveness verified");
    this.log(
      "Final B0 reset confirmed; selected contacts and checksum-valid post-reset version replies verified.",
      "success",
    );
    return {
      outcome: "success",
      command: "DEB0",
      templeMutation: "traced stock dual-temple reset",
      resetConfirmed: true,
      caseFirmware: finalCase.caseVersion,
      resetConfirmationSession: resetReport.resetConfirmationSession,
      postResetTelemetrySession: resetReport.postResetTelemetrySession,
      postResetTelemetryAttempt: resetReport.postResetTelemetryAttempt,
      leftPresent: resetReport.telemetry.leftPresent,
      rightPresent: resetReport.telemetry.rightPresent,
      versions,
      resetAttempts: attempts,
      versionIsLivenessNotImageProvenance: true,
    };
  }

  // A temple that acknowledged FINISH holds the new image but may still be
  // running the old one. Reset it a bounded number of times and re-probe;
  // this is read-only apart from the traced reset and sends no firmware.
  async resolveDeferredTempleActivation(
    route,
    expectedTargetVersion,
    deferredActivation,
    attempts = POGO_ACTIVATION_RESET_ATTEMPTS,
  ) {
    const activation = { ...deferredActivation, attempts: [] };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        this.log(
          `${route}: activation reset ${attempt}/${attempts} for the committed image.`,
          "warn",
        );
        await this.restartAndRecheck();
        const observed = (await this.probeRunningTemple("version", route))
          .decoded;
        activation.attempts.push({
          attempt,
          firmware: observed.firmwareVersion,
          hardware: observed.hardwareRevision,
        });
        if (
          observed.firmwareVersion === expectedTargetVersion &&
          observed.hardwareRevision === 5
        ) {
          activation.postflightVersion = {
            firmware: observed.firmwareVersion,
            hardware: observed.hardwareRevision,
          };
          activation.resolvedOnAttempt = attempt;
          this.log(
            `${route}: the committed image activated after reset ${attempt}; postflight firmware=${observed.firmwareVersion}, hardware=${observed.hardwareRevision}.`,
            "success",
          );
          return activation;
        }
      } catch (activationError) {
        activation.attempts.push({
          attempt,
          error: activationError.message,
        });
      }
    }
    return activation;
  }

  async resetTempleOtaReceiverForComponentRestart(
    routes,
    expectedVersion,
    route,
    routeIndex,
    routeCount,
    { recoveryReason = "component-restart" } = {},
  ) {
    const progressBase = (routeIndex / routeCount) * 0.9;
    const setupRecovery = recoveryReason === "setup-stop";
    this.log(
      setupRecovery
        ? `${route}: the zero-write setup stop and Case cleanup are fully proven; sending an intermediate bilateral reset before a fresh route setup.`
        : `${route}: cleanup is fully proven; sending an intermediate bilateral reset before one fresh full-component restart.`,
      "warn",
    );
    this.progress(
      progressBase,
      setupRecovery
        ? `${route}: recovery reset before fresh setup`
        : `${route}: recovery reset before full restart`,
    );
    const attempts = [];
    for (
      let attempt = 1;
      attempt <= POGO_INTERMEDIATE_RESET_ATTEMPTS;
      attempt += 1
    ) {
      try {
        // Inside the try like resetAndVerifyTemplesBounded's reset: a "Case
        // did not confirm the traced B0" or missing-telemetry throw from the
        // reset itself is exactly what the bounded second attempt exists for,
        // and letting it escape the loop aborted a component restart that had
        // already proven its cleanup.
        const resetReport = await this.restartAndRecheck();
        const { versions, finalCase } =
          await this.verifyPostResetTempleLiveness(
            resetReport,
            routes,
            {
              expectedVersion,
              progressBase,
              progressSpan: Math.min(0.04, 0.9 / routeCount),
            },
          );
        attempts.push({ attempt, outcome: "success" });
        this.log(
          setupRecovery
            ? `${route}: intermediate reset, contacts, Case application, and temple liveness verified${attempt > 1 ? ` on bounded reset attempt ${attempt}` : ""}; retrying route setup with zero firmware bytes sent.`
            : `${route}: intermediate reset, contacts, Case application, and temple liveness verified${attempt > 1 ? ` on bounded reset attempt ${attempt}` : ""}; restarting from START rather than replaying an ambiguous DATA record.`,
          "success",
        );
        return {
          outcome: "success",
          command: "DEB0",
          resetConfirmed: true,
          resetAttempts: attempts,
          caseFirmware: finalCase.caseVersion,
          leftPresent: resetReport.telemetry.leftPresent,
          rightPresent: resetReport.telemetry.rightPresent,
          versions,
          recoveryReason,
        };
      } catch (error) {
        attempts.push({
          attempt,
          outcome: "failed",
          error: error.message,
        });
        if (
          attempt === POGO_INTERMEDIATE_RESET_ATTEMPTS ||
          !isRetryablePostResetLivenessFailure(error)
        ) {
          error.intermediateResetAttempts = attempts;
          throw error;
        }
        this.log(
          `${route}: the first intermediate reset did not return a complete allowlisted liveness proof; sending one bounded second bilateral reset before deciding whether a fresh setup or START is safe.`,
          "warn",
        );
      }
    }
    throw new PogoFlashSafetyError(
      "The bounded intermediate reset loop ended unexpectedly.",
    );
  }

  async flashPinnedTempleRoute(
    component,
    expectedSourceVersion,
    expectedTargetVersion,
    route,
    routeIndex,
    routeCount,
    dataPacingMultiplier = 1,
  ) {
    if (
      !Number.isInteger(dataPacingMultiplier) ||
      dataPacingMultiplier < 1 ||
      dataPacingMultiplier > 3
    ) {
      throw new PogoFlashSafetyError(
        "Temple DATA pacing multiplier must be one, two, or three.",
      );
    }
    const progressBase = (routeIndex / routeCount) * 0.9;
    const progressSpan = 0.9 / routeCount;
    const transport = new CasePogoFlashTransport(this, route, {
      progressBase,
      progressSpan,
    });
    const bridgeSha256 =
      POGO_FLASH_BRIDGE_PROFILE_SHA256[transport.yhmProfile] ??
      (await sha256Hex(
        await getVerifiedPogoFlashBridgePayload(transport.yhmProfile),
      ));
    const result = {
      route,
      yhmProfile: transport.yhmProfile,
      bridgeSha256,
      outcome: "started",
      preflightVersion: null,
      transfer: null,
      postflightVersion: null,
      caseRestoreVerified: false,
      caseApplicationVersion: null,
      retainedResult: null,
      routePhaseSetupAttempts: 0,
      otaMutationAttempted: false,
      acceptedFirmwareBytes: 0,
      dataPacingPolicy: {
        deferredBatchBytes: POGO_DEFERRED_BATCH_BYTES,
        maximumPacingBatchBytes: POGO_SERIALIZED_BATCH_BYTES,
        multiplier: dataPacingMultiplier,
        mode: "adaptive",
        levels: TEMPLE_DATA_PACING_LEVELS,
        lateThresholdPercent:
          (POGO_DATA_LATE_SETTLE_NUMERATOR /
            POGO_DATA_LATE_SETTLE_DENOMINATOR) *
          100,
        explicitRejectionRetryAllowed: false,
        explicitRejectionAction:
          "cleanup_reset_and_fresh_component_restart",
        hostOnlyKeepaliveIntervalMs: 5000,
      },
    };
    let operationError = null;
    let cleanupError = null;
    let failureStage = "setup";
    let deferredActivation = null;

    try {
      await transport.open();
      result.routePhaseSetupAttempts = transport.routePhaseSetupAttempts;
      failureStage = "PREFLIGHT";
      const preflightFrame = await transport.transact(makeTempleVersionRequest(), 8000);
      const preflight = decodeTempleVersion(preflightFrame);
      result.preflightVersion = preflight;
      if (
        (expectedSourceVersion &&
          preflight.firmware !== expectedSourceVersion) ||
        preflight.hardware !== 5
      ) {
        const expected = expectedSourceVersion ?? "a readable G2 version";
        throw new PogoFlashSafetyError(
          `${route}: expected running firmware ${expected}/hardware 5, observed ${preflight.firmware}/hardware ${preflight.hardware}.`,
        );
      }
      this.log(
        `${route}: preflight firmware=${preflight.firmware}, hardware=${preflight.hardware}.`,
      );

      // Take one just-in-time liveness sample before the first non-idempotent
      // OTA transition. Repeated probes consume the short app-mode route and
      // do not prove that the later mutation will work.
      for (let probe = 2; probe <= POGO_STABILITY_READ_QUERIES; probe += 1) {
        await delay(POGO_STABILITY_INTERVAL_MS);
        try {
          const observed = decodeTempleVersion(
            await transport.transact(makeTempleVersionRequest(), 8000),
          );
          if (
            observed.firmware !== preflight.firmware ||
            observed.hardware !== preflight.hardware
          ) {
            throw new PogoFlashSafetyError(
              `${route}: stability query ${probe}/${POGO_STABILITY_READ_QUERIES} changed from ${preflight.firmware}/hardware ${preflight.hardware} to ${observed.firmware}/hardware ${observed.hardware}.`,
            );
          }
        } catch (error) {
          throw new PogoFlashSafetyError(
            `${route}: stability query ${probe}/${POGO_STABILITY_READ_QUERIES} failed before any OTA command: ${error.message}`,
          );
        }
      }
      result.stabilityPreflight = {
        outcome: "success",
        queries: POGO_STABILITY_READ_QUERIES,
        intervalMs: POGO_STABILITY_INTERVAL_MS,
      };
      this.log(
        `${route}: completed ${POGO_STABILITY_READ_QUERIES} fresh read-only liveness query.`,
      );
      await delay(250);
      transport.drainInput();

      // Start and header mutate OTA state and are intentionally never replayed.
      failureStage = "START";
      const start = makeOtaStartRequest();
      result.otaMutationAttempted = true;
      requireOtaAcknowledgement(await transport.transact(start, 8000), start[0]);
      failureStage = "HEADER";
      const header = makeOtaHeaderRequest(component.header);
      requireOtaAcknowledgement(await transport.transact(header, 8000), header[0]);

      const payload = component.payload;
      const totalRecords = Math.ceil(payload.length / 1000);
      const pacing = new TempleDataPacingController({
        startLevel: resolveTempleDataPacingStartLevel(
          dataPacingMultiplier,
          readTempleDataPacingMemory(this.deviceKey, route).level,
        ),
        totalBytes: payload.length,
        log: (message, tone) => this.log(`${route}: ${message}`, tone),
        linkOverheadMs: await transport.measureLinkOverheadMs(),
        deviceKey: this.deviceKey,
        route,
      });
      result.dataPacingPolicy.startLevel = pacing.startLevel;
      const startPacingPolicy = TEMPLE_DATA_PACING_LEVELS[pacing.startLevel];
      result.dataPacingPolicy.startBatchBytes = startPacingPolicy.batchBytes;
      result.dataPacingPolicy.startDeferredBoundaryEarlyMs =
        startPacingPolicy.deferredEarly ?? null;
      result.dataPacingPolicy.startDeferredBoundaryLateMs =
        startPacingPolicy.deferredLate ?? null;
      const deferredBoundaryDescription =
        Number.isFinite(startPacingPolicy.deferredEarly) &&
        Number.isFinite(startPacingPolicy.deferredLate)
          ? `; true ${POGO_DEFERRED_BATCH_BYTES}-byte deferred commits settle ${startPacingPolicy.deferredEarly}/${startPacingPolicy.deferredLate} ms`
          : "";
      this.log(
        `${route}: adaptive DATA pacing starts at level ${pacing.startLevel} (early ${startPacingPolicy.early} ms / late ${startPacingPolicy.late} ms per ${startPacingPolicy.batchBytes}-byte batch${deferredBoundaryDescription}); temple ACK latency drives backoff.`,
      );
      if (pacing.linkOverheadMs > 0) {
        this.log(
          `${route}: subtracting ${pacing.linkOverheadMs} ms of measured remote-relay round trip from temple ACK latencies before congestion decisions.`,
        );
      }
      const offload = transport.describeTransactOffload();
      if (offload.offloaded) {
        this.log(
          `${route}: each record's flow-control loop runs as one batched exchange in the person's browser, so every record costs one relay round trip instead of one per 32-byte chunk.`,
          "success",
        );
      } else if (transport.port?.transportKind === "remote") {
        this.log(
          `${route}: batched exchanges are unavailable (${offload.reason}); every 32-byte chunk will pay its own relay round trip and this transfer will be far slower.`,
          "warn",
        );
      }
      let acceptedBytes = 0;
      let retries = 0;
      for (let index = 0; index < totalRecords; index += 1) {
        failureStage = `DATA:${index}`;
        const offset = index * 1000;
        const data = payload.subarray(offset, Math.min(offset + 1000, payload.length));
        const final = index + 1 === totalRecords;
        const request = makeOtaDataRequest(data, final, index & 0xff);
        let transactStartedAt = Date.now();
        let resendsForRecord = 0;
        let recordAcknowledged = false;
        for (;;) {
          transactStartedAt = Date.now();
          try {
            // readBridgeResponse inflates this to max(20000, t + 30000), so a
            // marginal link gets ~70 s per record to recover a stalled
            // response before an in-place resend is even considered. This is
            // a technician-side wait only: it is not an exchange-batch step
            // bound, so it does not depend on the customer's deployed build
            // honouring a larger EXCHANGE_BATCH_MAX_STEP_TIMEOUT_MS.
            const response = await transport.transact(request, 40000);
            requireOtaAcknowledgement(response, 0x54);
            recordAcknowledged = true;
            break;
          } catch (error) {
            result.dataPacingPolicy = {
              ...result.dataPacingPolicy,
              ...pacing.summary(),
            };
            const decision = classifyInPlaceDataRecovery(error, {
              resendsForRecord,
              recoveriesThisAttempt: result.dataInPlaceRecovery?.resends ?? 0,
            });
            if (decision.action === "resend") {
              resendsForRecord += 1;
              result.dataInPlaceRecovery = {
                resends: (result.dataInPlaceRecovery?.resends ?? 0) + 1,
                lostAckAdvances:
                  result.dataInPlaceRecovery?.lostAckAdvances ?? 0,
                settledMs:
                  (result.dataInPlaceRecovery?.settledMs ?? 0) +
                  decision.settleMs,
              };
              this.log(
                `${route}: DATA record ${index + 1}/${totalRecords} drew no temple reply (${error?.message ?? error}); settling ${decision.settleMs} ms for the route to leave its silent window, then resending the identical record in place (resend ${resendsForRecord}/${POGO_DATA_INPLACE_RESEND_LIMIT}). The temple's sequence guard accepts only the record it is waiting for.`,
                "warn",
              );
              await transport.settleTempleStorage(decision.settleMs);
              continue;
            }
            if (decision.action === "advance") {
              result.dataInPlaceRecovery = {
                resends: result.dataInPlaceRecovery?.resends ?? 0,
                lostAckAdvances:
                  (result.dataInPlaceRecovery?.lostAckAdvances ?? 0) + 1,
                settledMs: result.dataInPlaceRecovery?.settledMs ?? 0,
              };
              this.log(
                `${route}: the temple rejected the resent DATA record ${index + 1} with status 1 — it already committed this record and its acknowledgement was lost. Advancing to the next record; a genuine desynchronization would reject that one immediately.`,
                "warn",
              );
              break;
            }
            // Only an explicit temple rejection says anything about pacing. A
            // transport failure — a dropped remote-support relay, an unplugged
            // cable — carries no evidence that the temple was overrun, so it
            // must not escalate the remembered level. Observed 2026-07-28: a
            // relay session expiring mid-DATA left the memory one level slower,
            // and the next run paid that penalty on every record.
            if (!isExplicitTempleDataRejection(error)) throw error;
            const pacingMemory = pacing.commitMemory("failed");
            result.dataPacingPolicy = {
              ...result.dataPacingPolicy,
              ...pacing.summary(),
              nextStartLevel: pacingMemory.level,
              nextCleanStreak: pacingMemory.cleanStreak,
            };
            result.dataRejection = {
              command: error.command,
              status: error.status,
              record: index + 1,
              recordIndex: index,
              acceptedBytes,
              totalBytes: payload.length,
            };
            this.log(
              `${route}: explicit rejection left DATA record ${index + 1} unadvanced; ending this component attempt without replaying the record. Any permitted fresh component attempt will retain at least pacing level ${pacingMemory.level}.`,
              "warn",
            );
            throw error;
          }
        }
        if (recordAcknowledged) {
          const congestionSettleMs = pacing.noteAckLatency(
            index,
            Date.now() - transactStartedAt,
          );
          if (congestionSettleMs > 0) {
            await transport.settleTempleStorage(congestionSettleMs);
          }
        }
        acceptedBytes += data.length;
        result.acceptedFirmwareBytes = acceptedBytes;
        transport.reportProgress(
          0.08 + ((index + 1) / totalRecords) * 0.78,
          `${route}: ${index + 1}/${totalRecords} main records`,
        );
        const settleMilliseconds = pacing.settleFor(acceptedBytes);
        if (settleMilliseconds > 0) {
          await transport.settleTempleStorage(settleMilliseconds);
        }
      }
      result.dataPacingPolicy = {
        ...result.dataPacingPolicy,
        ...pacing.summary(),
      };
      const pacingMemory = pacing.commitMemory("clean");
      this.log(
        `${route}: adaptive pacing finished at level ${pacing.level} · ${pacing.escalations} backoffs, ACK mean ${pacing.summary().ackMeanMs ?? "?"} ms, ${Math.round(pacing.settleTotalMs / 1000)} s total settle; next component starts at level ${pacingMemory.level} (clean streak ${pacingMemory.cleanStreak}).`,
        "success",
      );

      const finish = makeOtaFinishRequest();
      failureStage = "FINISH";
      requireOtaAcknowledgement(await transport.transact(finish, 60000), finish[0]);
      transport.completedTransfer = {
        payloadBytes: acceptedBytes,
        records: totalRecords,
      };
      result.transfer = {
        recordsSent: totalRecords,
        payloadBytesSent: acceptedBytes,
        dataRetries: retries,
        hostOnlyKeepalives: transport.hostOnlyKeepalives,
        finishAckReceived: true,
      };
      this.log(
        `${route}: all ${totalRecords.toLocaleString()} records and the finish acknowledgement were accepted.`,
        "success",
      );

      const postflightStartedAt = Date.now();
      const deadline = postflightStartedAt + POGO_POSTFLIGHT_WINDOW_MS;
      failureStage = "POSTFLIGHT";
      let lastVersion = null;
      // The temple restarts onto the committed image here. Measured on
      // hardware 2026-07-28: this window ran its full 182 s with no log line
      // and a progress bar frozen at 77 %. It is also the one moment where
      // pulling the cable is unrecoverable, so silence is exactly the wrong
      // behaviour — narrate the wait instead of looking hung.
      this.log(
        `${route}: FINISH accepted; the temple is committing and restarting on the new image. This can take up to ${Math.round(
          POGO_POSTFLIGHT_WINDOW_MS / 1000,
        )} s — do not disconnect the Case or move the Glasses.`,
        "warn",
      );
      let nextHeartbeatAt = postflightStartedAt + POGO_POSTFLIGHT_HEARTBEAT_MS;
      while (Date.now() < deadline) {
        await delay(2000);
        const now = Date.now();
        if (now >= nextHeartbeatAt) {
          nextHeartbeatAt = now + POGO_POSTFLIGHT_HEARTBEAT_MS;
          const elapsedSeconds = Math.round((now - postflightStartedAt) / 1000);
          const remainingSeconds = Math.max(
            0,
            Math.round((deadline - now) / 1000),
          );
          // DATA finishes at 0.86 and the postflight verdict reports 0.90, so
          // the wait has to climb strictly between them — starting any lower
          // would walk the bar backwards at the moment it is being watched.
          transport.reportProgress(
            0.86 +
              0.04 *
                Math.min(
                  1,
                  (now - postflightStartedAt) / POGO_POSTFLIGHT_WINDOW_MS,
                ),
            `${route}: waiting for the temple to restart · ${elapsedSeconds} s elapsed`,
          );
          this.log(
            `${route}: still waiting for a post-restart version reply · ${elapsedSeconds} s elapsed, up to ${remainingSeconds} s remaining. Do not disconnect.`,
          );
        }
        transport.drainInput();
        try {
          const version = decodeTempleVersion(
            await transport.transact(makeTempleVersionRequest(), 8000),
          );
          lastVersion = version;
          if (
            version.firmware === expectedTargetVersion &&
            version.hardware === preflight.hardware
          ) {
            result.postflightVersion = version;
            break;
          }
        } catch (error) {
          if (!(error instanceof RetryablePogoFlashError)) throw error;
        }
      }
      if (!result.postflightVersion) {
        // A checksum-valid reply carrying the *previous* version is not a
        // failed write: FINISH was acknowledged, so the image is committed
        // and the temple simply has not switched to it yet. Measured on
        // hardware: a temple reported the old version through this whole
        // window and through a later analysis, then reported the new one
        // after a subsequent reset. Defer that case to a bounded reset and
        // re-probe once the bridge is torn down and the Case app is back.
        if (
          lastVersion &&
          lastVersion.hardware === preflight.hardware &&
          lastVersion.firmware === preflight.firmware
        ) {
          deferredActivation = {
            observedFirmware: lastVersion.firmware,
            observedHardware: lastVersion.hardware,
          };
          this.log(
            `${route}: FINISH was acknowledged and every byte accepted, but the temple still reports ${lastVersion.firmware}. The image is committed; giving it a bounded reset to activate before deciding.`,
            "warn",
          );
        } else {
          throw new RetryablePogoFlashError(
            lastVersion
              ? `${route}: postflight reported ${lastVersion.firmware}/hardware ${lastVersion.hardware}.`
              : `${route}: no checksum-valid postflight version arrived within 180 seconds.`,
          );
        }
      }
      if (deferredActivation) {
        transport.reportProgress(0.9, `${route}: awaiting image activation`);
      } else {
        transport.reportProgress(0.9, `${route}: postflight liveness verified`);
        this.log(
          `${route}: postflight firmware=${result.postflightVersion.firmware}, hardware=${result.postflightVersion.hardware}.`,
          "success",
        );
      }
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await transport.close();
      } catch (error) {
        cleanupError = error;
      }
      result.caseRestoreVerified = transport.restoreVerified;
      result.caseApplicationVersion = transport.caseReport?.caseVersion ?? null;
      result.routePhaseSetupAttempts = transport.routePhaseSetupAttempts;
      if (transport.retainedResult) {
        result.retainedResult = {
          ...transport.retainedResult,
          baseline: compactHex(transport.retainedResult.baseline),
          selected: compactHex(transport.retainedResult.selected),
          restored: compactHex(transport.retainedResult.restored),
        };
      }
      if (operationError) {
        result.failureStage = failureStage;
        const recoveryBoundary = classifyPogoFlashRecoveryBoundary(
          operationError,
          transport.retainedResult,
          failureStage,
        );
        if (recoveryBoundary) result.recoveryBoundary = recoveryBoundary;
      }
    }

    // The bridge is down and the Case application is back, so a traced reset
    // is safe here. Give a temple that accepted every byte but had not yet
    // switched images a bounded chance to come up on the new one before the
    // route is called failed.
    if (!operationError && !cleanupError && deferredActivation) {
      const activation = await this.resolveDeferredTempleActivation(
        route,
        expectedTargetVersion,
        deferredActivation,
      );
      result.deferredActivation = activation;
      if (activation.postflightVersion) {
        result.postflightVersion = activation.postflightVersion;
      } else {
        result.outcome = "failed_or_uncertain";
        result.failureStage = "POSTFLIGHT";
        result.error = `${route}: every byte was accepted and FINISH acknowledged, but the temple still reports ${deferredActivation.observedFirmware} after ${POGO_ACTIVATION_RESET_ATTEMPTS} activation resets.`;
        const error = new PogoFlashSafetyError(result.error);
        error.routeResult = result;
        throw error;
      }
    }

    if (operationError || cleanupError) {
      result.outcome = "failed_or_uncertain";
      if (operationError) result.error = operationError.message;
      if (cleanupError) result.cleanupError = cleanupError.message;
      const details = [
        operationError && `temple transaction: ${operationError.message}`,
        cleanupError && `Case cleanup: ${cleanupError.message}`,
      ].filter(Boolean);
      const error = new PogoFlashSafetyError(`${route}: ${details.join("; ")}`);
      error.routeResult = result;
      throw error;
    }
    result.outcome = "success";
    transport.reportProgress(1, `${route}: route and Case application restored`);
    return result;
  }

  async flashPinnedTempleMain(
    firmware,
    routeSelection = "both",
    {
      mode = "complete",
      differenceSourceFirmware = null,
      sourceProofMode = null,
    } = {},
  ) {
    const { mainComponent: component, target } =
      await assertPinnedTempleFlashCandidate(firmware);
    const targetReportedVersion = target.reportedVersion ?? target.version;
    if (!["complete", "differences"].includes(mode)) {
      throw new PogoFlashSafetyError("Choose complete or differences flashing.");
    }
    let differencePlan = null;
    let expectedSourceVersion = null;
    if (mode === "differences") {
      await assertPinnedTempleFlashCandidate(differenceSourceFirmware);
      differencePlan = buildBundleDifferencePlan(
        differenceSourceFirmware,
        firmware,
      );
      expectedSourceVersion = differencePlan.source.version;
      if (!differencePlan.executable) {
        throw new PogoFlashSafetyError(
          "The Stock/CFW difference plan is not an exact one-component transition.",
        );
      }
      this.log(
        `Difference plan verified: ${differencePlan.unchangedComponentCount} identical components omitted; transmitting the one changed, CRC-gated Apollo main.`,
        "success",
      );
    }
    const routes =
      routeSelection === "both"
        ? ["right", "left"]
        : [routeSelection];
    if (!routes.every((route) => ["left", "right"].includes(route))) {
      throw new PogoFlashSafetyError("Choose both, left, or right for temple flashing.");
    }
    // DEB0 always resets both seated temples. Even for a one-route repair,
    // prove that both applications returned before another START and again
    // after the final reset.
    const livenessRoutes = ["right", "left"];

    const audit = {
      schemaVersion: 4,
      startedAt: new Date().toISOString(),
      // Which physical unit and link this ran against. Without it an audit
      // cannot be compared with any other, and the transport materially
      // changes read behaviour (a full Case backup took 39 short-read
      // retries over Web Serial and none over WebUSB).
      deviceKey: this.deviceKey,
      transport: g2CaseTransportLabel(this.port),
      operation:
        mode === "differences"
          ? "g2_case_usb_bundle_component_differences"
          : "g2_case_usb_pinned_main_only",
      flashMode: mode,
      differencePlan,
      imageSha256: firmware.fileSha256,
      imageLabel: target.label,
      imageHardwareValidated: target.hardwareValidated,
      mainPayloadSha256: component.payloadSha256,
      installedIdentity: {
        channel:
          firmware.provenance?.channel === "custom" ? "custom" : "official",
        reportedVersion: targetReportedVersion,
        displayVersion:
          firmware.provenance?.channel === "custom"
            ? `${target.version} CFW`
            : target.version,
        evidence:
          "pinned target hashes, exact accepted byte count, FINISH acknowledgement, reset, and bilateral liveness",
      },
      sourceValidation:
        mode === "differences"
          ? {
              mode:
                sourceProofMode ?? "caller-confirmed-source",
              exactInstalledImageReadbackAvailable: false,
              requiredLiveFirmware: expectedSourceVersion,
              requiredLiveHardware: 5,
              completeTargetMainTransferred: true,
              sparseByteRangesTransferred: false,
              routePreflight: null,
            }
          : null,
      bridgeSha256:
        POGO_FLASH_BRIDGE_SHA256,
      bridgeSha256ByYhmProfile: {
        [YHM_PROFILE_REVIEWED_22]:
          POGO_FLASH_BRIDGE_PROFILE_SHA256[YHM_PROFILE_REVIEWED_22],
        [YHM_PROFILE_OBSERVED_33]:
          POGO_FLASH_BRIDGE_PROFILE_SHA256[YHM_PROFILE_OBSERVED_33],
        [YHM_PROFILE_OBSERVED_45]:
          POGO_FLASH_BRIDGE_PROFILE_SHA256[YHM_PROFILE_OBSERVED_45],
      },
      routes,
      routeOrderSetupStops: [],
      supersededSuccessfulRouteResults: [],
      routeComponentRestartAttempts: [],
      routeComponentRestartResets: [],
      persistentDataRejectionStops: [],
      routeSetupResetStops: [],
      routeSetupSettleStops: [],
      routeSetupResetResults: [],
      terminalRecoveryStops: [],
      componentRestartLimit: POGO_COMPONENT_RESTART_LIMIT,
      hostTimeoutComponentRestartLimit:
        POGO_HOST_TIMEOUT_COMPONENT_RESTART_LIMIT,
      persistentDataRejectionWindowRecords:
        POGO_PERSISTENT_REJECTION_WINDOW_RECORDS,
      setupResetLimit: POGO_SETUP_RESET_LIMIT,
      bilateralRouteAdaptationLimit: POGO_BILATERAL_ROUTE_ADAPTATION_LIMIT,
      bootloaderAllowed: false,
      preflightCase: null,
      routeResults: [],
      finalResetAndLiveness: null,
      outcome: "started",
    };
    try {
      const preflightCase = await this.readTempleFlashPreflight(routes);
      audit.preflightCase = {
        firmware: preflightCase.caseVersion,
        lidOpen: preflightCase.telemetry?.open ?? null,
        usbPresent: preflightCase.telemetry?.usbPresent ?? null,
        leftPresent: preflightCase.telemetry?.leftPresent ?? null,
        rightPresent: preflightCase.telemetry?.rightPresent ?? null,
      };
      const componentRestartCounts = new Map();
      const setupResetCounts = new Map();
      const setupSettleCounts = new Map();
      for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index];
        const componentRestartCount =
          componentRestartCounts.get(route) ?? 0;
        const setupResetCount = setupResetCounts.get(route) ?? 0;
        const dataPacingMultiplier =
          templeDataPacingMultiplierForRestart(componentRestartCount);
        try {
          audit.routeResults.push(
            await this.flashPinnedTempleRoute(
              component,
              expectedSourceVersion,
              targetReportedVersion,
              route,
              index,
              routes.length,
              dataPacingMultiplier,
            ),
          );
        } catch (error) {
          const phaseCompatibleRoute =
            error.routeResult?.retainedResult?.phaseCompatibleRoute;
          const canAdaptBilateralOrder =
            routeSelection === "both" &&
            index === 0 &&
            ["left", "right"].includes(phaseCompatibleRoute) &&
            phaseCompatibleRoute !== route &&
            audit.routeOrderSetupStops.length <
              POGO_BILATERAL_ROUTE_ADAPTATION_LIMIT &&
            error.routeResult?.retainedResult?.noMutationPhaseStopVerified ===
              true &&
            error.routeResult?.acceptedFirmwareBytes === 0 &&
            error.routeResult?.otaMutationAttempted === false &&
            error.routeResult?.caseRestoreVerified === true &&
            error.routeResult?.caseApplicationVersion === REVIEWED_CASE_VERSION;
          if (canAdaptBilateralOrder) {
            audit.routeOrderSetupStops.push(error.routeResult);
            if (audit.routeResults.length) {
              audit.supersededSuccessfulRouteResults.push(
                ...audit.routeResults,
              );
              audit.routeResults.length = 0;
            }
            const secondRoute =
              phaseCompatibleRoute === "left" ? "right" : "left";
            routes.splice(
              0,
              routes.length,
              phaseCompatibleRoute,
              secondRoute,
            );
            this.log(
              `Bilateral route order adapted to ${phaseCompatibleRoute} then ${secondRoute} from an exact allowlisted, zero-write Case phase proof.`,
              "warn",
            );
            index = -1;
            continue;
          }
          // A zero-write setup stop means the route is busy, not broken —
          // measured on hardware as a 10-25 minute post-reset charging
          // renegotiation. Resetting restarts that window instead of ending
          // it, so wait the route out first and only then fall back to the
          // bounded reset path.
          const setupSettleCount = setupSettleCounts.get(route) ?? 0;
          const setupSettleIndex =
            POGO_SETUP_STOP_FIRST_SETTLE_INDEX + setupSettleCount;
          const setupSettleLimit =
            POGO_READ_ONLY_PHASE_SETTLE_MS.length -
            POGO_SETUP_STOP_FIRST_SETTLE_INDEX;
          if (
            // Same audited zero-write proof the reset path requires; only the
            // recovery action differs.
            canResetAfterZeroWriteSetupStop(error.routeResult, 0) &&
            setupSettleCount < setupSettleLimit
          ) {
            const settleMs = POGO_READ_ONLY_PHASE_SETTLE_MS[setupSettleIndex];
            setupSettleCounts.set(route, setupSettleCount + 1);
            audit.routeSetupSettleStops.push({
              route,
              settleMs,
              attempt: setupSettleCount + 1,
              baseline: error.routeResult?.retainedResult?.baselineMask ?? null,
            });
            this.log(
              `${route}: the writer's zero-write setup stop proves the route is busy, not broken. Leaving the Case application undisturbed for ${settleMs / 1000} s before a fresh setup (bounded settle ${setupSettleCount + 1}/${setupSettleLimit}); no reset, because a reset restarts the charging window.`,
              "warn",
            );
            this.progress(
              (index / routes.length) * 0.9,
              `${route}: waiting ${Math.round(settleMs / 1000)} s for the charging route to settle`,
            );
            await this.waitNarrated(settleMs, (elapsed, remaining) => {
              this.log(
                `${route}: still waiting for the charging route to settle · ${elapsed} s elapsed, ${remaining} s remaining. Do not disconnect.`,
              );
              this.progress(
                (index / routes.length) * 0.9,
                `${route}: settling · ${elapsed} s elapsed of ${Math.round(settleMs / 1000)} s`,
              );
            });
            index -= 1;
            continue;
          }
          if (
            canResetAfterZeroWriteSetupStop(
              error.routeResult,
              setupResetCount,
            )
          ) {
            audit.routeSetupResetStops.push(error.routeResult);
            audit.routeSetupResetResults.push(
              await this.resetTempleOtaReceiverForComponentRestart(
                livenessRoutes,
                null,
                route,
                index,
                routes.length,
                { recoveryReason: "setup-stop" },
              ),
            );
            setupResetCounts.set(route, setupResetCount + 1);
            index -= 1;
            continue;
          }
          const exhaustedSetupBoundary =
            classifyExhaustedYhmSetupBoundary(error.routeResult, {
              settleAttempts: setupSettleCount,
              settleLimit: setupSettleLimit,
              resetAttempts: setupResetCount,
              resetLimit: POGO_SETUP_RESET_LIMIT,
            });
          if (exhaustedSetupBoundary) {
            error.routeResult.recoveryBoundary =
              exhaustedSetupBoundary;
            audit.terminalRecoveryStops.push(exhaustedSetupBoundary);
            this.log(
              `${route}: the writer exhausted ${exhaustedSetupBoundary.settleAttempts} bounded settle probes and ${exhaustedSetupBoundary.resetAttempts} reset/rechecks before route selection. Retained SRAM proves zero firmware bytes were sent on this route; stop Case-USB retries and use the fresh Bluetooth full-package fallback.`,
              "warn",
            );
            audit.routeResults.push(error.routeResult);
            throw error;
          }
          const boundary = classifyPersistentTempleDataRejection(
            error.routeResult,
            audit.routeComponentRestartAttempts,
          );
          if (boundary) {
            error.routeResult.recoveryBoundary = boundary;
            audit.persistentDataRejectionStops.push(boundary);
            this.log(
              `${route}: explicit DATA status 1 repeated at records ${boundary.priorRecord} and ${boundary.currentRecord} (${boundary.recordDistance} records apart) after conservative restart pacing. Treating this as a persistent temple receiver/storage boundary; no third full-component attempt will be started.`,
              "warn",
            );
            if (error.routeResult) {
              audit.routeResults.push(error.routeResult);
            }
            throw error;
          }
          const maximumPacingBoundary =
            classifyMaximumPacingTempleDataRejection(error.routeResult);
          if (maximumPacingBoundary) {
            error.routeResult.recoveryBoundary = maximumPacingBoundary;
            audit.persistentDataRejectionStops.push(maximumPacingBoundary);
            this.log(
              `${route}: explicit DATA status 1 rejected record ${maximumPacingBoundary.record} after the attempt began at maximum reviewed pacing (early ${maximumPacingBoundary.pacing.early} ms / late ${maximumPacingBoundary.pacing.late} ms per ${maximumPacingBoundary.pacing.batchBytes}-byte batch). No additional Case-USB component restart will be started.`,
              "warn",
            );
            audit.routeResults.push(error.routeResult);
            throw error;
          }
          if (
            canRestartFailedTempleComponent(
              error.routeResult,
              componentRestartCount,
            )
          ) {
            audit.routeComponentRestartAttempts.push(error.routeResult);
            // The restarting route is still on its pre-flash image, but any
            // route already finished in this run carries the target. Expect
            // each temple at the image it should actually be holding.
            const restartingRouteVersion =
              error.routeResult?.preflightVersion?.firmware ??
              expectedSourceVersion ??
              targetReportedVersion;
            const expectedVersionByRoute = Object.fromEntries(
              livenessRoutes.map((livenessRoute) => {
                // A seated temple outside this run's route selection was
                // never written to. On a split pair it legitimately holds a
                // different image than the route being repaired, so predicting
                // either the source or the target version for it is wrong.
                // Verify only that its application came back — hardware
                // revision plus a checksum-valid version reply.
                if (!routes.includes(livenessRoute)) {
                  return [livenessRoute, null];
                }
                return [
                  livenessRoute,
                  audit.routeResults.some(
                    (completed) =>
                      completed?.route === livenessRoute &&
                      completed?.outcome === "success",
                  )
                    ? targetReportedVersion
                    : restartingRouteVersion,
                ];
              }),
            );
            audit.routeComponentRestartResets.push(
              await this.resetTempleOtaReceiverForComponentRestart(
                livenessRoutes,
                expectedVersionByRoute,
                route,
                index,
                routes.length,
              ),
            );
            componentRestartCounts.set(route, componentRestartCount + 1);
            index -= 1;
            continue;
          }
          if (error.routeResult) audit.routeResults.push(error.routeResult);
          throw error;
        }
      }
      audit.finalResetAndLiveness = await this.finalizeTempleRestore(
        livenessRoutes,
        // Only the routes this run actually wrote should be asserted at the
        // target. An untouched seated temple is verified for liveness alone;
        // asserting the target on it fails every correct one-route repair of
        // a split pair.
        Object.fromEntries(
          livenessRoutes.map((livenessRoute) => [
            livenessRoute,
            routes.includes(livenessRoute) ? targetReportedVersion : null,
          ]),
        ),
      );
      if (audit.sourceValidation) {
        audit.sourceValidation.routePreflight = Object.fromEntries(
          audit.routeResults.map((result) => [
            result.route,
            {
              firmware: result.preflightVersion?.firmware ?? null,
              hardware: result.preflightVersion?.hardware ?? null,
              checksumValid: Boolean(result.preflightVersion),
              validatedBeforeStart: true,
            },
          ]),
        );
      }
      audit.verification = {
        targetBundleSha256: firmware.fileSha256,
        targetMainSha256: component.payloadSha256,
        targetMainBytes: component.payload.length,
        everyRouteAcceptedExactTargetBytes: audit.routeResults.every(
          (result) =>
            result.transfer?.finishAckReceived &&
            result.transfer.payloadBytesSent === component.payload.length &&
            result.retainedResult?.acceptedSize === component.payload.length,
        ),
        everyRoutePostflightVersionValid: audit.routeResults.every(
          (result) =>
            result.postflightVersion?.firmware === targetReportedVersion &&
            result.postflightVersion?.hardware === 5,
        ),
        everyRoutePreflightCompatible: audit.routeResults.every(
          (result) =>
            (!expectedSourceVersion ||
              result.preflightVersion?.firmware === expectedSourceVersion) &&
            result.preflightVersion?.hardware === 5,
        ),
        finalDualTempleResetVerified:
          audit.finalResetAndLiveness?.resetConfirmed === true,
        postResetLivenessVerified: livenessRoutes.every(
          (route) =>
            audit.finalResetAndLiveness?.versions?.[route]?.firmware ===
              targetReportedVersion &&
            audit.finalResetAndLiveness?.versions?.[route]?.hardware === 5,
        ),
        installedByteReadbackAvailable: false,
        installedByteReadbackBoundary:
          "The stock Case route exposes the OTA receiver, not installed Apollo MRAM readback; the target is proven by its pinned header/CRC, exact accepted byte count, finish acknowledgement, reboot, and post-reset liveness.",
      };
      if (
        !audit.verification.everyRouteAcceptedExactTargetBytes ||
        !audit.verification.everyRoutePreflightCompatible ||
        !audit.verification.everyRoutePostflightVersionValid ||
        !audit.verification.finalDualTempleResetVerified ||
        !audit.verification.postResetLivenessVerified
      ) {
        throw new PogoFlashSafetyError(
          "The transfer completed but the consolidated verification proof is incomplete.",
        );
      }
      audit.outcome = "success";
      this.progress(1, "Pinned transfer, final reset, and liveness verified");
      return audit;
    } catch (error) {
      audit.outcome = "failed_or_uncertain";
      audit.error = error.message;
      if (
        !audit.finalResetAndLiveness &&
        canRunFinalResetAfterFailure(audit.routeResults)
      ) {
        try {
          audit.finalResetAndLiveness = await this.finalizeTempleRestore(
            livenessRoutes,
            null,
          );
          this.log(
            "Transfer remains failed or uncertain; final B0 reset and post-reset liveness nevertheless verified.",
            "warn",
          );
        } catch (resetError) {
          audit.finalResetAndLiveness = {
            outcome: "failed",
            error: resetError.message,
          };
        }
      }
      error.audit = audit;
      throw error;
    } finally {
      audit.finishedAt = new Date().toISOString();
    }
  }

  async stageCaseImage(
    caseImage,
    optionSnapshot,
    { progressBase = 0, progressSpan = 1 } = {},
  ) {
    const reportProgress = (fraction, detail) =>
      this.progress(progressBase + fraction * progressSpan, detail);
    const options = decodeOptionBytes(optionSnapshot);
    const pageCount = Math.ceil(caseImage.length / FLASH_PAGE_SIZE);
    const physicalPageStart = options.swapBank ? 128 : 0;
    const pages = Array.from(
      { length: pageCount },
      (_, index) => physicalPageStart + index,
    );
    const loader = new Stm32Bootloader(this.port, this.log);
    try {
      await loader.connect();
      const currentOptions = await loader.readRange(OPTION_BASE, OPTION_SIZE);
      if (!equalBytes(currentOptions, optionSnapshot)) {
        throw new Error(
          "The option bytes changed after analysis. Analyze again before staging.",
        );
      }
      this.log(
        `Erasing ${pageCount} bounded pages in inactive physical bank ${options.inactivePhysicalBank}.`,
      );
      await loader.erasePages(pages);
      reportProgress(0.08, "Inactive pages erased");
      await loader.writeRange(INACTIVE_ALIAS, caseImage, (fraction) =>
        reportProgress(
          0.08 + fraction * 0.7,
          `Writing inactive bank · ${Math.round(fraction * 100)}%`,
        ),
      );
      const readback = await loader.readRange(
        INACTIVE_ALIAS,
        caseImage.length,
        (fraction) =>
          reportProgress(
            0.78 + fraction * 0.2,
            `Verifying inactive bank · ${Math.round(fraction * 100)}%`,
          ),
      );
      const sourceSha256 = await sha256Hex(caseImage);
      const readbackSha256 = await sha256Hex(readback);
      if (sourceSha256 !== readbackSha256 || !equalBytes(caseImage, readback)) {
        throw new Error("Inactive-bank readback does not match the selected Case image.");
      }
      reportProgress(1, "Inactive bank verified");
      this.log(`Inactive bank staged and verified · ${readbackSha256.slice(0, 16)}…`);
      return { sourceSha256, readbackSha256, pageCount, optionSnapshot };
    } finally {
      await loader.close();
      await this.restoreNormal();
    }
  }

  async activateStagedBank(
    caseImage,
    optionSnapshot,
    { progressBase = 0, progressSpan = 1 } = {},
  ) {
    const reportProgress = (fraction, detail) =>
      this.progress(progressBase + fraction * progressSpan, detail);
    const loader = new Stm32Bootloader(this.port, this.log);
    let optionWriteStarted = false;
    try {
      await loader.connect();
      const currentOptions = await loader.readRange(OPTION_BASE, OPTION_SIZE);
      if (!equalBytes(currentOptions, optionSnapshot)) {
        throw new Error(
          "The option bytes changed after staging. Analyze and stage again.",
        );
      }
      const readback = await loader.readRange(
        INACTIVE_ALIAS,
        caseImage.length,
        (fraction) =>
          reportProgress(fraction * 0.35, "Rechecking staged bank"),
      );
      if (!equalBytes(readback, caseImage)) {
        throw new Error("The staged bank no longer matches the selected image.");
      }
      const nextOptions = toggledBankOptionBytes(currentOptions);
      this.log("Staged image reverified. Committing the bank-selection option word.");
      optionWriteStarted = true;
      await loader.writeMemory(OPTION_BASE, nextOptions, 8000);
      reportProgress(0.72, "Bank selection committed");
    } catch (error) {
      if (!optionWriteStarted) throw error;
      if (/NACK|unexpected 0x/i.test(error?.message ?? "")) throw error;
      this.log(
        "The option-byte write reset the Case before the final acknowledgement; checking the normal application.",
        "warn",
      );
    } finally {
      await loader.close();
    }

    await delay(1200);
    // The bank selection is already committed above. This is verification
    // only, so a transient console failure here must not report the
    // activation itself as failed — that misread turns a succeeded bank
    // switch into a spurious recovery cycle.
    const report = await retryReadOnlyBlock(
      () => this.restartAndRecheck(),
      async () => this.wait(1500),
      {
        attempts: 2,
        onRetry: (error) =>
          this.log(
            `The post-activation restart check failed transiently (${error.message}); one bounded retry follows. The bank selection is already committed.`,
            "warn",
          ),
      },
    );
    reportProgress(1, "Activated and restarted");
    return report;
  }
}

export function webSerialSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export { webUsbSupported };

export function webCaseTransportSupported() {
  return webSerialSupported() || webUsbSupported();
}

export function isG2CaseSerialPort(port) {
  try {
    const { usbVendorId, usbProductId } = port?.getInfo?.() ?? {};
    return usbVendorId === 0x1a86 && usbProductId === 0x7523;
  } catch {
    return false;
  }
}

export function portUsesUsbDevice(port, device) {
  return Boolean(port?.usbDevice && port.usbDevice === device);
}

export function g2CaseTransportLabel(port) {
  if (port?.transportKind === "remote") return "Remote G2 Case";
  return port?.transportKind === "webusb" ? "WebUSB" : "Web Serial";
}

export function preferredG2CaseTransport({
  webUsb = webUsbSupported(),
  webSerial = webSerialSupported(),
} = {}) {
  if (webUsb) return "webusb";
  if (webSerial) return "serial";
  return null;
}

export async function requestG2CasePort({ transport = "auto" } = {}) {
  if (!["auto", "serial", "webusb"].includes(transport)) {
    throw new Error(`Unknown G2 Case transport ${transport}.`);
  }
  const resolvedTransport =
    transport === "auto" ? preferredG2CaseTransport() : transport;
  if (resolvedTransport === "webusb") {
    return requestG2CaseUsbPort();
  }
  if (resolvedTransport !== "serial" || !webSerialSupported()) {
    throw new Error(
      "Neither WebUSB nor Web Serial is available. Use a current Chromium-based browser.",
    );
  }
  const grantedPorts = await navigator.serial.getPorts();
  const grantedCases = grantedPorts.filter(isG2CaseSerialPort);
  if (grantedCases.length === 1) {
    return grantedCases[0];
  }
  return navigator.serial.requestPort({
    filters: [{ usbVendorId: 0x1a86, usbProductId: 0x7523 }],
  });
}

export function isG2CaseUsbConnectionEvent(event) {
  return isG2CaseUsbDevice(event?.device ?? event?.target);
}

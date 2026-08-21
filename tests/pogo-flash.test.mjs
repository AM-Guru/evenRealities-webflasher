import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  POGO_FLASH_BRIDGE_BYTES,
  POGO_FLASH_BRIDGE_OBSERVED_33_SHA256,
  POGO_FLASH_BRIDGE_SHA256,
  POGO_FLASH_PROOF,
  POGO_FLASH_RESULT_LENGTH,
  PogoFlashSafetyError,
  RetryablePogoFlashError,
  TEMPLE_FLASH_TARGETS,
  TempleRejectedError,
  assertPinnedTempleFlashCandidate,
  classifyPogoFlashRecoveryBoundary,
  crc16CcittFalse,
  decodePogoFlashRetainedResult,
  decodeTempleVersion,
  getVerifiedPogoFlashBridgePayload,
  makeOtaDataRequest,
  makeOtaFinishRequest,
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
} from "../src/lib/pogoFlashBridge.js";

const OFFICIAL_MAIN_BYTES = 3_523_396;
import { sha256Hex, writeU32LE } from "../src/lib/firmware.js";
import {
  G2CaseSession,
  SerialTransport,
  WEB_SERIAL_ROM_READ_SIZE,
  canResetAfterZeroWriteSetupStop,
  canRestartFailedTempleComponent,
  canRunFinalResetAfterFailure,
  classifyExhaustedYhmSetupBoundary,
  classifyMaximumPacingTempleDataRejection,
  classifyPersistentTempleDataRejection,
  isExplicitTempleDataRejection,
  isPogoRoutePhaseMismatch,
  isG2CaseSerialPort,
  isRetryablePostResetLivenessFailure,
  isWebSerialRomPacketBoundary,
  noteWebSerialShortReadRetry,
  TEMPLE_DATA_PACING_LEVELS,
  TEMPLE_DATA_PACING_MIN_AUTOMATIC_LEVEL,
  TEMPLE_DATA_PACING_STOCK_LEVEL,
  TempleDataPacingController,
  nextTempleDataPacingMemory,
  POGO_READ_ONLY_PHASE_SETTLE_MS,
  POGO_SETUP_STOP_FIRST_SETTLE_INDEX,
  readTempleDataPacingMemory,
  writeTempleDataPacingMemory,
  TEMPLE_DATA_PACING_DEFAULT_START_LEVEL,
  readYhmRouteProfileMemory,
  resolveTempleDataPacingStartLevel,
  templeDataPacingMultiplierForRestart,
  POGO_COMPONENT_RESTART_LIMIT,
  POGO_HOST_TIMEOUT_COMPONENT_RESTART_LIMIT,
  POGO_DATA_INPLACE_RESEND_LIMIT,
  POGO_DATA_INPLACE_RECOVERY_BUDGET,
  POGO_DATA_INPLACE_SETTLE_MS,
  classifyInPlaceDataRecovery,
  readPogoFlashResponseFrame,
  readPogoFlashResponseHeader,
  readRomBlockWithBoundaryRecovery,
  retryReadOnlyBlock,
  defaultPacingThrottleProbe,
  describeRemoteTransactOffload,
  drainUntilQuietLine,
  templeDataSettleMilliseconds,
  writePogoFlashTransactionHeader,
  writeYhmRouteProfileMemory,
} from "../src/lib/serial.js";
import {
  YHM_PROFILE_OBSERVED_33,
  YHM_PROFILE_OBSERVED_45,
  YHM_PROFILE_REVIEWED_22,
  identifyYhmBaselineProfile,
} from "../src/lib/yhmProfiles.js";
import { getVerifiedPogoBridgePayload } from "../src/lib/pogoBridge.js";

const REVIEWED_STOCK_IMAGE_SHA256 =
  "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa";
// The older custom firmware that carried this version number earned hardware validation,
// but the current g2flash-derived 2.2.6.11 has distinct bytes and remains
// unvalidated until it is exercised on physical glasses.
const HARDWARE_VALIDATED_IMAGE_SHA256 = new Set([
  REVIEWED_STOCK_IMAGE_SHA256,
]);

function makeTempleFrame(payload) {
  const frame = new Uint8Array(payload.length + 5);
  frame.set([0x5a, 0xa5, 0xff, payload.length]);
  frame.set(payload, 4);
  frame[frame.length - 1] =
    frame.subarray(0, -1).reduce((sum, value) => (sum + value) & 0xff, 0);
  return frame;
}

function makeBridgeResponse(sequence, captured, { status = 0, uartErrors = 0 } = {}) {
  const header = new Uint8Array(11);
  header.set(new TextEncoder().encode("G2RX"));
  header.set([1, sequence, status, uartErrors, captured.length, 0, 0], 4);
  const tail = new Uint8Array(captured.length + 1);
  tail.set(captured);
  const complete = new Uint8Array(header.length + tail.length);
  complete.set(header);
  complete.set(tail, header.length);
  tail[tail.length - 1] =
    complete.subarray(0, -1).reduce((sum, value) => (sum + value) & 0xff, 0);
  return { header, tail };
}

test("paces the fixed transaction header across the CH340 idle boundary", async () => {
  const writes = [];
  const sleeps = [];
  const header = Uint8Array.from({ length: 10 }, (_, index) => index);
  await writePogoFlashTransactionHeader(
    {
      write: async (bytes) => writes.push([...bytes]),
    },
    header,
    async (milliseconds) => sleeps.push(milliseconds),
  );
  assert.deepEqual(writes, [
    [0, 1, 2, 3, 4],
    [5, 6, 7, 8, 9],
  ]);
  assert.deepEqual(sleeps, [5]);
});

test("re-synchronizes and rereads the exact block after a CH340 short read", async () => {
  let reads = 0;
  let resynchronizations = 0;
  const retries = [];
  const block = await retryReadOnlyBlock(
    async () => {
      reads += 1;
      if (reads < 3) {
        throw new Error(`received 31 of 128 bytes on attempt ${reads}`);
      }
      return new Uint8Array(128).fill(0xa5);
    },
    async () => {
      resynchronizations += 1;
    },
    {
      onRetry: (error, attempt) => retries.push([error.message, attempt]),
    },
  );
  assert.equal(block.length, 128);
  assert.equal(reads, 3);
  assert.equal(resynchronizations, 2);
  assert.equal(retries.length, 2);
});

test("spends remaining read-only attempts when a re-synchronization fails", async () => {
  let reads = 0;
  let resynchronizations = 0;
  const block = await retryReadOnlyBlock(
    async () => {
      reads += 1;
      if (reads < 3) throw new Error(`received 4 of 31 bytes on attempt ${reads}`);
      return new Uint8Array(31).fill(0x5a);
    },
    async () => {
      resynchronizations += 1;
      if (resynchronizations === 1) {
        throw new Error(
          "Timed out reading bootloader synchronization ACK: received 0 of 1 bytes.",
        );
      }
    },
  );
  assert.equal(block.length, 31);
  assert.equal(reads, 3);
  assert.equal(resynchronizations, 2);
});

test("surfaces the final error when every re-synchronization fails", async () => {
  await assert.rejects(
    retryReadOnlyBlock(
      async () => {
        throw new Error("received 0 of 31 bytes");
      },
      async () => {
        throw new Error(
          "Timed out reading bootloader synchronization ACK: received 0 of 1 bytes.",
        );
      },
      { attempts: 3 },
    ),
    /received 0 of 31 bytes/,
  );
});

test("spends remaining ROM attempts when a bootloader re-entry fails mid-read", async () => {
  let reads = 0;
  let resynchronizations = 0;
  const retries = [];
  const result = await readRomBlockWithBoundaryRecovery(
    async () => {
      reads += 1;
      if (reads < 3) {
        throw new Error(
          `Timed out reading memory at 0x80065d7: received 4 of 31 bytes.`,
        );
      }
      return new Uint8Array(31).fill(0xc3);
    },
    async () => {
      resynchronizations += 1;
      if (resynchronizations === 1) {
        throw new Error(
          "Timed out reading bootloader synchronization ACK: received 0 of 1 bytes.",
        );
      }
    },
    {
      requestedSize: 31,
      onRetry: (error, nextAttempt, attempts) =>
        retries.push([error.message, nextAttempt, attempts]),
    },
  );
  assert.equal(result.packetBoundaryDetected, false);
  assert.equal(result.block.length, 31);
  assert.equal(reads, 3);
  assert.equal(resynchronizations, 2);
  assert.equal(retries.length, 2);
});

test("reports the packet boundary even when its re-synchronization fails", async () => {
  const result = await readRomBlockWithBoundaryRecovery(
    async () => {
      throw new Error(
        "Timed out reading memory at 0x8000000: received 31 of 128 bytes.",
      );
    },
    async () => {
      throw new Error(
        "Timed out reading bootloader synchronization ACK: received 0 of 1 bytes.",
      );
    },
    { requestedSize: 128 },
  );
  assert.equal(result.block, null);
  assert.equal(result.packetBoundaryDetected, true);
});

test("a committed image that activates late resolves instead of failing the route", async () => {
  const session = new G2CaseSession(null, { log: () => {} });
  let resets = 0;
  session.restartAndRecheck = async () => {
    resets += 1;
    return { caseVersion: "1.2.57" };
  };
  session.probeRunningTemple = async () => ({
    decoded: {
      // Still the old image on the first probe, the new one after a reset.
      firmwareVersion: resets < 2 ? "2.2.6.10" : "2.2.6.11",
      hardwareRevision: 5,
    },
  });
  const activation = await session.resolveDeferredTempleActivation(
    "left",
    "2.2.6.11",
    { observedFirmware: "2.2.6.10", observedHardware: 5 },
  );
  assert.deepEqual(activation.postflightVersion, {
    firmware: "2.2.6.11",
    hardware: 5,
  });
  assert.equal(activation.resolvedOnAttempt, 2);
  assert.equal(activation.attempts.length, 2);
});

test("an image that never activates still fails the route after bounded resets", async () => {
  const session = new G2CaseSession(null, { log: () => {} });
  let resets = 0;
  session.restartAndRecheck = async () => {
    resets += 1;
    return { caseVersion: "1.2.57" };
  };
  session.probeRunningTemple = async () => ({
    decoded: { firmwareVersion: "2.2.6.10", hardwareRevision: 5 },
  });
  const activation = await session.resolveDeferredTempleActivation(
    "left",
    "2.2.6.11",
    { observedFirmware: "2.2.6.10", observedHardware: 5 },
    2,
  );
  assert.equal(activation.postflightVersion, undefined);
  assert.equal(activation.attempts.length, 2);
  assert.equal(resets, 2);
});

test("activation recovery survives a failed probe and keeps trying", async () => {
  const session = new G2CaseSession(null, { log: () => {} });
  let probes = 0;
  session.restartAndRecheck = async () => ({ caseVersion: "1.2.57" });
  session.probeRunningTemple = async () => {
    probes += 1;
    if (probes === 1) throw new Error("no framed temple response");
    return {
      decoded: { firmwareVersion: "2.2.6.11", hardwareRevision: 5 },
    };
  };
  const activation = await session.resolveDeferredTempleActivation(
    "right",
    "2.2.6.11",
    { observedFirmware: "2.2.6.10", observedHardware: 5 },
  );
  assert.equal(activation.resolvedOnAttempt, 2);
  assert.match(activation.attempts[0].error, /no framed temple response/);
});

test("post-reset liveness accepts per-route versions during a cross-version update", async () => {
  const session = new G2CaseSession(null, { log: () => {} });
  const probed = [];
  session.probeRunningTemple = async (_operation, route) => {
    probed.push(route);
    return {
      decoded: {
        // Right already carries the target; left still carries the source.
        firmwareVersion: route === "right" ? "2.2.6.11" : "2.2.6.10",
        hardwareRevision: 5,
      },
      transportProof: { restoredMask: 0x3ff },
    };
  };
  session.confirmCaseFirmwareVersion = async () => ({ caseVersion: "1.2.57" });
  session.restoreNormal = async () => ({ caseVersion: "1.2.57" });
  const resetReport = {
    caseVersion: "1.2.57",
    telemetry: { leftPresent: true, rightPresent: true },
  };
  const result = await session.verifyPostResetTempleLiveness(
    resetReport,
    ["right", "left"],
    { expectedVersion: { right: "2.2.6.11", left: "2.2.6.10" } },
  );
  assert.deepEqual(probed, ["right", "left"]);
  assert.equal(result.versions.right.firmware, "2.2.6.11");
  assert.equal(result.versions.left.firmware, "2.2.6.10");

  // A single expected version still applies to every route.
  await assert.rejects(
    () =>
      session.verifyPostResetTempleLiveness(resetReport, ["right", "left"], {
        expectedVersion: "2.2.6.10",
      }),
    /right: post-reset expected 2\.2\.6\.10\/hardware 5, observed 2\.2\.6\.11/,
  );
});

test("a zero-write setup stop qualifies for settling before any reset", () => {
  const zeroWriteSetupStop = {
    outcome: "failed_or_uncertain",
    failureStage: "setup",
    otaMutationAttempted: false,
    acceptedFirmwareBytes: 0,
    caseRestoreVerified: true,
    caseApplicationVersion: "1.2.57",
    retainedResult: {
      status: 3,
      baselineMask: 0x3ff,
      selectedMask: 0,
      restoredMask: 0,
      writeMask: 0,
      declaredSize: 0,
      acceptedSize: 0,
      templeTxCount: 0,
      templeRxCount: 0,
      noMutationSetupStopVerified: true,
    },
    recoveryBoundary: {
      classification: "yhm_setup_non_idle_zero_byte_boundary",
    },
  };
  // The settle branch gates on the same proof as the reset branch, evaluated
  // with a zero reset count so waiting is always tried first.
  assert.equal(canResetAfterZeroWriteSetupStop(zeroWriteSetupStop, 0), true);
  // Anything that transmitted bytes must never reach either recovery.
  assert.equal(
    canResetAfterZeroWriteSetupStop(
      {
        ...zeroWriteSetupStop,
        retainedResult: {
          ...zeroWriteSetupStop.retainedResult,
          templeTxCount: 4,
        },
      },
      0,
    ),
    false,
  );
});

test("adaptive pacing escalates on a slow ACK and injects an immediate settle", () => {
  const controller = new TempleDataPacingController({
    startLevel: 1,
    totalBytes: 3_539_474,
  });
  // Warm the baseline with fast ACKs.
  for (let index = 0; index < 30; index += 1) {
    assert.equal(controller.noteAckLatency(index, 120), 0);
  }
  const injected = controller.noteAckLatency(30, 2_000);
  assert.equal(controller.level, 2);
  assert.equal(injected, TEMPLE_DATA_PACING_LEVELS[2].late);
  assert.equal(controller.congestionEvents.length, 1);
  // Cooldown: an immediately-following slow ACK does not double-escalate.
  assert.equal(controller.noteAckLatency(31, 2_000), 0);
  assert.equal(controller.level, 2);
});

test("adaptive pacing never eases mid-transfer on calm ACKs", () => {
  const controller = new TempleDataPacingController({
    startLevel: 2,
    totalBytes: 3_539_474,
  });
  for (let index = 0; index < 500; index += 1) {
    assert.equal(controller.noteAckLatency(index, 100), 0);
  }
  assert.equal(controller.level, 2);
  assert.equal(controller.escalations, 0);
});

test("adaptive pacing settle amounts follow the active level", () => {
  const controller = new TempleDataPacingController({
    startLevel: 2,
    totalBytes: 24_000,
  });
  assert.equal(controller.settleFor(1_000), 0);
  assert.equal(controller.settleFor(6_000), TEMPLE_DATA_PACING_LEVELS[2].early);
  // ≥75% of the payload switches to the late settle.
  assert.equal(controller.settleFor(18_000), TEMPLE_DATA_PACING_LEVELS[2].late);
  // Final settle never drops below the fixed floor.
  assert.equal(controller.settleFor(24_000), 15_000);
});

test("maximum pacing serializes records and protects true deferred commits", () => {
  const maximumLevel = TEMPLE_DATA_PACING_LEVELS.length - 1;
  const maximumPolicy = TEMPLE_DATA_PACING_LEVELS[maximumLevel];
  const controller = new TempleDataPacingController({
    startLevel: maximumLevel,
    totalBytes: 24_000,
  });
  assert.equal(maximumPolicy.batchBytes, 1_000);
  assert.equal(controller.settleFor(1_000), maximumPolicy.early);
  assert.equal(controller.settleFor(2_000), maximumPolicy.early);
  assert.equal(controller.settleFor(6_000), maximumPolicy.deferredEarly);
  assert.ok(maximumPolicy.deferredEarly > maximumPolicy.early);
  assert.equal(controller.settleFor(18_000), maximumPolicy.deferredLate);
  assert.ok(maximumPolicy.deferredLate > maximumPolicy.late);
  assert.equal(controller.settleFor(19_000), maximumPolicy.late);
});

test("pacing start level honors escalated restarts and the automatic floor", () => {
  assert.equal(resolveTempleDataPacingStartLevel(1, 2), 2);
  // Level 0 rejected 2 of 3 measured hardware attempts; never auto-selected.
  assert.equal(
    resolveTempleDataPacingStartLevel(1, 0),
    TEMPLE_DATA_PACING_MIN_AUTOMATIC_LEVEL,
  );
  assert.equal(
    resolveTempleDataPacingStartLevel(2, 1),
    TEMPLE_DATA_PACING_LEVELS.length - 2,
  );
  assert.equal(
    resolveTempleDataPacingStartLevel(
      2,
      TEMPLE_DATA_PACING_LEVELS.length - 1,
    ),
    TEMPLE_DATA_PACING_LEVELS.length - 1,
    "a tier-2 restart must not lower the level learned from an explicit rejection",
  );
  assert.equal(
    resolveTempleDataPacingStartLevel(3, 1),
    TEMPLE_DATA_PACING_LEVELS.length - 1,
  );
});

test("the final whole-component attempt starts at maximum pacing", () => {
  // The escalation is defined against the restart budget, not a fixed attempt
  // number: first attempt at the remembered level, every intermediate restart
  // at tier 2, and the restart that exhausts the budget at maximum pacing.
  assert.ok(POGO_COMPONENT_RESTART_LIMIT >= 2);
  assert.equal(templeDataPacingMultiplierForRestart(0), 1);
  for (
    let restartCount = 1;
    restartCount < POGO_COMPONENT_RESTART_LIMIT;
    restartCount += 1
  ) {
    assert.equal(templeDataPacingMultiplierForRestart(restartCount), 2);
  }
  assert.equal(
    templeDataPacingMultiplierForRestart(POGO_COMPONENT_RESTART_LIMIT),
    3,
  );
  assert.equal(
    templeDataPacingMultiplierForRestart(POGO_COMPONENT_RESTART_LIMIT + 1),
    3,
  );
  assert.throws(
    () => templeDataPacingMultiplierForRestart(-1),
    /nonnegative integer/,
  );
});

test("pacing memory keeps each temple and Case separate", () => {
  const store = new Map();
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  try {
    const caseA = "uid:00310025514250052037384b";
    const caseB = "uid:00240024514250032037384b";
    // The measured asymmetry: one temple tolerant, the other conservative.
    writeTempleDataPacingMemory({ level: 1, cleanStreak: 1 }, caseA, "right");
    writeTempleDataPacingMemory({ level: 4, cleanStreak: 0 }, caseA, "left");

    assert.deepEqual(readTempleDataPacingMemory(caseA, "right"), {
      level: 1,
      cleanStreak: 1,
    });
    assert.deepEqual(readTempleDataPacingMemory(caseA, "left"), {
      level: 4,
      cleanStreak: 0,
    });
    // A different Case must not inherit either level.
    assert.equal(
      readTempleDataPacingMemory(caseB, "left").level,
      TEMPLE_DATA_PACING_DEFAULT_START_LEVEL,
    );
    // Neither may an unseen route on a known Case.
    assert.equal(
      readTempleDataPacingMemory(caseA, "both").level,
      TEMPLE_DATA_PACING_DEFAULT_START_LEVEL,
    );
  } finally {
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
});

test("pacing memory probes faster only after consecutive clean components", () => {
  let memory = { level: 3, cleanStreak: 0 };
  memory = nextTempleDataPacingMemory(memory, "clean", 3);
  assert.deepEqual(memory, { level: 3, cleanStreak: 1 });
  memory = nextTempleDataPacingMemory(memory, "clean", 3);
  assert.deepEqual(memory, { level: 2, cleanStreak: 0 });
});

test("pacing memory retreats to the proven level after any rejection", () => {
  assert.deepEqual(
    nextTempleDataPacingMemory({ level: 1, cleanStreak: 1 }, "failed", 1),
    { level: TEMPLE_DATA_PACING_STOCK_LEVEL, cleanStreak: 0 },
  );
  // A failure above the proven level escalates further rather than dropping.
  assert.deepEqual(
    nextTempleDataPacingMemory({ level: 4, cleanStreak: 0 }, "failed", 4),
    { level: 5, cleanStreak: 0 },
  );
});

test("pacing memory never probes below the automatic floor", () => {
  const memory = nextTempleDataPacingMemory(
    { level: TEMPLE_DATA_PACING_MIN_AUTOMATIC_LEVEL, cleanStreak: 5 },
    "clean",
    TEMPLE_DATA_PACING_MIN_AUTOMATIC_LEVEL,
  );
  assert.equal(memory.level, TEMPLE_DATA_PACING_MIN_AUTOMATIC_LEVEL);
});

test("suggests WebUSB once after repeated Web Serial short-read retries", () => {
  const logs = [];
  const log = (message, tone) => logs.push([message, tone]);
  // WebUSB and remote transports never count toward the hint.
  for (let i = 0; i < 20; i += 1) {
    noteWebSerialShortReadRetry({ transportKind: "webusb" }, log);
  }
  assert.equal(logs.length, 0);
  for (let i = 0; i < 30; i += 1) {
    noteWebSerialShortReadRetry({}, log);
  }
  const hints = logs.filter(([message]) => /WebUSB transport/.test(message));
  assert.equal(hints.length, 1);
  assert.equal(hints[0][1], "warn");
});

test("recognizes the deterministic CH340 Web Serial packet boundary", () => {
  assert.equal(WEB_SERIAL_ROM_READ_SIZE, 31);
  assert.equal(
    isWebSerialRomPacketBoundary(
      new Error("Timed out reading memory at 0x1fff7800: received 31 of 128 bytes."),
      128,
    ),
    true,
  );
  assert.equal(
    isWebSerialRomPacketBoundary(
      new Error("Timed out reading memory at 0x1fff7800: received 30 of 128 bytes."),
      128,
    ),
    false,
  );
  assert.equal(
    isWebSerialRomPacketBoundary(
      new Error("Timed out reading memory at 0x1fff7800: received 31 of 31 bytes."),
      31,
    ),
    false,
  );
});

test("detects a CH340 packet boundary reached on a later ROM retry", async () => {
  let reads = 0;
  let resynchronizations = 0;
  const retries = [];
  const boundaries = [];
  const result = await readRomBlockWithBoundaryRecovery(
    async () => {
      reads += 1;
      if (reads === 1) throw new Error("Transient Read Memory address ACK timeout.");
      throw new Error(
        "Timed out reading memory at 0x20011a00: received 31 of 128 bytes.",
      );
    },
    async () => {
      resynchronizations += 1;
    },
    {
      requestedSize: 128,
      onRetry: (error, nextAttempt, attempts) =>
        retries.push([error.message, nextAttempt, attempts]),
      onPacketBoundary: (error, attempt) =>
        boundaries.push([error.message, attempt]),
    },
  );
  assert.equal(result.block, null);
  assert.equal(result.packetBoundaryDetected, true);
  assert.equal(reads, 2);
  assert.equal(resynchronizations, 2);
  assert.deepEqual(
    retries,
    [["Transient Read Memory address ACK timeout.", 2, 5]],
  );
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0][1], 2);
});

test("recognizes only the reviewed G2 Case USB serial identity", () => {
  assert.equal(
    isG2CaseSerialPort({
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    }),
    true,
  );
  assert.equal(
    isG2CaseSerialPort({
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7522 }),
    }),
    false,
  );
  assert.equal(isG2CaseSerialPort({ getInfo: () => { throw new Error("gone"); } }), false);
});

test("retries only a fail-closed read-only YHM idle-phase mismatch", async () => {
  const waits = [];
  const logs = [];
  const preflights = [];
  const session = new G2CaseSession(null, {
    wait: async (milliseconds) => waits.push(milliseconds),
    log: (message, level) => logs.push([message, level]),
  });
  let attempts = 0;
  session.probeRunningTempleOnce = async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error(
        "The pogo bridge stopped safely: YHM baseline was not an allowlisted seated-idle state.",
      );
      error.pogoBridgeEvidence = {
        // The 0x8d table entry is never patched in a derived bridge, so a
        // foreign register-8 on it is structurally non-derivable and must
        // settle-retry rather than select a profile.
        baselineHex: "811104afaf038d2044ff",
        transmitted: 0,
        zeroWriteBaselineStopVerified: true,
      };
      throw error;
    }
    return { route: "right", operation: "version" };
  };
  session.readTempleFlashPreflight = async (routes) => {
    preflights.push(routes);
    return { caseVersion: "1.2.57" };
  };
  const result = await session.probeRunningTemple("version", "right");
  assert.deepEqual(result, { route: "right", operation: "version" });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [15_000, 45_000]);
  assert.deepEqual(preflights, [["right"], ["right"]]);
  assert.equal(logs.length, 4);
  assert.match(logs[0][0], /811104afaf038d2044ff/);
  assert.match(logs[0][0], /zero YHM writes and zero temple bytes/);
});

test("switches to the exact observed-33 bridge only from retained zero-write proof", async () => {
  const profiles = [];
  const waits = [];
  const logs = [];
  const session = new G2CaseSession(null, {
    wait: async (milliseconds) => waits.push(milliseconds),
    log: (message, level) => logs.push([message, level]),
  });
  session.probeRunningTempleOnce = async (_operation, _route, options) => {
    profiles.push(options.yhmProfile);
    if (profiles.length === 1) {
      const error = new Error(
        "The pogo bridge stopped safely: YHM baseline was not an allowlisted seated-idle state.",
      );
      error.pogoBridgeEvidence = {
        baselineHex: "810004aeae03812033ff",
        transmitted: 0,
        zeroWriteBaselineStopVerified: true,
      };
      throw error;
    }
    return {
      route: "right",
      operation: "version",
      yhmProfile: options.yhmProfile,
    };
  };
  session.readTempleFlashPreflight = async () => ({
    caseVersion: "1.2.57",
  });

  const result = await session.probeRunningTemple("version", "right");

  assert.deepEqual(profiles, [
    YHM_PROFILE_REVIEWED_22,
    YHM_PROFILE_OBSERVED_33,
  ]);
  assert.equal(result.yhmProfile, YHM_PROFILE_OBSERVED_33);
  assert.equal(
    session.routeYhmProfiles.get("right"),
    YHM_PROFILE_OBSERVED_33,
  );
  assert.deepEqual(waits, []);
  assert.match(logs[0][0], /separately hash-pinned bridge/);
  // Any register-8 variant of a patchable entry now derives its own profile
  // from the protocol proof; only structural deviations stay fail-closed.
  assert.equal(
    identifyYhmBaselineProfile("811004aeaf03812044ff"),
    "observed-44",
  );
  // Observed on hardware 2026-07-28 with retained zero-write proof; the
  // register-8 0x33 counterpart of reviewed entry 2 now selects the
  // observed-33 bridge instead of failing closed.
  assert.equal(
    identifyYhmBaselineProfile("811104afaf03812033ff"),
    YHM_PROFILE_OBSERVED_33,
  );
  // The raw entry-2 baseline stays reviewed-22 only: the observed-33 bridge
  // table replaces its register-8 byte rather than accepting both states.
  assert.equal(
    identifyYhmBaselineProfile("811104afaf03812022ff"),
    YHM_PROFILE_REVIEWED_22,
  );
});

test("switches to the exact observed-45 bridge only from retained zero-write proof", async () => {
  const profiles = [];
  const waits = [];
  const session = new G2CaseSession(null, {
    wait: async (milliseconds) => waits.push(milliseconds),
    log: () => {},
  });
  session.probeRunningTempleOnce = async (_operation, _route, options) => {
    profiles.push(options.yhmProfile);
    if (profiles.length === 1) {
      const error = new Error(
        "The pogo bridge stopped safely: YHM baseline was not an allowlisted seated-idle state.",
      );
      error.pogoBridgeEvidence = {
        // Remote support 2026-07-28, case 001d00115845501820373941: six
        // retained zero-write proofs held register-8 0x45 variants of the
        // reviewed seated-idle entries while the charging bytes cycled
        // normally, so this Case selects the observed-45 bridges.
        baselineHex: "810004aeae03812045ff",
        transmitted: 0,
        zeroWriteBaselineStopVerified: true,
      };
      throw error;
    }
    return {
      route: "left",
      operation: "version",
      yhmProfile: options.yhmProfile,
    };
  };
  session.readTempleFlashPreflight = async () => ({
    caseVersion: "1.2.57",
  });

  const result = await session.probeRunningTemple("version", "left");

  assert.deepEqual(profiles, [
    YHM_PROFILE_REVIEWED_22,
    YHM_PROFILE_OBSERVED_45,
  ]);
  assert.equal(result.yhmProfile, YHM_PROFILE_OBSERVED_45);
  assert.equal(
    session.routeYhmProfiles.get("left"),
    YHM_PROFILE_OBSERVED_45,
  );
  assert.deepEqual(waits, []);
  assert.equal(
    identifyYhmBaselineProfile("811104afaf03812045ff"),
    YHM_PROFILE_OBSERVED_45,
  );
  // Structural deviations stay fail-closed: a foreign register-8 on the
  // never-patched 0x8d entry, a non-ff terminator, and short frames are not
  // derivable from the reviewed table.
  assert.equal(identifyYhmBaselineProfile("811104afaf038d2045ff"), null);
  assert.equal(identifyYhmBaselineProfile("811104afaf03812045fe"), null);
  assert.equal(identifyYhmBaselineProfile("811104afaf038120"), null);
});

test("derives bridges for a never-before-seen register-8 value from the protocol proof", async () => {
  // No enumerated allowlist: a Case reporting register-8 0x5a with retained
  // zero-write proof derives its own pinned-base bridges the same way the
  // observed-33 and observed-45 Cases did.
  assert.equal(identifyYhmBaselineProfile("810004aeae0381205aff"), "observed-5a");
  const reviewed = await getVerifiedPogoBridgePayload();
  const derived = await getVerifiedPogoBridgePayload("observed-5a");
  assert.deepEqual(
    [...derived]
      .map((value, index) => [index, reviewed[index], value])
      .filter(([, reviewedByte, observedByte]) => reviewedByte !== observedByte)
      .map(([index, reviewedByte, observedByte]) => [
        index,
        reviewedByte,
        observedByte,
      ]),
    [
      [1670, 0x22, 0x5a],
      [1680, 0x22, 0x5a],
      [1690, 0x22, 0x5a],
      [1700, 0x22, 0x5a],
    ],
  );
});

test("derives the observed-45 bridges by patching only the four register-8 table bytes", async () => {
  const reviewedReadOnly = await getVerifiedPogoBridgePayload();
  const observed45ReadOnly = await getVerifiedPogoBridgePayload(
    YHM_PROFILE_OBSERVED_45,
  );
  assert.deepEqual(
    [...observed45ReadOnly]
      .map((value, index) => [index, reviewedReadOnly[index], value])
      .filter(([, reviewed, observed]) => reviewed !== observed),
    [
      [1670, 0x22, 0x45],
      [1680, 0x22, 0x45],
      [1690, 0x22, 0x45],
      [1700, 0x22, 0x45],
    ],
  );
  const reviewedWriter = await getVerifiedPogoFlashBridgePayload();
  const observed45Writer = await getVerifiedPogoFlashBridgePayload(
    YHM_PROFILE_OBSERVED_45,
  );
  assert.deepEqual(
    [...observed45Writer]
      .map((value, index) => [index, reviewedWriter[index], value])
      .filter(([, reviewed, observed]) => reviewed !== observed),
    [
      [2826, 0x22, 0x45],
      [2836, 0x22, 0x45],
      [2846, 0x22, 0x45],
      [2856, 0x22, 0x45],
    ],
  );
});

test("does not retry a text-only YHM mismatch without retained zero-write proof", async () => {
  const waits = [];
  const session = new G2CaseSession(null, {
    wait: async (milliseconds) => waits.push(milliseconds),
  });
  let attempts = 0;
  session.probeRunningTempleOnce = async () => {
    attempts += 1;
    throw new Error(
      "The pogo bridge stopped safely: YHM baseline was not an allowlisted seated-idle state.",
    );
  };
  await assert.rejects(
    () => session.probeRunningTemple("version", "right"),
    /YHM baseline was not an allowlisted seated-idle state/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
});

test("stops after bounded stock-app settling when the verified YHM baseline persists", async () => {
  const waits = [];
  const session = new G2CaseSession(null, {
    wait: async (milliseconds) => waits.push(milliseconds),
  });
  let attempts = 0;
  session.probeRunningTempleOnce = async () => {
    attempts += 1;
    const error = new Error(
      "The pogo bridge stopped safely: YHM baseline was not an allowlisted seated-idle state.",
    );
    error.pogoBridgeEvidence = {
      // A foreign register-8 on the never-patched 0x8d entry cannot derive a
      // profile, so the settle ladder must run to exhaustion.
      baselineHex: "811104afaf038d2044ff",
      transmitted: 0,
      zeroWriteBaselineStopVerified: true,
    };
    throw error;
  };
  session.readTempleFlashPreflight = async () => ({
    caseVersion: "1.2.57",
  });

  await assert.rejects(
    async () => {
      try {
        await session.probeRunningTemple("version", "right");
      } catch (error) {
        assert.equal(error.readOnlyPhaseAttempts.length, 6);
        assert.equal(
          error.readOnlyPhaseAttempts.every(
            (entry) =>
              entry.zeroYhmWritesVerified &&
              entry.templeBytesTransmitted === 0,
          ),
          true,
        );
        throw error;
      }
    },
    /after 6 verified zero-write probes.*No YHM writes or temple transmissions occurred/,
  );
  assert.equal(attempts, 6);
  assert.deepEqual(waits, [15_000, 45_000, 90_000, 180_000, 300_000]);
});

test("settles through a fully-restored silent-temple stop after a reset", async () => {
  const waits = [];
  const logs = [];
  const session = new G2CaseSession(null, {
    wait: async (milliseconds) => waits.push(milliseconds),
    log: (message, level) => logs.push([message, level]),
  });
  let attempts = 0;
  session.probeRunningTempleOnce = async () => {
    attempts += 1;
    if (attempts < 4) {
      const error = new Error(
        "The pogo bridge stopped safely: no framed temple response.",
      );
      error.pogoBridgeEvidence = {
        baselineHex: "810004aeae03812022ff",
        transmitted: 5,
        responseStatus: 6,
        responseStatusLabel: "no framed temple response",
      };
      throw error;
    }
    return { route: "left", operation: "version" };
  };
  session.readTempleFlashPreflight = async () => ({ caseVersion: "1.2.57" });

  const result = await session.probeRunningTemple("version", "left");
  assert.deepEqual(result, { route: "left", operation: "version" });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [15_000, 45_000, 90_000]);
  assert.match(logs[0][0], /charging renegotiation/);
});

test("exhausts the settle ladder on a persistently silent temple", async () => {
  const waits = [];
  const session = new G2CaseSession(null, {
    wait: async (milliseconds) => waits.push(milliseconds),
    log: () => {},
  });
  let attempts = 0;
  session.probeRunningTempleOnce = async () => {
    attempts += 1;
    const error = new Error(
      "The pogo bridge stopped safely: no framed temple response.",
    );
    error.pogoBridgeEvidence = {
      baselineHex: "810004aeae03812022ff",
      transmitted: 5,
      responseStatus: 6,
      responseStatusLabel: "no framed temple response",
    };
    throw error;
  };
  session.readTempleFlashPreflight = async () => ({ caseVersion: "1.2.57" });

  await assert.rejects(
    () => session.probeRunningTemple("version", "left"),
    /no framed response after 6 fully-restored probes/,
  );
  assert.equal(attempts, 6);
  assert.deepEqual(waits, [15_000, 45_000, 90_000, 180_000, 300_000]);
});

test("classifies only the exact writer route-phase setup stop for a Case settle retry", () => {
  assert.equal(
    isPogoRoutePhaseMismatch(
      new PogoFlashSafetyError(
        "The Case bridge stopped during setup: YHM baseline is not an allowlisted seated-idle state.",
      ),
    ),
    true,
  );
  assert.equal(
    isPogoRoutePhaseMismatch(
      new PogoFlashSafetyError(
        "The Case bridge stopped during setup: selected route failed.",
      ),
    ),
    false,
  );
  assert.equal(
    isPogoRoutePhaseMismatch(
      new Error(
        "The Case bridge stopped during setup: YHM baseline is not an allowlisted seated-idle state.",
      ),
    ),
    false,
  );
});

test("classifies only an explicit temple DATA rejection for exact replay", () => {
  assert.equal(
    isExplicitTempleDataRejection(
      new TempleRejectedError("synthetic explicit DATA rejection"),
    ),
    true,
  );
  assert.equal(
    isExplicitTempleDataRejection(
      new RetryablePogoFlashError("synthetic missing or malformed reply"),
    ),
    false,
  );
});

test("paces deferred DATA batches more conservatively late in the image", () => {
  const totalBytes = 3_523_396;
  assert.equal(templeDataSettleMilliseconds(1_000, totalBytes), 0);
  assert.equal(templeDataSettleMilliseconds(6_000, totalBytes), 1000);
  assert.equal(templeDataSettleMilliseconds(2_640_000, totalBytes), 1000);
  assert.equal(templeDataSettleMilliseconds(2_646_000, totalBytes), 2000);
  assert.equal(templeDataSettleMilliseconds(totalBytes, totalBytes), 15000);
  assert.throws(
    () => templeDataSettleMilliseconds(totalBytes + 1, totalBytes),
    /valid accepted and total byte counts/,
  );
});

test("pins the hardware-validated volatile flash bridge", async () => {
  const payload = await getVerifiedPogoFlashBridgePayload();
  const observed33Payload = await getVerifiedPogoFlashBridgePayload(
    YHM_PROFILE_OBSERVED_33,
  );
  assert.equal(payload.length, POGO_FLASH_BRIDGE_BYTES);
  assert.equal(await sha256Hex(payload), POGO_FLASH_BRIDGE_SHA256);
  assert.equal(
    await sha256Hex(observed33Payload),
    POGO_FLASH_BRIDGE_OBSERVED_33_SHA256,
  );
  assert.deepEqual(
    [...observed33Payload]
      .map((value, index) => [index, payload[index], value])
      .filter(([, reviewed, observed]) => reviewed !== observed),
    [
      [2826, 0x22, 0x33],
      [2836, 0x22, 0x33],
      [2846, 0x22, 0x33],
      [2856, 0x22, 0x33],
    ],
  );
  assert.deepEqual(
    [...payload.subarray(0, 8)],
    [0x00, 0xf0, 0x01, 0x20, 0x09, 0x00, 0x01, 0x20],
  );
});

test("matches recovered temple request and CRC vectors", () => {
  assert.equal(crc16CcittFalse(new TextEncoder().encode("123456789")), 0x29b1);
  assert.equal(Buffer.from(makeTempleVersionRequest()).toString("hex"), "24000100a7");
  assert.equal(Buffer.from(makeOtaStartRequest()).toString("hex"), "52000000d4");
  assert.equal(Buffer.from(makeOtaFinishRequest()).toString("hex"), "55000000d7");
  assert.equal(
    Buffer.from(makeOtaDataRequest(new Uint8Array(), true, 0)).toString("hex"),
    "54000004000100ffff",
  );
  assert.equal(
    Buffer.from(makePogoFlashHostStressHeader(7, 1)).toString("hex"),
    "47325453010701000029",
  );
});

test("validates setup, stop-and-wait framing, and bridge response checksums", () => {
  const setup = makePogoFlashSetup("right");
  assert.equal(Buffer.from(setup).toString("hex"), "4732465701010142005b");
  const ready = new Uint8Array([
    0x47, 0x32, 0x52, 0x44, 1, 0, 1, 0x42, 0xff, 3, 0xff, 3, 0,
  ]);
  ready[12] = ready
    .subarray(0, 12)
    .reduce((sum, value) => (sum + value) & 0xff, 0);
  assert.deepEqual(parsePogoFlashReady(ready, setup), {
    route: "right",
    baselineMask: 0x3ff,
    selectedMask: 0x3ff,
  });
  assert.equal(
    Buffer.from(makePogoFlashTransactionHeader(7, 1009)).toString("hex"),
    "473254580107f1030021",
  );

  const captured = makeTempleFrame(new Uint8Array([0x54, 1, 3, 1, 0]));
  const response = makeBridgeResponse(7, captured);
  assert.deepEqual(parsePogoFlashResponse(response.header, response.tail, 7), {
    sequence: 7,
    status: 0,
    uartErrors: 0,
    otaState: 0,
    captured,
  });
  response.tail[0] ^= 1;
  assert.throws(
    () => parsePogoFlashResponse(response.header, response.tail, 7),
    RetryablePogoFlashError,
  );
});

test("resynchronizes to a complete retransmitted response without replaying a request", async () => {
  const captured = makeTempleFrame(new Uint8Array([0x54, 1, 3, 1, 0]));
  const response = makeBridgeResponse(7, captured);
  const queued = new Uint8Array(2 + response.header.length);
  queued.set(response.header.subarray(0, 2));
  queued.set(response.header, 2);
  let offset = 0;
  let discardedBytes = 0;
  const header = await readPogoFlashResponseHeader(
    {
      async readExact(count) {
        const result = queued.slice(offset, offset + count);
        offset += result.length;
        if (result.length !== count) throw new Error("synthetic short read");
        return result;
      },
    },
    1000,
    (discarded) => {
      discardedBytes = discarded;
    },
  );
  assert.deepEqual(header, response.header);
  assert.equal(discardedBytes, 2);
});

test("waits through an incomplete cached G2RX header for another retransmission", async () => {
  const captured = makeTempleFrame(new Uint8Array([0x54, 1, 3, 1, 0]));
  const response = makeBridgeResponse(7, captured);
  const timeout = new Error(
    "Timed out reading flash bridge response header byte: received 0 of 1 bytes.",
  );
  const events = [
    ...response.header.subarray(0, 2),
    ...response.header.subarray(0, 7),
    timeout,
    ...response.header,
  ];
  const incompleteCandidates = [];
  let writes = 0;
  const header = await readPogoFlashResponseHeader(
    {
      async readExact(count) {
        assert.equal(count, 1);
        const event = events.shift();
        if (event instanceof Error) throw event;
        assert.notEqual(event, undefined);
        return Uint8Array.of(event);
      },
      async write() {
        writes += 1;
      },
    },
    1000,
    () => {},
    (receivedSuffixBytes) => {
      incompleteCandidates.push(receivedSuffixBytes);
    },
  );

  assert.deepEqual(header, response.header);
  assert.deepEqual(incompleteCandidates, [3]);
  assert.equal(writes, 0);
});

test("replaces an incomplete cached header when the next G2RX arrives immediately", async () => {
  const captured = makeTempleFrame(new Uint8Array([0x54, 1, 3, 1, 0]));
  const response = makeBridgeResponse(7, captured);
  const events = [
    ...response.header.subarray(0, 7),
    ...response.header,
  ];
  const incompleteCandidates = [];

  const header = await readPogoFlashResponseHeader(
    {
      async readExact(count) {
        assert.equal(count, 1);
        const event = events.shift();
        assert.notEqual(event, undefined);
        return Uint8Array.of(event);
      },
    },
    1000,
    () => {},
    (receivedSuffixBytes) => {
      incompleteCandidates.push(receivedSuffixBytes);
    },
  );

  assert.deepEqual(header, response.header);
  assert.deepEqual(incompleteCandidates, [3]);
});

test("recovers a truncated response payload from a later cached frame without writing", async () => {
  const captured = makeTempleFrame(new Uint8Array([0x54, 1, 3, 1, 0]));
  const response = makeBridgeResponse(7, captured);
  const timeout = new Error(
    "Timed out reading flash bridge response payload byte: received 0 of 1 bytes.",
  );
  const events = [
    ...response.header,
    ...response.tail.subarray(0, 7),
    timeout,
    ...response.header,
    ...response.tail,
  ];
  const incompleteCandidates = [];
  let writes = 0;
  const parsed = await readPogoFlashResponseFrame(
    {
      async readExact(count) {
        assert.equal(count, 1);
        const event = events.shift();
        if (event instanceof Error) throw event;
        assert.notEqual(event, undefined);
        return Uint8Array.of(event);
      },
      async write() {
        writes += 1;
      },
    },
    1000,
    7,
    {
      onIncompleteCandidate: (candidate) =>
        incompleteCandidates.push(candidate),
    },
  );

  assert.deepEqual(parsed, {
    sequence: 7,
    status: 0,
    uartErrors: 0,
    otaState: 0,
    captured,
  });
  assert.deepEqual(incompleteCandidates, [
    {
      stage: "payload",
      receivedBytes: 7,
      expectedBytes: 11,
      sequence: 7,
      capturedLength: 10,
    },
  ]);
  assert.equal(writes, 0);
});

test("rejects a stale cached sequence and waits passively for the requested frame", async () => {
  const captured = makeTempleFrame(new Uint8Array([0x54, 1, 3, 1, 0]));
  const stale = makeBridgeResponse(6, captured);
  const current = makeBridgeResponse(7, captured);
  const events = [
    ...stale.header,
    ...current.header,
    ...current.tail,
  ];
  const rejected = [];
  const parsed = await readPogoFlashResponseFrame(
    {
      async readExact(count) {
        assert.equal(count, 1);
        const event = events.shift();
        assert.notEqual(event, undefined);
        return Uint8Array.of(event);
      },
    },
    1000,
    7,
    {
      onRejectedCandidate: (candidate) => rejected.push(candidate),
    },
  );

  assert.equal(parsed.sequence, 7);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /stale response sequence 6/);
});

test("requires exact temple reply shapes and zero status", () => {
  const version = decodeTempleVersion(
    makeTempleFrame(new Uint8Array([0x24, 1, 3, 5, 2, 2, 6, 10, 5])),
  );
  assert.deepEqual(version, { firmware: "2.2.6.10", hardware: 5 });
  requireOtaAcknowledgement(
    makeTempleFrame(new Uint8Array([0x54, 1, 3, 1, 0])),
    0x54,
  );
  assert.throws(() => {
    try {
      requireOtaAcknowledgement(
        makeTempleFrame(new Uint8Array([0x54, 1, 3, 1, 1])),
        0x54,
      );
    } catch (error) {
      assert.equal(error instanceof TempleRejectedError, true);
      assert.equal(error.command, 0x54);
      assert.equal(error.status, 1);
      throw error;
    }
  }, TempleRejectedError);
});

test("binds retained restoration proof to route and final host sequence", () => {
  const result = new Uint8Array(POGO_FLASH_RESULT_LENGTH);
  for (const [offset, value] of [
    [0, 0x57463247],
    [4, 3],
    [8, 1],
    [12, 0x63],
    [16, 0],
    [20, 0x3ff],
    [24, 0x3ff],
    [28, 0x3ff],
    [40, 3540],
    [44, OFFICIAL_MAIN_BYTES],
    [48, OFFICIAL_MAIN_BYTES],
    [60, 0],
  ]) {
    writeU32LE(result, offset, value);
  }
  const baseline = Uint8Array.from([0x81, 0, 4, 0xae, 0xae, 3, 0x81, 0x20, 0x22, 0xff]);
  result.set(baseline, 64);
  result.set(baseline, 84);
  const report = parsePogoFlashRetainedResult(
    result,
    POGO_FLASH_PROOF,
    "right",
    0x63,
    {
      expectedAcceptedSize: OFFICIAL_MAIN_BYTES,
      expectedOtaSequence: 3540,
    },
  );
  assert.equal(report.restoredMask, 0x3ff);
  assert.throws(
    () => parsePogoFlashRetainedResult(result, POGO_FLASH_PROOF, "left", 0x63),
    PogoFlashSafetyError,
  );
  assert.throws(
    () => parsePogoFlashRetainedResult(result, POGO_FLASH_PROOF, "right", 0x64),
    PogoFlashSafetyError,
  );
  writeU32LE(result, 48, OFFICIAL_MAIN_BYTES - 1);
  assert.throws(
    () =>
      parsePogoFlashRetainedResult(
        result,
        POGO_FLASH_PROOF,
        "right",
        0x63,
        {
          expectedAcceptedSize: OFFICIAL_MAIN_BYTES,
          expectedOtaSequence: 3540,
        },
      ),
    PogoFlashSafetyError,
  );
});

test("retains zero-byte setup diagnostics without treating them as cleanup proof", () => {
  const result = new Uint8Array(POGO_FLASH_RESULT_LENGTH);
  writeU32LE(result, 0, 0x57463247);
  writeU32LE(result, 4, 3);
  writeU32LE(result, 8, 1);
  writeU32LE(result, 12, 0x42);
  writeU32LE(result, 16, 3);
  writeU32LE(result, 20, 0x3ff);
  result.set(
    Uint8Array.from([0x81, 0x10, 0x04, 0xae, 0xaf, 0x03, 0x81, 0x20, 0x22, 0xff]),
    64,
  );
  const report = decodePogoFlashRetainedResult(result);
  assert.equal(report.status, 3);
  assert.equal(report.acceptedSize, 0);
  assert.equal(Buffer.from(report.baseline).toString("hex"), "811004aeaf03812022ff");
  const phaseStop = verifyPogoFlashOppositePhaseStop(
    result,
    POGO_FLASH_PROOF,
    "right",
  );
  assert.equal(phaseStop.phaseCompatibleRoute, "left");
  assert.equal(phaseStop.noMutationPhaseStopVerified, true);
  assert.equal(
    verifyPogoFlashOppositePhaseStop(result, POGO_FLASH_PROOF, "left"),
    null,
  );
  assert.throws(
    () => parsePogoFlashRetainedResult(result, POGO_FLASH_PROOF, "left", 0),
    /does not prove a complete byte-for-byte route restoration/,
  );
});

test("proves the observed 33ff baseline stopped before route selection or OTA bytes", () => {
  const result = new Uint8Array(POGO_FLASH_RESULT_LENGTH);
  writeU32LE(result, 0, 0x57463247);
  writeU32LE(result, 4, 3);
  writeU32LE(result, 8, 1);
  writeU32LE(result, 12, 0x42);
  writeU32LE(result, 16, 3);
  writeU32LE(result, 20, 0x3ff);
  result.set(
    Uint8Array.from([0x81, 0x10, 0x04, 0xae, 0xaf, 0x03, 0x81, 0x20, 0x33, 0xff]),
    64,
  );

  const setupStop = verifyPogoFlashZeroWriteSetupStop(
    result,
    POGO_FLASH_PROOF,
    "right",
  );
  assert.equal(setupStop.baselineHex, "811004aeaf03812033ff");
  assert.equal(setupStop.baselineAllowlisted, false);
  assert.equal(setupStop.phaseCompatibleRoute, null);
  assert.equal(setupStop.noMutationSetupStopVerified, true);
  assert.equal(setupStop.acceptedSize, 0);
  assert.equal(
    verifyPogoFlashOppositePhaseStop(result, POGO_FLASH_PROOF, "right"),
    null,
  );
  const observed33Stop = verifyPogoFlashZeroWriteSetupStop(
    result,
    POGO_FLASH_PROOF,
    "right",
    YHM_PROFILE_OBSERVED_33,
  );
  assert.equal(
    observed33Stop.baselineProfile,
    YHM_PROFILE_OBSERVED_33,
  );
  assert.equal(observed33Stop.baselineAllowlisted, true);
  assert.equal(observed33Stop.phaseCompatibleRoute, "left");
  assert.equal(
    verifyPogoFlashOppositePhaseStop(
      result,
      POGO_FLASH_PROOF,
      "right",
      YHM_PROFILE_OBSERVED_33,
    ).noMutationPhaseStopVerified,
    true,
  );

  const routeResult = {
    outcome: "failed_or_uncertain",
    failureStage: "setup",
    otaMutationAttempted: false,
    acceptedFirmwareBytes: 0,
    caseRestoreVerified: true,
    caseApplicationVersion: "1.2.57",
    retainedResult: setupStop,
    recoveryBoundary: classifyPogoFlashRecoveryBoundary(
      new Error(
        "The Case bridge stopped during setup: YHM baseline is not an allowlisted seated-idle state.",
      ),
      setupStop,
      "setup",
    ),
  };
  assert.equal(canResetAfterZeroWriteSetupStop(routeResult, 0), true);
  assert.equal(canResetAfterZeroWriteSetupStop(routeResult, 1), true);
  assert.equal(canResetAfterZeroWriteSetupStop(routeResult, 2), false);
  assert.equal(
    canResetAfterZeroWriteSetupStop(
      {
        ...routeResult,
        retainedResult: { ...setupStop, writeMask: 1 },
      },
      0,
    ),
    false,
  );
});

test("accepts an exact retained restoration after a host-only response timeout", () => {
  const result = new Uint8Array(POGO_FLASH_RESULT_LENGTH);
  for (const [offset, value] of [
    [0, 0x57463247],
    [4, 3],
    [8, 1],
    [12, 0x88],
    [16, 16],
    [20, 0x3ff],
    [24, 0x3ff],
    [28, 0x3ff],
    [44, OFFICIAL_MAIN_BYTES],
    [48, 904000],
    [60, 0],
    [120, 1],
  ]) {
    writeU32LE(result, offset, value);
  }
  const baseline = Uint8Array.from([
    0x81, 0x11, 0x04, 0xaf, 0xaf, 0x03, 0x81, 0x20, 0x22, 0xff,
  ]);
  result.set(baseline, 64);
  result.set(
    Uint8Array.from([
      0x81, 0x01, 0x0c, 0xaf, 0xa6, 0x03, 0xc1, 0x05, 0x22, 0xff,
    ]),
    74,
  );
  result.set(baseline, 84);
  const report = verifyPogoFlashHostTimeoutRestoration(
    result,
    POGO_FLASH_PROOF,
    "right",
  );
  assert.equal(report.hostTimeoutRestorationVerified, true);
  assert.equal(report.acceptedSize, 904000);
  assert.equal(
    verifyPogoFlashHostTimeoutRestoration(
      result,
      POGO_FLASH_PROOF,
      "left",
    ),
    null,
  );
  result[84] ^= 1;
  assert.equal(
    verifyPogoFlashHostTimeoutRestoration(
      result,
      POGO_FLASH_PROOF,
      "right",
    ),
    null,
  );
});

test("classifies zero-byte no-frame START as the BLE fallback boundary", () => {
  const recovery = classifyPogoFlashRecoveryBoundary(
    new Error("no complete temple frame through Case bridge"),
    { declaredSize: 0, acceptedSize: 0, templeTxCount: 2 },
    "START",
  );
  assert.equal(
    recovery.classification,
    "wired_start_no_frame_zero_byte_boundary",
  );
  assert.equal(recovery.startOrHeaderReplayAllowed, false);
  assert.match(recovery.recommendedNextTransport, /BLE full-package/);
  assert.equal(
    classifyPogoFlashRecoveryBoundary(
      new Error("no complete temple frame through Case bridge"),
      { declaredSize: 3532396, acceptedSize: 1000 },
      "START",
    ),
    null,
  );
  assert.equal(
    classifyPogoFlashRecoveryBoundary(
      new Error("no complete temple frame through Case bridge"),
      { declaredSize: 0, acceptedSize: 0, templeTxCount: 1 },
      "PREFLIGHT",
    ),
    null,
  );
});

test("classifies a bounded non-idle YHM setup as a zero-byte stop", () => {
  const recovery = classifyPogoFlashRecoveryBoundary(
    new Error(
      "The Case bridge stopped during setup: YHM baseline is not an allowlisted seated-idle state.",
    ),
    null,
    "setup",
  );
  assert.equal(
    recovery.classification,
    "yhm_setup_non_idle_zero_byte_boundary",
  );
  assert.equal(recovery.firmwareBytesAccepted, 0);
  assert.equal(recovery.otaMutationAttempted, false);
  assert.equal(
    recovery.wiredRetryPolicy,
    "bounded_cleanup_deb0_then_fresh_setup",
  );
  assert.match(recovery.recoveryRecommendation, /bounded bilateral DEB0/);
  assert.equal(
    classifyPogoFlashRecoveryBoundary(
      new Error(
        "The Case bridge stopped during setup: YHM baseline is not an allowlisted seated-idle state.",
      ),
      null,
      "PREFLIGHT",
    ),
    null,
  );
});

test("promotes an exhausted zero-byte YHM setup to the Bluetooth fallback", () => {
  const routeResult = {
    route: "left",
    outcome: "failed_or_uncertain",
    failureStage: "setup",
    otaMutationAttempted: false,
    acceptedFirmwareBytes: 0,
    caseRestoreVerified: true,
    caseApplicationVersion: "1.2.57",
    retainedResult: {
      status: 3,
      selectedMask: 0,
      restoredMask: 0,
      writeMask: 0,
      declaredSize: 0,
      acceptedSize: 0,
      templeTxCount: 0,
      templeRxCount: 0,
      noMutationSetupStopVerified: true,
    },
    recoveryBoundary: {
      classification: "yhm_setup_non_idle_zero_byte_boundary",
    },
  };
  assert.deepEqual(
    classifyExhaustedYhmSetupBoundary(routeResult, {
      settleAttempts: 4,
      settleLimit: 4,
      resetAttempts: 2,
      resetLimit: 2,
    }),
    {
      classification: "yhm_setup_exhausted_zero_byte_boundary",
      route: "left",
      firmwareBytesAccepted: 0,
      otaMutationAttempted: false,
      settleAttempts: 4,
      resetAttempts: 2,
      additionalWiredSetupAllowed: false,
      recommendedNextTransport: "fresh Bluetooth full-package recovery",
      recoveryRecommendation:
        "The Case-to-pogo writer exhausted its bounded settle and reset/recheck attempts before route selection, with immutable proof that no firmware bytes were sent on this route. Preserve every route already verified at the target and do not loop another wired Apply. Use the Direct recovery fallback to install the complete pinned package over a fresh Bluetooth connection; target-proven routes can be retained without rewriting them.",
    },
  );
  assert.equal(
    classifyExhaustedYhmSetupBoundary(routeResult, {
      settleAttempts: 4,
      settleLimit: 4,
      resetAttempts: 1,
      resetLimit: 2,
    }),
    null,
  );
  assert.equal(
    classifyExhaustedYhmSetupBoundary(
      {
        ...routeResult,
        retainedResult: {
          ...routeResult.retainedResult,
          templeTxCount: 1,
        },
      },
      {
        settleAttempts: 4,
        settleLimit: 4,
        resetAttempts: 2,
        resetLimit: 2,
      },
    ),
    null,
  );
});

test("the writer's setup stop skips the ladder rung that is too short for it", () => {
  // The read-only version path still clears a post-reset route on the 15 s
  // rung, so the ladder keeps it. The writer's zero-write setup stop does not:
  // on 2026-07-28 it hit 15 s twice on a temple at 100 % battery (status 3)
  // and only cleared on 45 s, costing a wasted setup round trip every run.
  assert.equal(POGO_READ_ONLY_PHASE_SETTLE_MS[0], 15_000);
  assert.equal(POGO_SETUP_STOP_FIRST_SETTLE_INDEX, 1);
  assert.equal(
    POGO_READ_ONLY_PHASE_SETTLE_MS[POGO_SETUP_STOP_FIRST_SETTLE_INDEX],
    45_000,
    "the writer's first settle must be the 45 s rung that cleared on hardware",
  );
  // Skipping a rung must not silently cost the writer its long tail: the
  // post-reset charging window runs to minutes and the ladder has to outlast it.
  const writerLadder = POGO_READ_ONLY_PHASE_SETTLE_MS.slice(
    POGO_SETUP_STOP_FIRST_SETTLE_INDEX,
  );
  assert.deepEqual(writerLadder, [45_000, 90_000, 180_000, 300_000]);
  assert.equal(
    writerLadder.reduce((total, value) => total + value, 0),
    615_000,
  );
});

test("pins every temple-flash target to a distinct image and main digest", () => {
  assert.ok(TEMPLE_FLASH_TARGETS.length >= 2, "expected stock images beside the experimental");
  const images = new Set(TEMPLE_FLASH_TARGETS.map((t) => t.imageSha256));
  const mains = new Set(TEMPLE_FLASH_TARGETS.map((t) => t.mainSha256));
  assert.equal(images.size, TEMPLE_FLASH_TARGETS.length);
  assert.equal(mains.size, TEMPLE_FLASH_TARGETS.length);
  for (const target of TEMPLE_FLASH_TARGETS) {
    assert.match(target.imageSha256, /^[0-9a-f]{64}$/);
    assert.match(target.mainSha256, /^[0-9a-f]{64}$/);
    assert.ok(target.mainBytes > 0);
    assert.equal(typeof target.hardwareValidated, "boolean");
  }
  const validated = TEMPLE_FLASH_TARGETS.filter((t) => t.hardwareValidated);
  assert.deepEqual(
    validated.map((t) => t.imageSha256),
    [REVIEWED_STOCK_IMAGE_SHA256],
    "only offered targets may retain hardware-validation status",
  );
});

test("keeps the generated pin table in sync with the firmware archive", async () => {
  const index = JSON.parse(
    await readFile(
      new URL(
        "../public/firmware-updates/index.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const expected = index.releases
    .map((release) => ({
      release,
      main: (release.components ?? []).find(
        (c) => c.name === "ota/s200_firmware_ota.bin" && c.typeId === 0,
      ),
    }))
    .filter(({ main }) => main?.sha256)
    .map(({ release, main }) => ({
      imageSha256: release.sha256,
      mainSha256: main.sha256,
      mainBytes: main.size,
      version: release.internalVersion ?? release.version,
      reportedVersion:
        release.reportedVersion ?? release.internalVersion ?? release.version,
      hardwareValidated: HARDWARE_VALIDATED_IMAGE_SHA256.has(release.sha256),
    }));
  assert.deepEqual(
    TEMPLE_FLASH_TARGETS.map(({ label, ...rest }) => rest),
    expected,
    "run `npm run archive:firmware` to regenerate src/lib/templeFlashTargets.js",
  );
});

test("accepts a pinned stock main but still rejects a mismatched payload", async () => {
  const stock = TEMPLE_FLASH_TARGETS.find(
    (t) => !t.hardwareValidated && t.label.startsWith("Stock"),
  );
  const make = (payload, payloadSha256) => ({
    kind: "bundle",
    fileSha256: stock.imageSha256,
    g2Version: stock.version,
    mainComponent: {
      name: "ota/s200_firmware_ota.bin",
      typeId: 0,
      header: new Uint8Array(128),
      payload,
      payloadSha256,
    },
  });
  // Right length, wrong bytes: the gate re-hashes, so this must fail closed.
  await assert.rejects(
    () => assertPinnedTempleFlashCandidate(
      make(new Uint8Array(stock.mainBytes), stock.mainSha256),
    ),
    PogoFlashSafetyError,
  );
});

test("makes the dual-temple reset the final restore mutation and verifies liveness", async () => {
  const events = [];
  const session = new G2CaseSession(null, {
    log: (message) => events.push(`log:${message}`),
    progress: () => {},
    wait: async () => {},
  });
  session.restartAndRecheck = async () => {
    events.push("mutate:DEB0");
    return {
      caseVersion: "1.2.57",
      telemetry: { leftPresent: true, rightPresent: true },
    };
  };
  session.probeRunningTemple = async (operation, route) => {
    events.push(`read:${operation}:${route}`);
    return {
      decoded: { firmwareVersion: "2.2.6.10", hardwareRevision: 5 },
      transportProof: { restoredMask: 0x3ff },
    };
  };
  session.restoreNormal = async () => {
    events.push("read:case-version");
    return { caseVersion: "1.2.57" };
  };

  const report = await session.finalizeTempleRestore(
    ["right", "left"],
    "2.2.6.10",
  );
  assert.equal(report.command, "DEB0");
  assert.equal(report.resetConfirmed, true);
  assert.deepEqual(Object.keys(report.versions), ["right", "left"]);
  assert.equal(
    events.filter((event) => event.startsWith("mutate:")).at(-1),
    "mutate:DEB0",
  );
  assert.deepEqual(
    events.filter((event) => event.startsWith("read:")),
    ["read:version:right", "read:version:left", "read:case-version"],
  );
});

test("closes the reset console and retries telemetry in reopened sessions", async () => {
  const encoder = new TextEncoder();
  const writes = [];
  const transports = [
    {
      outputs: [
        "****** B200 1.2.57 DEVICE******\r\n",
        "reset gls L & R, reason: cmd\r\n",
      ],
    },
    {
      outputs: [
        "",
        "B200 1.2.57, 3\r\n",
        "telemetry unavailable\r\n",
      ],
    },
    {
      outputs: [
        "****** B200 1.2.57 DEVICE******\r\n",
        "B200 1.2.57, 3\r\n",
        "****** B200 vol:4155 pct:100, open:1, usb:1, cur:-9, "
          + "GLS_L:1, GLS_R:1 temp:265, chEn:1, aging:0, otaGls:0\r\n",
      ],
    },
  ].map((fixture, index) => ({
    closed: false,
    clear() {},
    async write(data) {
      writes.push({ index, text: new TextDecoder().decode(data) });
    },
    async collectFor() {
      return encoder.encode(fixture.outputs.shift() ?? "");
    },
    async close() {
      this.closed = true;
    },
  }));
  let openIndex = 0;
  const session = new G2CaseSession(null, {
    openNormal: async () => {
      if (openIndex > 0) {
        assert.equal(
          transports[openIndex - 1].closed,
          true,
          "each reset/telemetry console must close before the next opens",
        );
      }
      return transports[openIndex++];
    },
    wait: async () => {},
  });

  const report = await session.restartAndRecheck();

  assert.equal(openIndex, 3);
  assert.equal(report.resetConfirmed, true);
  assert.equal(report.postResetTelemetrySession, "reopened");
  assert.equal(report.postResetTelemetryAttempt, 2);
  assert.equal(report.telemetry.leftPresent, true);
  assert.equal(report.telemetry.rightPresent, true);
  assert.deepEqual(
    writes.map(({ text }) => text),
    ["DEB0\n", "DEA0\n", "DEA3\n", "DEA0\n", "DEA3\n"],
  );
});

test("re-interrogates DEA0 in fresh sessions until the updated Case version is confirmed", async () => {
  const encoder = new TextEncoder();
  const writes = [];
  const waits = [];
  const transports = [
    { banner: "1.2.56", reply: "1.2.56" },
    // A stale buffered banner must not override the explicit fresh DEA0 reply.
    { banner: "1.2.56", reply: "1.2.57" },
  ].map(({ banner, reply }, index) => ({
    closed: false,
    outputs: [
      `****** B200 ${banner} DEVICE******\r\n`,
      `B200 ${reply}, 3\r\n`,
    ],
    clear() {},
    async write(data) {
      writes.push({ index, text: new TextDecoder().decode(data) });
    },
    async collectFor() {
      return encoder.encode(this.outputs.shift() ?? "");
    },
    async close() {
      this.closed = true;
    },
  }));
  let openIndex = 0;
  const session = new G2CaseSession(null, {
    openNormal: async () => transports[openIndex++],
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  const report = await session.confirmCaseFirmwareVersion("1.2.57", 3);

  assert.equal(report.confirmedVersion, "1.2.57");
  assert.equal(report.confirmationCommand, "DEA0");
  assert.equal(report.confirmationAttempt, 2);
  assert.equal(report.confirmationAttempts, 3);
  assert.deepEqual(
    writes.map(({ text }) => text),
    ["DEA0\n", "DEA0\n"],
  );
  assert.deepEqual(waits, [750]);
  assert.ok(transports.every((transport) => transport.closed));
});

test("blocks glasses flashing evidence when fresh DEA0 never confirms the update", async () => {
  const encoder = new TextEncoder();
  const transports = Array.from({ length: 2 }, () => ({
    outputs: [
      "****** B200 1.2.56 DEVICE******\r\n",
      "B200 1.2.56, 3\r\n",
    ],
    clear() {},
    async write() {},
    async collectFor() {
      return encoder.encode(this.outputs.shift() ?? "");
    },
    async close() {},
  }));
  let openIndex = 0;
  const session = new G2CaseSession(null, {
    openNormal: async () => transports[openIndex++],
    wait: async () => {},
  });

  await assert.rejects(
    () => session.confirmCaseFirmwareVersion("1.2.57", 2),
    /Smart Glasses flashing was not started/,
  );
});

test("standalone reset verifies both temple applications without firmware", async () => {
  const events = [];
  const session = new G2CaseSession(null, { progress: () => {} });
  session.restartAndRecheck = async () => ({
    caseVersion: "1.2.57",
    telemetry: { leftPresent: true, rightPresent: true },
    resetConfirmed: true,
    postResetTelemetrySession: "reopened",
  });
  session.probeRunningTemple = async (operation, route) => {
    events.push(`${operation}:${route}`);
    return {
      decoded: { firmwareVersion: "2.2.6.10", hardwareRevision: 5 },
      transportProof: { restoredMask: 0x3ff },
    };
  };
  session.restoreNormal = async () => {
    events.push("case:restore");
    return { caseVersion: "1.2.57" };
  };

  const report = await session.restartAndVerifyBothTemples();

  assert.deepEqual(events, ["version:right", "version:left", "case:restore"]);
  assert.equal(report.applicationLivenessVerified, true);
  assert.equal(report.firmwareBytesTransmitted, 0);
  assert.equal(report.versions.left.firmware, "2.2.6.10");
  assert.equal(report.versions.right.hardware, 5);
});

test("final verification retries one transient missing-contact reset", async () => {
  const events = [];
  const session = new G2CaseSession(null, {
    log: (message) => events.push(`log:${message}`),
    progress: () => {},
    wait: async () => {},
  });
  let resetAttempt = 0;
  session.restartAndRecheck = async () => {
    resetAttempt += 1;
    events.push(`reset:${resetAttempt}`);
    return {
      caseVersion: "1.2.57",
      telemetry: {
        leftPresent: resetAttempt > 1,
        rightPresent: true,
      },
    };
  };
  session.verifyPostResetTempleLiveness = async (resetReport) => {
    if (!resetReport.telemetry.leftPresent) {
      throw new Error("left: contact did not return after the final B0 reset.");
    }
    return {
      versions: {
        left: { firmware: "2.2.6.10", hardware: 5 },
        right: { firmware: "2.2.6.10", hardware: 5 },
      },
      finalCase: { caseVersion: "1.2.57" },
    };
  };

  const report = await session.restartAndVerifyBothTemples();

  assert.deepEqual(
    events.filter((event) => event.startsWith("reset:")),
    ["reset:1", "reset:2"],
  );
  assert.equal(report.resetAttempts.length, 2);
  assert.equal(report.resetAttempts[0].outcome, "failed");
  assert.equal(report.resetAttempts[1].outcome, "success");
});

test("fails the final restore gate when a selected contact does not return", async () => {
  const session = new G2CaseSession(null, { wait: async () => {} });
  session.restartAndRecheck = async () => ({
    caseVersion: "1.2.57",
    telemetry: { leftPresent: false, rightPresent: true },
  });
  session.probeRunningTemple = async () => {
    throw new Error("must not probe an absent selected route");
  };
  await assert.rejects(
    () => session.finalizeTempleRestore(["left"], "2.2.6.10"),
    /left: contact did not return/,
  );
});

test("attempts failure recovery only after every route has verified cleanup", () => {
  const verified = {
    caseRestoreVerified: true,
    caseApplicationVersion: "1.2.57",
  };
  assert.equal(canRunFinalResetAfterFailure([verified]), true);
  assert.equal(canRunFinalResetAfterFailure([]), false);
  assert.equal(
    canRunFinalResetAfterFailure([
      verified,
      { caseRestoreVerified: false, caseApplicationVersion: "1.2.57" },
    ]),
    false,
  );
});

test("allows one fresh component restart only after a DATA failure and exact cleanup proof", () => {
  const verifiedDataFailure = {
    outcome: "failed_or_uncertain",
    otaMutationAttempted: true,
    failureStage: "DATA:348",
    transfer: null,
    caseRestoreVerified: true,
    caseApplicationVersion: "1.2.57",
    retainedResult: {
      baselineMask: 0x3ff,
      selectedMask: 0x3ff,
      restoredMask: 0x3ff,
      templeUartErrors: 0,
    },
  };
  // Boundaries are asserted against the budgets themselves, so raising a
  // budget for a marginal link cannot silently pass a stale expectation.
  assert.equal(
    canRestartFailedTempleComponent(verifiedDataFailure, 0),
    true,
  );
  assert.equal(
    canRestartFailedTempleComponent(
      verifiedDataFailure,
      POGO_COMPONENT_RESTART_LIMIT - 1,
    ),
    true,
  );
  assert.equal(
    canRestartFailedTempleComponent(
      verifiedDataFailure,
      POGO_COMPONENT_RESTART_LIMIT,
    ),
    false,
  );
  const exactHostTimeout = {
    ...verifiedDataFailure,
    retainedResult: {
      ...verifiedDataFailure.retainedResult,
      status: 16,
      hostTimeoutRestorationVerified: true,
    },
  };
  // A verified host-timeout restoration gets the wider budget.
  assert.ok(
    POGO_HOST_TIMEOUT_COMPONENT_RESTART_LIMIT > POGO_COMPONENT_RESTART_LIMIT,
  );
  assert.equal(
    canRestartFailedTempleComponent(
      exactHostTimeout,
      POGO_HOST_TIMEOUT_COMPONENT_RESTART_LIMIT - 1,
    ),
    true,
  );
  assert.equal(
    canRestartFailedTempleComponent(
      exactHostTimeout,
      POGO_HOST_TIMEOUT_COMPONENT_RESTART_LIMIT,
    ),
    false,
  );
  // Without a verified host-timeout restoration the wider budget must not
  // apply: at the plain budget boundary this is already exhausted.
  assert.equal(
    canRestartFailedTempleComponent(
      {
        ...exactHostTimeout,
        retainedResult: {
          ...exactHostTimeout.retainedResult,
          hostTimeoutRestorationVerified: false,
        },
      },
      POGO_COMPONENT_RESTART_LIMIT,
    ),
    false,
  );
  assert.equal(
    canRestartFailedTempleComponent(
      { ...verifiedDataFailure, failureStage: "HEADER" },
      0,
    ),
    false,
  );
  assert.equal(
    canRestartFailedTempleComponent(
      { ...verifiedDataFailure, caseRestoreVerified: false },
      0,
    ),
    false,
  );
});

test("stops a third full component after repeated restored DATA rejections in one image region", () => {
  const failure = (record, acceptedBytes) => ({
    route: "right",
    outcome: "failed_or_uncertain",
    otaMutationAttempted: true,
    failureStage: `DATA:${record - 1}`,
    transfer: null,
    acceptedFirmwareBytes: acceptedBytes,
    dataRejection: {
      command: 0x54,
      status: 1,
      record,
      recordIndex: record - 1,
      acceptedBytes,
      totalBytes: 3_539_474,
    },
    caseRestoreVerified: true,
    caseApplicationVersion: "1.2.57",
    retainedResult: {
      baselineMask: 0x3ff,
      selectedMask: 0x3ff,
      restoredMask: 0x3ff,
      templeUartErrors: 0,
    },
  });
  const first = failure(2184, 2_183_000);
  const repeated = failure(2219, 2_218_000);
  const boundary = classifyPersistentTempleDataRejection(
    repeated,
    [first],
  );

  assert.deepEqual(boundary, {
    classification: "persistent_temple_data_rejection_boundary",
    route: "right",
    command: 0x54,
    status: 1,
    priorRecord: 2184,
    currentRecord: 2219,
    recordDistance: 35,
    priorAcceptedBytes: 2_183_000,
    currentAcceptedBytes: 2_218_000,
    totalBytes: 3_539_474,
    recordWindow: 64,
    additionalWholeComponentRestartAllowed: false,
    recoveryRecommendation:
      "Repeated Case-USB full-component retries are blocked for this image region. Preserve the audit and use the reviewed fresh-BLE full-package recovery path or device service unless new hardware evidence justifies another wired attempt.",
  });
  assert.equal(
    classifyPersistentTempleDataRejection(
      failure(2300, 2_299_000),
      [first],
    ),
    null,
  );
  assert.equal(
    classifyPersistentTempleDataRejection(
      { ...repeated, caseRestoreVerified: false },
      [first],
    ),
    null,
  );
});

test("a restored DATA rejection at maximum pacing blocks another wired START", () => {
  const failure = {
    route: "right",
    outcome: "failed_or_uncertain",
    otaMutationAttempted: true,
    failureStage: "DATA:530",
    transfer: null,
    caseRestoreVerified: true,
    caseApplicationVersion: "1.2.57",
    retainedResult: {
      baselineMask: 0x3ff,
      selectedMask: 0x3ff,
      restoredMask: 0x3ff,
      templeUartErrors: 0,
    },
    dataPacingPolicy: {
      startLevel: TEMPLE_DATA_PACING_LEVELS.length - 1,
      finalLevel: TEMPLE_DATA_PACING_LEVELS.length - 1,
    },
    dataRejection: {
      command: 0x54,
      status: 1,
      record: 531,
      acceptedBytes: 530_000,
      totalBytes: 3_539_474,
    },
  };
  assert.deepEqual(classifyMaximumPacingTempleDataRejection(failure), {
    classification: "maximum_pacing_temple_data_rejection_boundary",
    route: "right",
    command: 0x54,
    status: 1,
    record: 531,
    acceptedBytes: 530_000,
    totalBytes: 3_539_474,
    pacingLevel: TEMPLE_DATA_PACING_LEVELS.length - 1,
    pacing: TEMPLE_DATA_PACING_LEVELS.at(-1),
    additionalWholeComponentRestartAllowed: false,
    recoveryRecommendation:
      "The temple explicitly rejected DATA after this attempt began at the maximum reviewed Case-USB pacing. Preserve the audit and use the reviewed fresh-BLE full-package recovery path or device service; do not loop another wired START.",
  });
  assert.equal(
    classifyMaximumPacingTempleDataRejection({
      ...failure,
      dataPacingPolicy: {
        ...failure.dataPacingPolicy,
        startLevel: TEMPLE_DATA_PACING_LEVELS.length - 2,
      },
    }),
    null,
  );
});

test("retries one transient intermediate-reset no-frame before a fresh START", async () => {
  assert.equal(
    isRetryablePostResetLivenessFailure(
      new Error("The pogo bridge stopped safely: no framed temple response."),
    ),
    true,
  );
  assert.equal(
    isRetryablePostResetLivenessFailure(
      new Error("left: contact did not return after the final B0 reset."),
    ),
    true,
  );
  assert.equal(
    isRetryablePostResetLivenessFailure(
      new Error(
        "The pogo bridge stopped safely: YHM baseline was not an allowlisted seated-idle state.",
      ),
    ),
    true,
  );
  assert.equal(
    isRetryablePostResetLivenessFailure(
      new Error(
        "The Case did not confirm the traced B0 left/right temple reset command.",
      ),
    ),
    true,
  );

  const events = [];
  const session = new G2CaseSession(null, {
    log: (message) => events.push(`log:${message}`),
    progress: () => {},
    wait: async () => {},
  });
  session.restartAndRecheck = async () => {
    events.push("reset:DEB0");
    return {
      caseVersion: "1.2.57",
      telemetry: { leftPresent: true, rightPresent: true },
    };
  };
  let verificationAttempt = 0;
  session.verifyPostResetTempleLiveness = async () => {
    verificationAttempt += 1;
    events.push(`verify:${verificationAttempt}`);
    if (verificationAttempt === 1) {
      throw new Error(
        "The pogo bridge stopped safely: no framed temple response.",
      );
    }
    return {
      versions: {
        left: { firmware: "2.2.6.10", hardware: 5 },
        right: { firmware: "2.2.6.10", hardware: 5 },
      },
      finalCase: { caseVersion: "1.2.57" },
    };
  };

  const report = await session.resetTempleOtaReceiverForComponentRestart(
    ["left", "right"],
    "2.2.6.10",
    "right",
    1,
    2,
  );
  assert.deepEqual(
    events.filter((event) => event === "reset:DEB0"),
    ["reset:DEB0", "reset:DEB0"],
  );
  assert.equal(report.resetAttempts.length, 2);
  assert.equal(report.resetAttempts[0].outcome, "failed");
  assert.equal(report.resetAttempts[1].outcome, "success");
});

test("link-latency compensation keeps relay distance out of congestion decisions", () => {
  const overhead = new TempleDataPacingController({
    startLevel: 2,
    totalBytes: 3_539_474,
    linkOverheadMs: 600,
  });
  // 2,000 ms measured includes ~600 ms of relay round trip: effective
  // 1,400 ms stays under the 1,500 ms absolute threshold, so no backoff.
  assert.equal(overhead.noteAckLatency(0, 2_000), 0);
  assert.equal(overhead.level, 2);
  assert.equal(overhead.escalations, 0);
  assert.equal(overhead.summary().linkOverheadMs, 600);

  const local = new TempleDataPacingController({
    startLevel: 2,
    totalBytes: 3_539_474,
  });
  // The same measurement without compensation escalates immediately.
  assert.equal(
    local.noteAckLatency(0, 2_000),
    TEMPLE_DATA_PACING_LEVELS[3].late,
  );
  assert.equal(local.level, 3);
});

function withFakeLocalStorage(run) {
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  try {
    return run(store);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

test("route YHM profiles persist per exact case serial and reject unknown profiles", () => {
  withFakeLocalStorage((store) => {
    writeYhmRouteProfileMemory("case-a", "left", YHM_PROFILE_OBSERVED_33);
    writeYhmRouteProfileMemory("case-a", "right", YHM_PROFILE_REVIEWED_22);
    writeYhmRouteProfileMemory("case-b", "left", YHM_PROFILE_REVIEWED_22);
    assert.deepEqual(readYhmRouteProfileMemory("case-a"), {
      left: YHM_PROFILE_OBSERVED_33,
      right: YHM_PROFILE_REVIEWED_22,
    });
    assert.deepEqual(readYhmRouteProfileMemory("case-b"), {
      left: YHM_PROFILE_REVIEWED_22,
    });
    assert.deepEqual(readYhmRouteProfileMemory("case-unknown"), {});

    // A tampered or outdated profile name is ignored rather than trusted.
    const parsed = JSON.parse(store.get("g2wf.yhm-route-profiles.v1"));
    parsed["case-a"].left = "unreviewed-99";
    store.set("g2wf.yhm-route-profiles.v1", JSON.stringify(parsed));
    assert.deepEqual(readYhmRouteProfileMemory("case-a"), {
      right: YHM_PROFILE_REVIEWED_22,
    });
  });
});

test("route YHM profile memory prunes the oldest cases beyond its cap", () => {
  withFakeLocalStorage((store) => {
    for (let index = 0; index < 40; index += 1) {
      writeYhmRouteProfileMemory(`case-${index}`, "left", YHM_PROFILE_OBSERVED_33);
      const parsed = JSON.parse(store.get("g2wf.yhm-route-profiles.v1"));
      parsed[`case-${index}`].updatedAt = index;
      store.set("g2wf.yhm-route-profiles.v1", JSON.stringify(parsed));
    }
    const parsed = JSON.parse(store.get("g2wf.yhm-route-profiles.v1"));
    assert.equal(Object.keys(parsed).length, 32);
    assert.equal(parsed["case-0"], undefined);
    assert.deepEqual(readYhmRouteProfileMemory("case-39"), {
      left: YHM_PROFILE_OBSERVED_33,
    });
  });
});

test("a repeat session for the same case starts from its proven YHM profiles", () => {
  withFakeLocalStorage(() => {
    const first = new G2CaseSession(null, { log: () => {} });
    first.adoptCaseIdentity("00240024514250032037384b");
    first.rememberRouteYhmProfile("left", YHM_PROFILE_OBSERVED_33);
    first.rememberRouteYhmProfile("right", YHM_PROFILE_OBSERVED_33);

    const logs = [];
    const second = new G2CaseSession(null, {
      log: (message) => logs.push(message),
    });
    // Live evidence recorded before identity arrives is never overridden.
    second.routeYhmProfiles.set("right", YHM_PROFILE_REVIEWED_22);
    second.adoptCaseIdentity("00240024514250032037384b");
    assert.equal(
      second.routeYhmProfiles.get("left"),
      YHM_PROFILE_OBSERVED_33,
    );
    assert.equal(
      second.routeYhmProfiles.get("right"),
      YHM_PROFILE_REVIEWED_22,
    );
    assert.match(logs.join("\n"), /proven for this exact Case/);

    const other = new G2CaseSession(null, { log: () => {} });
    other.adoptCaseIdentity("different-case-serial");
    assert.equal(other.routeYhmProfiles.size, 0);
  });
});

test("a transport failure mid-DATA does not slow the remembered pacing level", async () => {
  // Regression, observed on hardware 2026-07-28: a remote-support relay
  // session expiring mid-transfer committed a "failed" pacing outcome. The
  // next run then started one level slower and paid that settle on every
  // record, though nothing about the temple had misbehaved. Only an explicit
  // temple rejection is evidence about pacing.
  // A committed failure escalates one level: exactly how the interrupted run
  // at level 3 left the next run starting at level 4.
  assert.deepEqual(nextTempleDataPacingMemory({ level: 2, cleanStreak: 1 }, "failed", 3), {
    level: 4,
    cleanStreak: 0,
  });
  const source = await readFile(new URL("../src/lib/serial.js", import.meta.url), "utf8");
  const guard = source.indexOf("if (!isExplicitTempleDataRejection(error)) throw error;");
  const commit = source.indexOf('pacing.commitMemory("failed")');
  assert.ok(guard !== -1 && commit !== -1);
  assert.ok(
    guard < commit,
    "the explicit-rejection guard must run before the pacing memory is committed",
  );
});

test("a silent DATA record is resent in place instead of ending the attempt", () => {
  // The audited failure signature: the full record left the host
  // (hostChunkOffset 1009), zero UART errors on both sides, and acceptedSize
  // frozen at expectedSequence × 1000 — a route-silent window swallowed the
  // record. That is transient evidence, so the record is resent in place with
  // an escalating settle, bounded per record and per attempt.
  const silent = new RetryablePogoFlashError(
    "No complete temple response arrived through the Case bridge.",
  );
  assert.deepEqual(
    classifyInPlaceDataRecovery(silent, {
      resendsForRecord: 0,
      recoveriesThisAttempt: 0,
    }),
    { action: "resend", settleMs: POGO_DATA_INPLACE_SETTLE_MS[0] },
  );
  // The settle escalates and saturates at the last rung.
  assert.deepEqual(
    classifyInPlaceDataRecovery(silent, {
      resendsForRecord: POGO_DATA_INPLACE_SETTLE_MS.length + 1 <
        POGO_DATA_INPLACE_RESEND_LIMIT
        ? POGO_DATA_INPLACE_SETTLE_MS.length + 1
        : POGO_DATA_INPLACE_RESEND_LIMIT - 1,
      recoveriesThisAttempt: 1,
    }).settleMs,
    POGO_DATA_INPLACE_SETTLE_MS[
      Math.min(
        POGO_DATA_INPLACE_RESEND_LIMIT - 1,
        POGO_DATA_INPLACE_SETTLE_MS.length - 1,
      )
    ],
  );
  // Per-record and per-attempt budgets both end the attempt, which falls to
  // the whole-component restart path exactly as before.
  assert.deepEqual(
    classifyInPlaceDataRecovery(silent, {
      resendsForRecord: POGO_DATA_INPLACE_RESEND_LIMIT,
      recoveriesThisAttempt: POGO_DATA_INPLACE_RESEND_LIMIT,
    }),
    { action: "abort" },
  );
  assert.deepEqual(
    classifyInPlaceDataRecovery(silent, {
      resendsForRecord: 0,
      recoveriesThisAttempt: POGO_DATA_INPLACE_RECOVERY_BUDGET,
    }),
    { action: "abort" },
  );
  assert.throws(
    () =>
      classifyInPlaceDataRecovery(silent, {
        resendsForRecord: -1,
        recoveriesThisAttempt: 0,
      }),
    /nonnegative/,
  );
});

test("a status-1 rejection of a resend advances past the lost-ACK record", () => {
  const duplicateRejected = new TempleRejectedError(
    "The temple rejected 0x54 with status 1.",
    { command: 0x54, status: 1 },
  );
  // On a resend, status 1 is the temple's own sequence guard refusing a
  // duplicate of a record it already committed: advance. A genuine
  // desynchronization is self-correcting — the next record is rejected with
  // a zero resend count and aborts below.
  assert.deepEqual(
    classifyInPlaceDataRecovery(duplicateRejected, {
      resendsForRecord: 1,
      recoveriesThisAttempt: 1,
    }),
    { action: "advance" },
  );
  // A first-transmission rejection is real temple evidence: abort, so the
  // existing pacing commitment and dataRejection bookkeeping run.
  assert.deepEqual(
    classifyInPlaceDataRecovery(duplicateRejected, {
      resendsForRecord: 0,
      recoveriesThisAttempt: 0,
    }),
    { action: "abort" },
  );
  // Any non-sequence rejection of a resend is also real evidence.
  const otherRejected = new TempleRejectedError(
    "The temple rejected 0x54 with status 2.",
    { command: 0x54, status: 2 },
  );
  assert.deepEqual(
    classifyInPlaceDataRecovery(otherRejected, {
      resendsForRecord: 2,
      recoveriesThisAttempt: 2,
    }),
    { action: "abort" },
  );
  // The source must consult the recovery classifier before the pacing guard,
  // and the guard before the pacing memory commit, so a transient can never
  // escalate the remembered level on its way to a resend.
  return readFile(new URL("../src/lib/serial.js", import.meta.url), "utf8").then(
    (source) => {
      const classify = source.indexOf("classifyInPlaceDataRecovery(error, {");
      const guard = source.indexOf(
        "if (!isExplicitTempleDataRejection(error)) throw error;",
      );
      const commit = source.indexOf('pacing.commitMemory("failed")');
      assert.ok(classify !== -1 && guard !== -1 && commit !== -1);
      assert.ok(classify < guard && guard < commit);
    },
  );
});

test("the flash transport reports whether records are batched over a relay", () => {
  assert.deepEqual(describeRemoteTransactOffload({ transportKind: "webusb" }), {
    offloaded: false,
    reason: "local transport",
  });
  assert.deepEqual(
    describeRemoteTransactOffload({
      transportKind: "remote",
      supportsExchangeBatch: () => true,
    }),
    { offloaded: true, reason: null },
  );
  // An old relay omits serialOperations entirely.
  assert.match(
    describeRemoteTransactOffload({
      transportKind: "remote",
      supportsExchangeBatch: () => false,
      connection: {},
    }).reason,
    /relay does not advertise/,
  );
  // A relay that advertises but cannot forward batches.
  assert.match(
    describeRemoteTransactOffload({
      transportKind: "remote",
      supportsExchangeBatch: () => false,
      connection: { serialOperations: ["get_info", "open", "write"] },
    }).reason,
    /relay does not forward batches/,
  );
  // The relay is capable, so the person's browser is the missing leg.
  assert.match(
    describeRemoteTransactOffload({
      transportKind: "remote",
      supportsExchangeBatch: () => false,
      connection: { serialOperations: ["open", "exchange_batch"] },
    }).reason,
    /person's browser does not advertise/,
  );
});

function fakeLine(chunks) {
  const slices = [...chunks];
  const cleared = [];
  const transport = {
    queuedBytes: 0,
    clear() {
      cleared.push(this.queuedBytes);
      this.queuedBytes = 0;
    },
  };
  // Each simulated sleep delivers the next slice of line noise.
  const sleeper = async () => {
    transport.queuedBytes = slices.length ? slices.shift() : 0;
  };
  return { transport, cleared, sleeper };
}

test("the ROM sync waits for the line to go quiet before the sync byte", async () => {
  // Two slices of straggling reset output over a relay, then silence.
  const busy = fakeLine([12, 4, 0]);
  assert.equal(
    await drainUntilQuietLine(busy.transport, {
      remote: true,
      linkRttMs: 300,
      sleeper: busy.sleeper,
    }),
    true,
  );
  // Drained the initial queue plus each noisy slice.
  assert.deepEqual(busy.cleared, [0, 12, 4]);

  // An already-quiet local line proceeds after a single slice.
  const quiet = fakeLine([0]);
  assert.equal(
    await drainUntilQuietLine(quiet.transport, { sleeper: quiet.sleeper }),
    true,
  );
  assert.deepEqual(quiet.cleared, [0]);
});

test("a Case that booted its application still ends the quiet wait", async () => {
  // The application never stops emitting; the wait must stay bounded so the
  // caller's boot-select retry can run.
  const noisy = fakeLine(Array.from({ length: 500 }, () => 9));
  assert.equal(
    await drainUntilQuietLine(noisy.transport, {
      remote: true,
      linkRttMs: 300,
      sleeper: noisy.sleeper,
    }),
    false,
  );
  // Bounded: the initial drain, nine 300 ms slices inside the 2500 ms
  // budget, and the final drain.
  assert.equal(noisy.cleared.length, 11);
});

// Field evidence, remote-support session SBTF-JCML on 2026-07-28: the same
// physical Case (UID 00500041514250052037384b) was filed under its real
// identity in one capture and under the anonymous placeholder in the next,
// because the 96-bit UID is printed only in the power-up banner and the first
// bytes after that reset arrived as mojibake over the relay. The session then
// re-derived observed-33 from scratch and, on a later load, seeded reviewed-22
// from the wrong record. Identity therefore keys on caseDeviceKey, and a
// capture with no readable identifier is repeated once before anything is
// filed.

test("case identity keys per-Case memory on the decoded UID", () => {
  withFakeLocalStorage(() => {
    const uid = "00500041514250052037384b";
    writeYhmRouteProfileMemory(`uid:${uid}`, "left", YHM_PROFILE_OBSERVED_33);
    const logged = [];
    const session = new G2CaseSession(null, {
      log: (message) => logged.push(message),
    });
    session.adoptCaseIdentity({ serialNumber: uid, identifier: null });
    assert.equal(session.caseStorageSerial, `uid:${uid}`);
    // Pacing memory and YHM memory must land on one key, not two.
    assert.equal(session.deviceKey, `uid:${uid}`);
    assert.equal(
      session.routeYhmProfiles.get("left"),
      YHM_PROFILE_OBSERVED_33,
    );
    assert.equal(
      logged.some((line) => line.includes(YHM_PROFILE_OBSERVED_33)),
      true,
    );
    // A profile written this session lands under the same key.
    session.rememberRouteYhmProfile("right", YHM_PROFILE_OBSERVED_33);
    assert.deepEqual(readYhmRouteProfileMemory(`uid:${uid}`), {
      left: YHM_PROFILE_OBSERVED_33,
      right: YHM_PROFILE_OBSERVED_33,
    });
  });
});

test("a Case with no UID still gets memory from its factory identifier", () => {
  withFakeLocalStorage(() => {
    const session = new G2CaseSession(null, { log: () => {} });
    session.adoptCaseIdentity({
      serialNumber: null,
      identifier: "1A 2B 3C 4D 5E 6F 70 81",
    });
    assert.equal(session.caseStorageSerial, "factory:1a2b3c4d5e6f7081");
    session.rememberRouteYhmProfile("left", YHM_PROFILE_OBSERVED_33);
    assert.deepEqual(readYhmRouteProfileMemory("factory:1a2b3c4d5e6f7081"), {
      left: YHM_PROFILE_OBSERVED_33,
    });
  });
});

test("an unidentifiable Case never shares the anonymous memory record", () => {
  withFakeLocalStorage(() => {
    writeYhmRouteProfileMemory(
      "unidentified-case",
      "left",
      YHM_PROFILE_OBSERVED_33,
    );
    const logged = [];
    const session = new G2CaseSession(null, {
      log: (message) => logged.push(message),
    });
    session.adoptCaseIdentity({ serialNumber: null, identifier: null });
    // No identity, so nothing is seeded and nothing claims to be "this exact
    // Case"; live evidence has to derive the profile again.
    assert.equal(session.caseStorageSerial, null);
    assert.equal(session.routeYhmProfiles.size, 0);
    assert.deepEqual(logged, []);
    session.rememberRouteYhmProfile("left", YHM_PROFILE_REVIEWED_22);
    assert.deepEqual(readYhmRouteProfileMemory("unidentified-case"), {
      left: YHM_PROFILE_OBSERVED_33,
    });
  });
});

// analyze() only needs a port object to reach identity adoption; the ROM
// loader that runs afterwards has nothing to talk to and rejects, which is
// where these tests stop.
function fakeAnalyzePort() {
  return { getInfo: () => ({}) };
}

test("a console capture with no readable identifier is repeated once", async () => {
  await withFakeLocalStorage(async () => {
    const captures = [
      // The clipped banner: telemetry survived, the UID line did not.
      {
        text: "****** B200 vol:4088 pct:94, open:1",
        caseVersion: "1.2.57",
        serialNumber: null,
        identifier: null,
      },
      {
        text: "****** B200 1.2.57 00500041514250052037384b******",
        caseVersion: "1.2.57",
        serialNumber: "00500041514250052037384b",
        identifier: null,
      },
    ];
    let calls = 0;
    const logged = [];
    const session = new G2CaseSession(fakeAnalyzePort(), {
      log: (message) => logged.push(message),
      progress: () => {},
    });
    session.captureConsoleReport = async () => captures[calls++];
    // analyze() cannot reach the ROM loader with a null port; identity is
    // adopted before that point, which is what this asserts.
    await assert.rejects(() => session.analyze());
    assert.equal(calls, 2);
    assert.equal(
      session.caseStorageSerial,
      "uid:00500041514250052037384b",
    );
    assert.equal(
      logged.some((line) => line.includes("repeated capture recovered")),
      true,
    );
  });
});

test("a Case that truly reports no identifier is not retried forever", async () => {
  await withFakeLocalStorage(async () => {
    let calls = 0;
    const session = new G2CaseSession(fakeAnalyzePort(), {
      log: () => {},
      progress: () => {},
    });
    session.captureConsoleReport = async () => {
      calls += 1;
      return {
        text: "****** B200 vol:4088 pct:94, open:1",
        caseVersion: "1.2.57",
        serialNumber: null,
        identifier: null,
      };
    };
    await assert.rejects(() => session.analyze());
    assert.equal(calls, 2);
    assert.equal(session.caseStorageSerial, null);
  });
});

test("memory written under the old bare-serial key migrates to the device key", () => {
  withFakeLocalStorage(() => {
    const uid = "00240024514250032037384b";
    // Shape written by releases before identity keyed on caseDeviceKey.
    writeYhmRouteProfileMemory(uid, "left", YHM_PROFILE_OBSERVED_33);
    const session = new G2CaseSession(null, { log: () => {} });
    session.adoptCaseIdentity({ serialNumber: uid, identifier: null });
    assert.equal(
      session.routeYhmProfiles.get("left"),
      YHM_PROFILE_OBSERVED_33,
    );
    assert.deepEqual(readYhmRouteProfileMemory(`uid:${uid}`), {
      left: YHM_PROFILE_OBSERVED_33,
    });
  });
});

test("ACK samples taken while the tab is throttled never escalate pacing", () => {
  // Measured 2026-07-28: the same link and firmware cost 372 ms per record
  // foregrounded and 967 ms hidden. Those hidden samples describe the
  // operator's throttled event loop, not the temple, and previously could
  // trip the congestion threshold and permanently slow the remembered level.
  const warnings = [];
  const controller = new TempleDataPacingController({
    startLevel: 2,
    totalBytes: 3_539_474,
    log: (message, tone) => warnings.push([message, tone]),
    isThrottled: () => true,
  });
  for (let index = 0; index < 40; index += 1) {
    assert.equal(controller.noteAckLatency(index, 9_000), 0);
  }
  assert.equal(controller.level, 2);
  assert.equal(controller.escalations, 0);
  assert.equal(controller.throttledSamples, 40);
  // Nothing throttled reaches the statistics either.
  assert.equal(controller.summary().ackCount, 0);
  assert.equal(controller.summary().baselineMs, null);
  // The operator is told once, not once per record.
  assert.equal(warnings.filter(([, tone]) => tone === "warn").length, 1);
  assert.match(warnings[0][0], /Keep this tab in front/);

  // A genuinely slow temple, measured while visible, still escalates.
  const visible = new TempleDataPacingController({
    startLevel: 2,
    totalBytes: 3_539_474,
    isThrottled: () => false,
  });
  assert.equal(
    visible.noteAckLatency(0, 9_000),
    TEMPLE_DATA_PACING_LEVELS[3].late,
  );
  assert.equal(visible.level, 3);
});

test("the throttle probe reports only a hidden document", () => {
  const original = globalThis.document;
  try {
    globalThis.document = { visibilityState: "hidden" };
    assert.equal(defaultPacingThrottleProbe(), true);
    globalThis.document = { visibilityState: "visible" };
    assert.equal(defaultPacingThrottleProbe(), false);
    delete globalThis.document;
    // Node has no document at all; nothing is throttled there.
    assert.equal(defaultPacingThrottleProbe(), false);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});

test("a buffered complete response is served before a pending pump error", async () => {
  const transport = new SerialTransport({});
  transport.queue = [Uint8Array.of(0x5a, 0xa5, 0xff, 0x00)];
  transport.queuedBytes = 4;
  transport.readError = new Error("CH340 bulk read failed with USB status stall");

  // The device answered in full and THEN the link failed: the answer wins.
  assert.deepEqual(
    [...(await transport.readExact(4, 50, "buffered frame"))],
    [0x5a, 0xa5, 0xff, 0x00],
  );
  // The error stays sticky and surfaces on the next read that needs data.
  await assert.rejects(
    transport.readExact(1, 50, "next frame"),
    /USB status stall/,
  );
});

test("draining buffered bytes preserves the sticky pump error", async () => {
  const transport = new SerialTransport({});
  transport.queue = [Uint8Array.of(1, 2, 3)];
  transport.queuedBytes = 3;
  transport.readError = new Error("USB stall");

  transport.clear();
  assert.equal(transport.queuedBytes, 0);
  // The postflight loop drains this transport every 2 seconds; erasing the
  // error here converted a hard transport fault into a misleading timeout.
  await assert.rejects(transport.readExact(1, 50, "post-drain"), /USB stall/);
});

test("transient transport faults join the bounded post-reset liveness retry", () => {
  assert.equal(
    isRetryablePostResetLivenessFailure(
      new Error("Failed to open serial port."),
    ),
    true,
  );
  assert.equal(
    isRetryablePostResetLivenessFailure(
      new Error("CH340 bulk read failed with USB status stall"),
    ),
    true,
  );
  assert.equal(
    isRetryablePostResetLivenessFailure(new Error("CRC rejected")),
    false,
  );
});

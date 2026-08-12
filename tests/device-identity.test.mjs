import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeviceFingerprint,
  caseDeviceKey,
  decodeCaseUid,
  sameProductionLot,
  usbBridgeRevisionOf,
} from "../src/lib/deviceIdentity.js";
import {
  buildDeviceHistoryEntry,
  detectTempleFirmwareRegression,
  lastRecordedTempleFirmware,
  summarizeDeviceHistory,
  summarizeRouteResult,
} from "../src/lib/deviceHistory.js";

// The two physical Cases observed during the 2026-07-27 hardware session.
const CASE_A = "00310025514250052037384b";
const CASE_B = "00240024514250032037384b";

test("decodes the Case identifier as an STM32 96-bit device ID", () => {
  const a = decodeCaseUid(CASE_A);
  const b = decodeCaseUid(CASE_B);
  assert.equal(a.uid, CASE_A);
  // Same lot bytes, different wafer: the observed relationship between the two
  // Cases, and the reason this value cannot identify a hardware revision.
  assert.equal(a.lotHex, b.lotHex);
  assert.equal(a.lotAscii, b.lotAscii);
  assert.equal(a.waferNumber, 5);
  assert.equal(b.waferNumber, 3);
  assert.notEqual(a.dieX === b.dieX && a.dieY === b.dieY, true);
});

test("groups Cases by production lot", () => {
  assert.equal(sameProductionLot(CASE_A, CASE_B), true);
  assert.equal(
    sameProductionLot(CASE_A, "0031002551425005203738ff"),
    false,
  );
});

test("rejects malformed identifiers rather than inventing structure", () => {
  assert.equal(decodeCaseUid(""), null);
  assert.equal(decodeCaseUid("00310025"), null);
  assert.equal(decodeCaseUid(null), null);
  assert.equal(decodeCaseUid(`${CASE_A}ff`), null);
});

test("device keys are stable and never silently merge unknown devices", () => {
  assert.equal(
    caseDeviceKey({ console: { serialNumber: CASE_A } }),
    `uid:${CASE_A}`,
  );
  // Formatting differences must not create a second identity for one Case.
  assert.equal(
    caseDeviceKey({ console: { serialNumber: CASE_A.toUpperCase() } }),
    `uid:${CASE_A}`,
  );
  assert.equal(
    caseDeviceKey({ console: { identifier: "A5 26 03 11" } }),
    "factory:a5260311",
  );
  assert.equal(caseDeviceKey({}), "unidentified-case");
});

test("the fingerprint records what was observed and refuses to infer frame fit", () => {
  const fingerprint = buildDeviceFingerprint({
    report: {
      console: {
        serialNumber: CASE_A,
        identifier: "A5 26 03 11 00 00 08 17",
        caseVersion: "1.2.57",
      },
      options: { activePhysicalBank: 1, inactivePhysicalBank: 2 },
    },
    transport: "WebUSB",
    usbBridgeRevision: 0x30,
    templeVersions: {
      left: { firmware: "2.2.6.11", hardware: 5 },
      right: { firmwareVersion: "2.2.6.10", hardwareRevision: 5 },
    },
    operatorLabel: "Brown case · Frame B",
  });
  assert.equal(fingerprint.deviceKey, `uid:${CASE_A}`);
  assert.equal(fingerprint.case.uidIsProductSerial, false);
  assert.equal(fingerprint.case.uidDecoded.waferNumber, 5);
  assert.equal(fingerprint.transport.usbBridgeRevision, "0x30");
  assert.equal(fingerprint.temples.left.firmware, "2.2.6.11");
  // Accepts either probe shape for temple versions.
  assert.equal(fingerprint.temples.right.firmware, "2.2.6.10");
  assert.equal(fingerprint.temples.right.hardware, 5);
  assert.equal(fingerprint.operatorLabel, "Brown case · Frame B");
  assert.equal(fingerprint.frameVariant.value, null);
  assert.match(fingerprint.frameVariant.reason, /operator label/);
});

test("reads the CH340 revision only where it is actually observable", () => {
  // WebUSB reads the revision during setup; Web Serial ports never expose one.
  assert.equal(usbBridgeRevisionOf({ transportKind: "webusb", version: 0x30 }), 0x30);
  assert.equal(usbBridgeRevisionOf({ transportKind: "webusb", version: 0 }), 0);
  assert.equal(usbBridgeRevisionOf({ transportKind: "serial" }), null);
  assert.equal(usbBridgeRevisionOf(null), null);
});

test("the fingerprint omits an unreadable bridge revision instead of guessing", () => {
  const fingerprint = buildDeviceFingerprint({
    report: { console: { serialNumber: CASE_A } },
    transport: "Web Serial",
  });
  assert.equal(fingerprint.transport.usbBridgeRevision, null);
  assert.equal(fingerprint.transport.kind, "Web Serial");
  assert.deepEqual(fingerprint.temples, { left: null, right: null });
});

test("route summaries carry activation resets and temple OTA state", () => {
  const summary = summarizeRouteResult({
    route: "left",
    outcome: "success",
    acceptedFirmwareBytes: 3542584,
    preflightVersion: { firmware: "2.2.6.10" },
    postflightVersion: { firmware: "2.2.6.11" },
    dataPacingPolicy: {
      startLevel: 2,
      finalLevel: 3,
      escalations: 1,
      ackMeanMs: 242,
      settleTotalMs: 384000,
    },
    deferredActivation: {
      attempts: [{ attempt: 1 }, { attempt: 2 }],
      resolvedOnAttempt: 2,
    },
    retainedResult: { otaState: 127 },
  });
  assert.equal(summary.activationResets, 2);
  assert.equal(summary.activationResolvedOnAttempt, 2);
  assert.equal(summary.templeOtaState, 127);
  assert.equal(summary.pacing.finalLevel, 3);
  assert.equal(summary.postflightFirmware, "2.2.6.11");
});

test("history summary exposes per-route asymmetry across operations", () => {
  const entry = (routes) =>
    buildDeviceHistoryEntry({
      operation: "automatic-apply",
      recordedAt: "2026-07-28T00:00:00.000Z",
      audit: { routeResults: routes },
      fingerprint: { transport: { kind: "WebUSB" } },
    });
  const clean = {
    route: "right",
    outcome: "success",
    dataPacingPolicy: { finalLevel: 2, ackMeanMs: 240 },
  };
  const rejected = {
    route: "left",
    outcome: "failed_or_uncertain",
    dataRejection: { status: 1, record: 866 },
    dataPacingPolicy: { finalLevel: 4, ackMeanMs: 243 },
  };
  const summary = summarizeDeviceHistory([
    entry([clean, rejected]),
    entry([clean, rejected]),
  ]);
  assert.equal(summary.operations, 2);
  assert.deepEqual(summary.transports, ["WebUSB"]);
  // The asymmetry measured on hardware: one route clean, the other rejecting.
  assert.equal(summary.routes.right.successes, 2);
  assert.equal(summary.routes.right.dataRejections, 0);
  assert.equal(summary.routes.left.successes, 0);
  assert.equal(summary.routes.left.dataRejections, 2);
  assert.equal(summary.routes.left.typicalPacingLevel, 4);
  assert.equal(summary.routes.right.typicalPacingLevel, 2);
});

test("history summary tolerates empty and malformed input", () => {
  assert.equal(summarizeDeviceHistory(null).operations, 0);
  assert.deepEqual(summarizeDeviceHistory([]).routes, {});
});

// Remote-support session SBTF-JCML, 2026-07-28. The right temple was verified
// running 2.2.6.10 after an activation reset at 11:40, and reported 2.0.7.16 on
// a read-only probe 73 minutes later with nothing written in between. Nothing
// in a single session shows that; reconstructing it took a 1,225-line
// transcript. History now carries the versions so the next operator sees it.
const HISTORY = [
  {
    recordedAt: "2026-07-27T23:38:00.000Z",
    templeFirmware: { left: "2.1.1.12", right: "2.1.1.12" },
    routes: [
      { route: "right", outcome: "success", postflightFirmware: "2.2.6.10" },
      { route: "left", outcome: "success", postflightFirmware: "2.2.6.10" },
    ],
  },
];

test("history keeps the firmware each temple was last seen running", () => {
  const entry = buildDeviceHistoryEntry({
    operation: "glasses-flash",
    recordedAt: "2026-07-28T18:40:00.000Z",
    fingerprint: {
      temples: {
        left: { firmware: "2.1.1.12", hardware: 5 },
        right: { firmware: "2.2.6.10", hardware: 5 },
      },
    },
  });
  assert.deepEqual(entry.templeFirmware, {
    left: "2.1.1.12",
    right: "2.2.6.10",
  });
  // A proven postflight version outranks what was observed on arrival.
  assert.deepEqual(lastRecordedTempleFirmware(HISTORY), {
    left: { firmware: "2.2.6.10", recordedAt: "2026-07-27T23:38:00.000Z" },
    right: { firmware: "2.2.6.10", recordedAt: "2026-07-27T23:38:00.000Z" },
  });
});

test("a temple running an older image than last recorded is reported", () => {
  const findings = detectTempleFirmwareRegression(HISTORY, {
    left: "2.0.7.16",
    right: "2.0.7.16",
  });
  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0], {
    route: "left",
    previousFirmware: "2.2.6.10",
    previousRecordedAt: "2026-07-27T23:38:00.000Z",
    observedFirmware: "2.0.7.16",
  });
});

test("an unchanged, newer, or unknown temple version is not a regression", () => {
  assert.deepEqual(
    detectTempleFirmwareRegression(HISTORY, {
      left: "2.2.6.10",
      right: "2.2.6.11",
    }),
    [],
  );
  // No prior record, no observation, and unparsable text all yield no finding
  // rather than a guess.
  assert.deepEqual(
    detectTempleFirmwareRegression([], { left: "2.0.7.16", right: null }),
    [],
  );
  assert.deepEqual(
    detectTempleFirmwareRegression(HISTORY, { left: null, right: "unknown" }),
    [],
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVICE_ANALYTICS_SCHEMA_VERSION,
  buildG2DeviceAnalytics,
} from "../src/lib/analytics.js";

function probe(side, operation, firmwareVersion = "2.2.6.10") {
  const version = operation === "version";
  return {
    operation,
    route: side,
    observedAt: "2026-07-25T00:00:00.000Z",
    decoded: version
      ? {
          kind: "version",
          firmwareVersion,
          hardwareRevision: 5,
        }
      : {
          kind: "status",
          batteryPercent: side === "left" ? 98 : 97,
          voltageMv: side === "left" ? 4490 : 4480,
        },
    captured: Uint8Array.from([0x5a, 0xa5, version ? 0x24 : 0x13]),
    transportProof: {
      baselineMask: 0x3ff,
      selectedMask: 0x3ff,
      restoredMask: 0x3ff,
      writeMask: 0x1ff,
      transmitted: version ? 5 : 7,
      stored: 3,
      errors: 0,
      baseline: Uint8Array.from([
        0x81, 0x10, 0x04, 0xa6, 0xa6, 3, 3, 0, 0x22, 0xff,
      ]),
    },
  };
}

function report(caseVersion = "1.2.57") {
  return {
    console: {
      text: "****** B200 1.2.57 ABCDEF0123456789 ******",
      caseVersion,
      serialNumber: "ABCDEF0123456789",
      identifier: "AA BB CC DD EE FF 00 11",
      telemetry: {
        leftPresent: true,
        rightPresent: true,
        percent: 50,
        voltage: 3900,
      },
      templeCharging: {
        left: {
          charging: true,
          done: false,
          voltageMv: 4490,
          batteryPercent: 98,
          currentRaw: -20,
          source: "charging-case console",
        },
        right: {
          charging: true,
          done: false,
          voltageMv: 4480,
          batteryPercent: 97,
          currentRaw: -18,
          source: "charging-case console",
        },
      },
    },
    usb: { vendorId: 0x1a86, productId: 0x7523 },
    rom: { protocolVersion: 0x31, productId: 0x0467, commands: [0x11, 0x31] },
    options: {
      rdp: 0xaa,
      dualBank: true,
      swapBank: false,
      activePhysicalBank: 2,
      inactivePhysicalBank: 1,
      userWord: 0x004000aa,
      complement: 0xffbfff55,
    },
    optionBytes: Uint8Array.from([0xaa, 0x00, 0x40, 0x00]),
    banks: {
      active: { physicalBank: 2, version: caseVersion, vectorValid: true },
      inactive: { physicalBank: 1, version: caseVersion, vectorValid: true },
    },
  };
}

test("separates case shell data from left/right glasses analytics", () => {
  const analytics = buildG2DeviceAnalytics({
    report: report(),
    pogoResults: {
      left: { version: probe("left", "version"), status: probe("left", "status") },
      right: { version: probe("right", "version"), status: probe("right", "status") },
    },
    generatedAt: "2026-07-25T00:00:00.000Z",
  });

  assert.equal(analytics.schemaVersion, DEVICE_ANALYTICS_SCHEMA_VERSION);
  assert.equal(typeof analytics.webFlasher.buildSha, "string");
  assert.equal(analytics.chargingCase.shell.allowlistedQueries.length, 4);
  assert.equal(
    analytics.chargingCase.variantAssessment
      .matchesReviewedElectronicProfile,
    true,
  );
  assert.equal(
    analytics.chargingCase.variantAssessment.frameFitVariant,
    null,
  );
  assert.match(
    analytics.chargingCase.variantAssessment.boundary,
    /do not identify.*Frame A\/Frame B/,
  );
  assert.match(analytics.chargingCase.shell.rawOutput, /B200/);
  assert.equal(
    analytics.chargingCase.shell.transport,
    "Unknown USB transport at 1,000,000 baud, 8N1",
  );
  assert.equal(analytics.chargingCase.options.rawHex, "AA 00 40 00");
  assert.equal(analytics.chargingCase.options.rawBase64, "qgBAAA==");
  assert.equal(
    analytics.smartGlasses.contactAssessment.state,
    "both-detected",
  );
  assert.equal(analytics.smartGlasses.left.batteryPercent, 98);
  assert.equal(analytics.smartGlasses.right.voltageMv, 4480);
  assert.equal(
    analytics.smartGlasses.left.version.transportProof.restoredMask,
    "0x000003FF",
  );
  assert.equal(
    analytics.validatedRecoveryEvidence.failureEvidence
      .persistentDataRejectionBoundary.recordDistance,
    35,
  );
  assert.deepEqual(
    analytics.validatedRecoveryEvidence.failureEvidence
      .cachedResponseHeaderTruncation.acceptedBytesByAttempt,
    [2_467_000, 1_350_000, 1_648_000],
  );
  assert.deepEqual(
    analytics.validatedRecoveryEvidence.failureEvidence
      .cachedResponsePayloadTruncation.attempts.map(
        (attempt) => attempt.acceptedBytes,
      ),
    [1_350_000, 1_511_000, 1_052_000],
  );
  assert.deepEqual(
    analytics.validatedRecoveryEvidence.failureEvidence
      .observed33YhmProfile.baselines,
    [
      "811004aeaf03812033ff",
      "810104afae03812033ff",
      "810004aeae03812033ff",
      "811104afaf03812033ff",
    ],
  );
  assert.equal(
    analytics.validatedRecoveryEvidence.allowlist
      .persistentDataRejectionWindowRecords,
    64,
  );
  assert.equal(
    analytics.validatedRecoveryEvidence.allowlist
      .maximumHostTimeoutWholeComponentRestarts,
    3,
  );
  assert.equal(
    analytics.sessionRecoveryAuditState,
    "not-captured-in-current-page-session",
  );
  assert.equal(
    analytics.sessionBluetoothRecoveryAuditState,
    "not-captured-in-current-page-session",
  );
  assert.equal(analytics.smartGlasses.recoveryAssessment.bothRoutesReady, true);
});

test("preserves the current Bluetooth recovery audit in exported evidence", () => {
  const bluetoothFlashAudit = {
    imageSha256: "a".repeat(64),
    version: "2.2.6.11",
    outcome: "success",
    routes: {
      left: { outcome: "success", blockAcks: 865 },
      right: { outcome: "success", skipped: true },
    },
  };
  const analytics = buildG2DeviceAnalytics({
    report: report(),
    bluetoothFlashAudit,
  });

  assert.equal(
    analytics.sessionBluetoothRecoveryAuditState,
    "captured-current-page-session",
  );
  assert.deepEqual(
    analytics.sessionBluetoothRecoveryAudit,
    bluetoothFlashAudit,
  );
});

test("fails the glasses recovery gate without the reviewed case version", () => {
  const analytics = buildG2DeviceAnalytics({
    report: report("1.2.56"),
    pogoResults: {
      left: { version: probe("left", "version") },
      right: { version: probe("right", "version") },
    },
  });
  assert.equal(analytics.smartGlasses.recoveryAssessment.caseCompatible, false);
  assert.equal(analytics.smartGlasses.recoveryAssessment.bothRoutesReady, false);
  assert.equal(
    analytics.smartGlasses.recoveryAssessment.applicationDeadRecoveryAvailable,
    false,
  );
});

test("treats older responsive hardware-5 temples as complete-main compatible", () => {
  const analytics = buildG2DeviceAnalytics({
    report: report(),
    pogoResults: {
      left: { version: probe("left", "version", "2.1.1.12") },
      right: { version: probe("right", "version", "2.1.1.12") },
    },
  });
  assert.equal(
    analytics.smartGlasses.left.completeMainWriterCompatible,
    true,
  );
  assert.equal(
    analytics.smartGlasses.left.reviewedWriterCompatible,
    false,
  );
  assert.equal(
    analytics.smartGlasses.left.differentialSourceCompatible,
    false,
  );
  assert.equal(
    analytics.smartGlasses.recoveryAssessment.bothRoutesReady,
    true,
  );
  assert.match(
    analytics.smartGlasses.recoveryAssessment.completeMainSourceRequirement,
    /Any checksum-valid running G2 application/,
  );
});

test("reports unqueried temples as unknown rather than unresponsive", () => {
  const analytics = buildG2DeviceAnalytics({
    report: report(),
    pogoResults: {},
  });

  assert.equal(analytics.smartGlasses.left.analysisState, "not-analyzed");
  assert.equal(analytics.smartGlasses.left.applicationResponsive, null);
  assert.equal(analytics.smartGlasses.right.applicationResponsive, null);
  assert.equal(analytics.smartGlasses.left.completeMainWriterCompatible, null);
  assert.equal(analytics.smartGlasses.left.reviewedWriterCompatible, null);
  assert.equal(
    analytics.smartGlasses.left.caseReportedCharging.batteryPercent,
    98,
  );
  assert.equal(
    analytics.smartGlasses.recoveryAssessment.bothTemplesAnalyzed,
    false,
  );
  assert.equal(
    analytics.smartGlasses.recoveryAssessment.bothTemplesResponsive,
    null,
  );
  assert.equal(
    analytics.smartGlasses.recoveryAssessment.bothRoutesReady,
    null,
  );
});

test("reports a failed seated probe as recovery-or-unresponsive and chooses reset first", () => {
  const analytics = buildG2DeviceAnalytics({
    report: report(),
    pogoResults: {
      left: {
        lastProbeFailure: {
          at: "now",
          message: "No checksum-valid application reply",
        },
      },
      right: { version: probe("right", "version", "2.2.8.4") },
    },
  });
  assert.equal(analytics.schemaVersion, 5);
  assert.equal(analytics.smartGlasses.left.analysisState, "failed");
  assert.equal(analytics.smartGlasses.left.applicationResponsive, false);
  assert.equal(
    analytics.smartGlasses.left.bootState,
    "recovery-or-unresponsive",
  );
  assert.equal(
    analytics.smartGlasses.recoveryAssessment.minimumPlan.action,
    "reset-and-verify",
  );
  assert.equal(
    analytics.smartGlasses.recoveryAssessment.minimumPlan.firmwareWriteRequired,
    false,
  );
});

test("reports an empty Case as no contacts, not dead Smart Glasses", () => {
  const emptyReport = report();
  emptyReport.console.telemetry.leftPresent = false;
  emptyReport.console.telemetry.rightPresent = false;
  emptyReport.console.templeCharging = null;
  const analytics = buildG2DeviceAnalytics({
    report: emptyReport,
    pogoResults: {},
  });

  assert.equal(
    analytics.smartGlasses.contactAssessment.state,
    "neither-detected",
  );
  assert.equal(
    analytics.smartGlasses.contactAssessment.automaticApplyAllowed,
    false,
  );
  assert.equal(analytics.smartGlasses.left.present, false);
  assert.equal(analytics.smartGlasses.left.applicationResponsive, null);
  assert.equal(analytics.smartGlasses.right.present, false);
  assert.equal(analytics.smartGlasses.right.applicationResponsive, null);
});

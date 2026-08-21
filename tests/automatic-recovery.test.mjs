import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AUTOMATIC_CASE_UPDATE,
  DEFAULT_AUTOMATIC_INSTALL_MODE,
  DEFAULT_INTERFACE_MODE,
  assessAutomaticTempleContacts,
  classifyAutomaticTempleBootState,
  describeAutomaticApplyFailure,
  diagnoseAndRecoverAutomaticUsb,
  executeAutomaticCaseUpdate,
  executeAutomaticApply,
  installedProvenanceStorageKey,
  mergeInstalledProvenance,
  minimumAutomaticRecoveryPlan,
  prepareAutomaticTempleUpdate,
  provenanceFromSuccessfulAudit,
  resolveAutomaticCaseUpdatePlan,
  resolveAutomaticApplyPlan,
  summarizeAutomaticApplyTransfer,
  templeVersionObservationsFromFlashAudit,
  verifyAutomaticCaseReadiness,
} from "../src/lib/automaticRecovery.js";

const STOCK_SHA = "a".repeat(64);
const TARGET_SHA = "b".repeat(64);
const firmware = (sha) => ({
  fileSha256: sha,
  templeFlashEligible: true,
});

test("Automatic Apply rejects a revoked firmware before planning a write", () => {
  const plan = resolveAutomaticApplyPlan({
    installMode: "restore",
    targetFirmware: {
      ...firmware(TARGET_SHA),
      firmwareRevocation: {
        version: "2.2.8.10",
        reason: "BLE advertised-name hook caused loss of Bluetooth discovery",
      },
    },
  });
  assert.equal(plan.executable, false);
  assert.match(plan.reason, /2\.2\.8\.10 is revoked.*Bluetooth discovery/i);
});
const both = (sha) => ({
  right: { imageSha256: sha },
  left: { imageSha256: sha },
});
const observedBoth = (version, hardwareRevision = 5) => ({
  right: { firmwareVersion: version, hardwareRevision },
  left: { firmwareVersion: version, hardwareRevision },
});
const versionProbe = (version, hardwareRevision = 5) => ({
  decoded: {
    kind: "version",
    firmwareVersion: version,
    hardwareRevision,
  },
});
const verifiedReadiness = (version = "2.2.6.10") => ({
  applicationLivenessVerified: true,
  firmwareBytesTransmitted: 0,
  caseVersion: "1.2.57",
  telemetry: { leftPresent: true, rightPresent: true },
  resetAttempts: [{ attempt: 1, outcome: "success" }],
  versions: {
    right: {
      firmware: version,
      hardware: 5,
      yhmRestoreVerified: true,
    },
    left: {
      firmware: version,
      hardware: 5,
      yhmRestoreVerified: true,
    },
  },
});

test("classifies Application mode only from a checksum-valid version reply", () => {
  assert.deepEqual(
    classifyAutomaticTempleBootState({
      present: true,
      probe: versionProbe("2.2.8.4"),
    }),
    {
      state: "application",
      applicationResponsive: true,
      firmwareVersion: "2.2.8.4",
      hardwareRevision: 5,
      detail:
        "Checksum-valid Application-mode version reply 2.2.8.4/hardware 5.",
    },
  );
  assert.equal(
    classifyAutomaticTempleBootState({
      present: true,
      error: new Error("no pogo response"),
    }).state,
    "recovery-or-unresponsive",
  );
  assert.equal(
    classifyAutomaticTempleBootState({ present: false }).state,
    "not-seated",
  );
});

test("the minimum recovery plan stops healthy temples without firmware", () => {
  const healthy = classifyAutomaticTempleBootState({
    present: true,
    probe: versionProbe("2.2.8.4"),
  });
  assert.deepEqual(minimumAutomaticRecoveryPlan({ left: healthy, right: healthy }), {
    action: "none",
    executable: true,
    firmwareWriteRequired: false,
    reason:
      "Both temples already returned checksum-valid Application-mode version replies; no recovery mutation is needed.",
  });
});

test("automatic USB diagnosis reboots a silent temple before considering firmware", async () => {
  const steps = [];
  let resetCalls = 0;
  const session = {
    async readTempleFlashPreflight() {
      return {
        caseVersion: "1.2.57",
        telemetry: { leftPresent: true, rightPresent: true },
      };
    },
    async probeRunningTemple(_operation, route) {
      if (route === "left") throw new Error("no application reply");
      return versionProbe("2.2.8.4");
    },
    async restartAndVerifyBothTemples(options) {
      resetCalls += 1;
      assert.equal(options.purpose, "Automatic no-flash recovery");
      return verifiedReadiness("2.2.8.4");
    },
  };
  const result = await diagnoseAndRecoverAutomaticUsb({
    session,
    onStep(step) {
      steps.push(step);
    },
  });
  assert.equal(resetCalls, 1);
  assert.equal(result.outcome, "recovered");
  assert.equal(result.firmwareBytesTransmitted, 0);
  assert.equal(result.temples.left.state, "recovery-or-unresponsive");
  assert.equal(result.recoveredTemples.left.state, "application");
  assert.deepEqual(
    steps.map(({ step }) => step),
    ["telemetry", "probe", "probe", "reset"],
  );
});

test("automatic USB diagnosis does not reboot two healthy applications", async () => {
  let resetCalls = 0;
  const session = {
    async readTempleFlashPreflight() {
      return {
        telemetry: { leftPresent: true, rightPresent: true },
      };
    },
    async probeRunningTemple() {
      return versionProbe("2.2.8.4");
    },
    async restartAndVerifyBothTemples() {
      resetCalls += 1;
    },
  };
  const result = await diagnoseAndRecoverAutomaticUsb({ session });
  assert.equal(result.action, "none");
  assert.equal(resetCalls, 0);
  assert.equal(result.firmwareBytesTransmitted, 0);
});

test("chooser-proven Bluetooth loss resets healthy applications without flashing", async () => {
  const steps = [];
  let resetCalls = 0;
  const session = {
    async readTempleFlashPreflight() {
      return {
        telemetry: { leftPresent: true, rightPresent: true },
      };
    },
    async probeRunningTemple() {
      return versionProbe("2.2.8.11");
    },
    async restartAndVerifyBothTemples(options) {
      resetCalls += 1;
      assert.equal(
        options.purpose,
        "Automatic Bluetooth-advertising recovery",
      );
      return verifiedReadiness("2.2.8.11");
    },
  };
  const result = await diagnoseAndRecoverAutomaticUsb({
    session,
    forceResetReason:
      "left Bluetooth selection failed because no matching advertisement was selectable",
    onStep(step) {
      steps.push(step);
    },
  });
  assert.equal(resetCalls, 1);
  assert.equal(result.outcome, "recovered");
  assert.equal(result.action, "reset-for-bluetooth-and-verify");
  assert.equal(result.firmwareBytesTransmitted, 0);
  assert.match(result.resetReason, /left Bluetooth selection failed/);
  assert.deepEqual(
    steps.map(({ step }) => step),
    ["telemetry", "probe", "probe", "reset"],
  );
});
const caseOptionBytes = (swapBank = false) => {
  const bytes = new Uint8Array(128);
  const userWord =
    (0xaa | (1 << 22) | (swapBank ? 1 << 20 : 0)) >>> 0;
  const view = new DataView(bytes.buffer);
  view.setUint32(0, userWord, true);
  view.setUint32(4, (~userWord) >>> 0, true);
  return bytes;
};
const differencePlan = {
  executable: true,
  changedMainOnly: true,
  source: {
    imageSha256: STOCK_SHA,
    mainSha256: "c".repeat(64),
    version: "2.2.6.10",
  },
  target: {
    imageSha256: TARGET_SHA,
    mainSha256: "d".repeat(64),
    version: "2.2.6.11",
  },
  wireTransfer: {
    component: "ota/s200_firmware_ota.bin",
    bytes: 1234,
    sparseByteRangesSupported: false,
  },
  verification: {
    targetBundleSha256: TARGET_SHA,
    targetMainSha256: "d".repeat(64),
    targetMainBytes: 1234,
    finishAcknowledgementRequired: true,
    postResetLivenessRequired: true,
    finalDualTempleResetRequired: true,
  },
};
const reverseDifferencePlan = {
  ...differencePlan,
  source: differencePlan.target,
  target: differencePlan.source,
  verification: {
    ...differencePlan.verification,
    targetBundleSha256: STOCK_SHA,
    targetMainSha256: differencePlan.source.mainSha256,
  },
};
const safePreflightFailureAudit = () => ({
  outcome: "failed_or_uncertain",
  flashMode: "differences",
  routes: ["right", "left"],
  routeOrderSetupStops: [],
  supersededSuccessfulRouteResults: [],
  routeComponentRestartAttempts: [],
  routeComponentRestartResets: [],
  persistentDataRejectionStops: [],
  routeSetupResetStops: [],
  routeSetupResetResults: [],
  sourceValidation: {
    requiredLiveFirmware: "2.2.6.10",
  },
  routeResults: [
    {
      route: "right",
      outcome: "failed_or_uncertain",
      failureStage: "PREFLIGHT",
      otaMutationAttempted: false,
      acceptedFirmwareBytes: 0,
      preflightVersion: {
        firmware: "2.1.1.12",
        hardware: 5,
      },
      caseRestoreVerified: true,
      caseApplicationVersion: "1.2.57",
      retainedResult: {
        acceptedSize: 0,
        baselineMask: 0x3ff,
        selectedMask: 0x3ff,
        restoredMask: 0x3ff,
        templeUartErrors: 0,
      },
    },
  ],
  finalResetAndLiveness: {
    resetConfirmed: true,
    caseFirmware: "1.2.57",
    versions: {
      right: {
        firmware: "2.1.1.12",
        hardware: 5,
        yhmRestoreVerified: true,
      },
      left: {
        firmware: "2.1.1.12",
        hardware: 5,
        yhmRestoreVerified: true,
      },
    },
  },
});
const safePostflightFailureAudit = () => ({
  outcome: "failed_or_uncertain",
  flashMode: "differences",
  differencePlan,
  routes: ["right", "left"],
  sourceValidation: {
    requiredLiveFirmware: "2.2.6.10",
  },
  routeResults: [
    {
      route: "right",
      outcome: "failed_or_uncertain",
      failureStage: "POSTFLIGHT",
      otaMutationAttempted: true,
      acceptedFirmwareBytes: 1234,
      transfer: {
        finishAckReceived: true,
        payloadBytesSent: 1234,
      },
      caseRestoreVerified: true,
      caseApplicationVersion: "1.2.57",
      retainedResult: {
        acceptedSize: 1234,
        baselineMask: 0x3ff,
        selectedMask: 0x3ff,
        restoredMask: 0x3ff,
        templeUartErrors: 0,
      },
    },
  ],
  finalResetAndLiveness: {
    resetConfirmed: true,
    caseFirmware: "1.2.57",
    versions: {
      right: {
        firmware: "2.2.6.10",
        hardware: 5,
        yhmRestoreVerified: true,
      },
      left: {
        firmware: "2.2.6.10",
        hardware: 5,
        yhmRestoreVerified: true,
      },
    },
  },
});

test("defaults to Easy Mode, adaptive Update, and automatic Case repair", () => {
  assert.equal(DEFAULT_INTERFACE_MODE, "easy");
  assert.equal(DEFAULT_AUTOMATIC_INSTALL_MODE, "update");
  assert.equal(DEFAULT_AUTOMATIC_CASE_UPDATE, true);
});

test("retains the completed route and recommends Bluetooth after YHM setup exhaustion", () => {
  const observedAt = "2026-07-31T12:00:00.000Z";
  const audit = {
    outcome: "failed_or_uncertain",
    routeResults: [
      {
        route: "right",
        outcome: "success",
        caseRestoreVerified: true,
        postflightVersion: {
          firmware: "2.2.6.10",
          hardware: 5,
        },
        retainedResult: {
          baselineMask: 0x3ff,
          selectedMask: 0x3ff,
          restoredMask: 0x3ff,
        },
      },
      {
        route: "left",
        outcome: "failed_or_uncertain",
        otaMutationAttempted: false,
        acceptedFirmwareBytes: 0,
        caseRestoreVerified: true,
        preflightVersion: {
          firmware: "2.2.5.10",
          hardware: 5,
        },
        retainedResult: {
          baselineMask: 0x3ff,
          selectedMask: 0,
          restoredMask: 0,
        },
        recoveryBoundary: {
          classification: "yhm_setup_exhausted_zero_byte_boundary",
        },
      },
    ],
  };
  const error = new Error("low-level YHM setup stop");
  error.audit = audit;

  assert.deepEqual(
    describeAutomaticApplyFailure(error),
    {
      message:
        "Stopped safely on the left Case route before any left-side firmware was sent. The right target install remains verified and can be retained without rewriting it. Use Direct recovery fallback below to finish the complete pinned package over Bluetooth.",
      directBluetoothRecommended: true,
      failedRoute: "left",
      preservedRoutes: ["right"],
      classification: "yhm_setup_exhausted_zero_byte_boundary",
    },
  );
  assert.deepEqual(
    templeVersionObservationsFromFlashAudit(audit, { observedAt }),
    {
      right: {
        version: {
          operation: "version",
          route: "right",
          decoded: {
            kind: "version",
            firmwareVersion: "2.2.6.10",
            hardwareRevision: 5,
          },
          transportProof: {
            restoredMask: 0x3ff,
          },
          observedAt,
        },
      },
      left: {
        version: {
          operation: "version",
          route: "left",
          decoded: {
            kind: "version",
            firmwareVersion: "2.2.5.10",
            hardwareRevision: 5,
          },
          transportProof: {
            restoredMask: null,
          },
          observedAt,
        },
      },
    },
  );
});

test("keeps the ordinary automatic failure message without a recovery boundary", () => {
  assert.deepEqual(
    describeAutomaticApplyFailure(new Error("Case preflight failed")),
    {
      message: "Stopped safely · Case preflight failed",
      directBluetoothRecommended: false,
      failedRoute: null,
      preservedRoutes: [],
      classification: null,
    },
  );
});

test("Automatic Update checks both versions before issuing the clean-start reset", async () => {
  const calls = [];
  const preparation = await prepareAutomaticTempleUpdate({
    session: {
      probeRunningTemple: async (operation, route) => {
        calls.push(`${operation}:${route}`);
        return versionProbe("2.2.6.10");
      },
      restartAndVerifyBothTemples: async (options) => {
        calls.push("reset");
        assert.equal(options.purpose, "Automatic clean-start reset");
        return verifiedReadiness("2.2.6.10");
      },
    },
  });

  assert.deepEqual(calls, ["version:right", "version:left", "reset"]);
  assert.deepEqual(preparation.initialVersions, observedBoth("2.2.6.10"));
  assert.deepEqual(
    preparation.observedTempleVersions,
    observedBoth("2.2.6.10"),
  );
  assert.deepEqual(preparation.changedAcrossReset, []);
});

test("Automatic Update plans from fresh post-reset identity when reset changes it", async () => {
  const preparation = await prepareAutomaticTempleUpdate({
    session: {
      probeRunningTemple: async () => versionProbe("2.2.6.10"),
      restartAndVerifyBothTemples: async () =>
        verifiedReadiness("2.2.6.11"),
    },
  });

  assert.deepEqual(preparation.changedAcrossReset, ["right", "left"]);
  assert.deepEqual(
    preparation.observedTempleVersions,
    observedBoth("2.2.6.11"),
  );
});

test("blocks Automatic Apply before mutation when an analyzed Case is empty", () => {
  const empty = assessAutomaticTempleContacts({
    leftPresent: false,
    rightPresent: false,
  });
  assert.equal(empty.state, "neither-detected");
  assert.equal(empty.automaticApplyAllowed, false);
  assert.equal(empty.resetRecoveryEligible, false);
  assert.match(empty.reason, /No Case update or Smart Glasses transfer/);

  const partial = assessAutomaticTempleContacts({
    leftPresent: false,
    rightPresent: true,
  });
  assert.equal(partial.state, "partial-contact");
  assert.equal(partial.automaticApplyAllowed, true);
  assert.equal(partial.resetRecoveryEligible, true);

  const complete = assessAutomaticTempleContacts({
    leftPresent: true,
    rightPresent: true,
  });
  assert.equal(complete.state, "both-detected");
  assert.equal(complete.automaticApplyAllowed, true);
  assert.equal(complete.resetRecoveryEligible, false);

  assert.equal(
    assessAutomaticTempleContacts(null).automaticApplyAllowed,
    false,
  );
});

test("uses the factory identifier when a boot serial was not captured", () => {
  assert.equal(
    installedProvenanceStorageKey(null, "a5 26 03 26 00 00 07 80"),
    "evenrealities-webflasher:g2-installed-provenance:factory-A526032600000780",
  );
  assert.equal(
    installedProvenanceStorageKey(
      "00500041514250052037384b",
      "a5 26 03 26 00 00 07 80",
    ),
    "evenrealities-webflasher:g2-installed-provenance:00500041514250052037384b",
  );
  assert.equal(installedProvenanceStorageKey(null, null), null);
  assert.equal(
    installedProvenanceStorageKey(null, "FF FF FF FF FF FF FF FF"),
    null,
  );
});

const latestCaseRelease = {
  channel: "official",
  caseRecoveryEligible: true,
  caseVersion: "1.2.57",
};

test("Case update is a no-op when the latest version is already installed", () => {
  assert.equal(
    resolveAutomaticCaseUpdatePlan({
      enabled: false,
      currentVersion: "1.2.57",
      targetRelease: latestCaseRelease,
    }).action,
    "none",
  );
});

test("older Case firmware requires the explicit automatic-update option", () => {
  const blocked = resolveAutomaticCaseUpdatePlan({
    enabled: false,
    currentVersion: "1.2.56",
    targetRelease: latestCaseRelease,
  });
  assert.equal(blocked.executable, false);
  assert.match(blocked.reason, /Enable “Update Charging Case first”/);

  const update = resolveAutomaticCaseUpdatePlan({
    enabled: true,
    currentVersion: "1.2.56",
    targetRelease: latestCaseRelease,
  });
  assert.equal(update.executable, true);
  assert.equal(update.action, "update");
  assert.equal(update.targetVersion, "1.2.57");
});

test("automatic Case update refuses a downgrade", () => {
  const result = resolveAutomaticCaseUpdatePlan({
    enabled: true,
    currentVersion: "1.2.58",
    targetRelease: latestCaseRelease,
  });
  assert.equal(result.executable, false);
  assert.match(result.reason, /will not downgrade/);
});

test("automatic Case update requires a fresh physical-bank map before writing", async () => {
  let stageCalled = false;
  await assert.rejects(
    () =>
      executeAutomaticCaseUpdate({
        session: {
          stageCaseImage: async () => {
            stageCalled = true;
          },
        },
        currentReport: { optionBytes: new Uint8Array(128) },
        targetFirmware: {
          caseRecoveryEligible: true,
          caseVersion: "1.2.57",
          caseImage: new Uint8Array([1]),
        },
      }),
    /pre-update active physical bank/,
  );
  assert.equal(stageCalled, false);
});

test("automatic Case update refuses to erase when the preserved active vector is invalid", async () => {
  let stageCalled = false;
  await assert.rejects(
    () =>
      executeAutomaticCaseUpdate({
        session: {
          stageCaseImage: async () => {
            stageCalled = true;
          },
        },
        currentReport: {
          optionBytes: caseOptionBytes(false),
          options: {
            rdp: 0xaa,
            dualBank: true,
            swapBank: false,
            activePhysicalBank: 2,
            inactivePhysicalBank: 1,
          },
          banks: {
            active: {
              physicalBank: 2,
              version: "1.2.56",
              vectorValid: false,
            },
            inactive: {
              physicalBank: 1,
              version: "1.2.54",
              vectorValid: true,
            },
          },
        },
        targetFirmware: {
          caseRecoveryEligible: true,
          caseVersion: "1.2.57",
          caseImage: new Uint8Array([1]),
        },
      }),
    /active vector/,
  );
  assert.equal(stageCalled, false);
});

test("automatic Case update stages, activates, and re-analyzes before returning", async () => {
  const events = [];
  const optionBytes = caseOptionBytes(false);
  const caseImage = new Uint8Array([1, 2, 3, 4]);
  const targetFirmware = {
    caseRecoveryEligible: true,
    caseVersion: "1.2.57",
    caseImage,
  };
  const report = {
    optionBytes,
    console: { caseVersion: "1.2.56" },
    options: {
      rdp: 0xaa,
      dualBank: true,
      swapBank: false,
      activePhysicalBank: 2,
      inactivePhysicalBank: 1,
    },
    banks: {
      active: {
        physicalBank: 2,
        version: "1.2.56",
        vectorValid: true,
      },
      inactive: {
        physicalBank: 1,
        version: "1.2.54",
        vectorValid: true,
      },
    },
  };
  const updatedReport = {
    optionBytes: caseOptionBytes(true),
    console: { caseVersion: "1.2.57" },
    options: {
      rdp: 0xaa,
      dualBank: true,
      swapBank: true,
      activePhysicalBank: 1,
      inactivePhysicalBank: 2,
    },
    banks: {
      active: {
        physicalBank: 1,
        version: "1.2.57",
        vectorValid: true,
      },
      inactive: {
        physicalBank: 2,
        version: "1.2.56",
        vectorValid: true,
      },
    },
  };
  const result = await executeAutomaticCaseUpdate({
    session: {
      stageCaseImage: async (...args) => {
        events.push(["stage", ...args]);
        return { readbackSha256: "a".repeat(64) };
      },
      activateStagedBank: async (...args) => {
        events.push(["activate", ...args]);
        return { caseVersion: "1.2.57" };
      },
      analyze: async (...args) => {
        events.push(["analyze", ...args]);
        return updatedReport;
      },
      confirmCaseFirmwareVersion: async (...args) => {
        events.push(["confirm", ...args]);
        return {
          confirmedVersion: "1.2.57",
          confirmationCommand: "DEA0",
          confirmationAttempt: 1,
          confirmationAttempts: 3,
        };
      },
    },
    currentReport: report,
    targetFirmware,
    onStep: (step) => events.push(["step", step]),
  });

  assert.equal(result.report, updatedReport);
  assert.deepEqual(
    events.map(([event, detail]) => [event, detail]),
    [
      ["step", "stage"],
      ["stage", caseImage],
      ["step", "activate"],
      ["activate", caseImage],
      ["step", "reanalyze"],
      ["analyze", { progressBase: 0.36, progressSpan: 0.12 }],
      ["step", "verify-bank-switch"],
      ["step", "confirm"],
      ["confirm", "1.2.57"],
    ],
  );
  assert.equal(events[1][2], optionBytes);
  assert.equal(events[3][2], optionBytes);
  assert.deepEqual(result.bankSwitch, {
    verified: true,
    targetVersion: "1.2.57",
    previousActiveVersion: "1.2.56",
    fallbackVersion: "1.2.56",
    previousActivePhysicalBank: 2,
    stagedPhysicalBank: 1,
    activePhysicalBank: 1,
    fallbackPhysicalBank: 2,
    previousSwapBank: false,
    activeSwapBank: true,
  });
  assert.equal(result.confirmation.confirmationCommand, "DEA0");
  assert.deepEqual(result.readiness, {
    verified: true,
    expectedVersion: "1.2.57",
    activePhysicalBank: 1,
    fallbackPhysicalBank: 2,
    activeVersion: "1.2.57",
    fallbackVersion: "1.2.56",
    swapBank: true,
  });
});

test("current Case readiness requires fresh options and valid active and fallback banks", () => {
  const report = {
    optionBytes: caseOptionBytes(true),
    console: { caseVersion: "1.2.57" },
    options: {
      rdp: 0xaa,
      dualBank: true,
      swapBank: true,
      activePhysicalBank: 1,
      inactivePhysicalBank: 2,
    },
    banks: {
      active: {
        physicalBank: 1,
        version: "1.2.57",
        vectorValid: true,
      },
      inactive: {
        physicalBank: 2,
        version: "1.2.56",
        vectorValid: true,
      },
    },
  };

  assert.equal(
    verifyAutomaticCaseReadiness(report, "1.2.57").verified,
    true,
  );
  assert.throws(
    () =>
      verifyAutomaticCaseReadiness(
        {
          ...report,
          banks: {
            ...report.banks,
            inactive: { ...report.banks.inactive, vectorValid: false },
          },
        },
        "1.2.57",
    ),
    /fallback physical bank 2 does not contain a valid vector table/,
  );
  assert.throws(
    () =>
      verifyAutomaticCaseReadiness(
        { ...report, optionBytes: caseOptionBytes(false) },
        "1.2.57",
      ),
    /decoded option snapshot and reported bank mode disagree/,
  );
});

test("automatic Case update rejects 1.2.57 when the staged bank was not activated", async () => {
  const optionBytes = caseOptionBytes(false);
  let confirmationCalled = false;
  await assert.rejects(
    () =>
      executeAutomaticCaseUpdate({
        session: {
          stageCaseImage: async () => ({}),
          activateStagedBank: async () => ({ caseVersion: "1.2.57" }),
          analyze: async () => ({
            console: { caseVersion: "1.2.57" },
            options: {
              swapBank: false,
              activePhysicalBank: 2,
              inactivePhysicalBank: 1,
            },
            banks: {
              active: { physicalBank: 2, version: "1.2.57" },
              inactive: { physicalBank: 1, version: "1.2.54" },
            },
          }),
          confirmCaseFirmwareVersion: async () => {
            confirmationCalled = true;
            return { confirmedVersion: "1.2.57" };
          },
        },
        currentReport: {
          optionBytes,
          options: {
            rdp: 0xaa,
            dualBank: true,
            swapBank: false,
            activePhysicalBank: 2,
            inactivePhysicalBank: 1,
          },
          banks: {
            active: {
              physicalBank: 2,
              version: "1.2.56",
              vectorValid: true,
            },
            inactive: { physicalBank: 1, version: "1.2.54" },
          },
        },
        targetFirmware: {
          caseRecoveryEligible: true,
          caseVersion: "1.2.57",
          caseImage: new Uint8Array([1]),
        },
      }),
    /bank switch was not confirmed.*nSWAP_BANK option did not toggle/i,
  );
  assert.equal(confirmationCalled, false);
});

test("automatic Case update stops before returning when fresh confirmation fails", async () => {
  const optionBytes = caseOptionBytes(false);
  await assert.rejects(
    () =>
      executeAutomaticCaseUpdate({
        session: {
          stageCaseImage: async () => ({}),
          activateStagedBank: async () => ({ caseVersion: "1.2.57" }),
          analyze: async () => ({
            console: { caseVersion: "1.2.57" },
            options: {
              swapBank: true,
              activePhysicalBank: 1,
              inactivePhysicalBank: 2,
            },
            banks: {
              active: { physicalBank: 1, version: "1.2.57" },
              inactive: { physicalBank: 2, version: "1.2.56" },
            },
          }),
          confirmCaseFirmwareVersion: async () => {
            throw new Error("fresh DEA0 still reports 1.2.56");
          },
        },
        currentReport: {
          optionBytes,
          options: {
            rdp: 0xaa,
            dualBank: true,
            swapBank: false,
            activePhysicalBank: 2,
            inactivePhysicalBank: 1,
          },
          banks: {
            active: {
              physicalBank: 2,
              version: "1.2.56",
              vectorValid: true,
            },
            inactive: { physicalBank: 1, version: "1.2.54" },
          },
        },
        targetFirmware: {
          caseRecoveryEligible: true,
          caseVersion: "1.2.57",
          caseImage: new Uint8Array([1]),
        },
      }),
    /fresh DEA0 still reports 1\.2\.56/,
  );
});

test("Restore always plans a complete bilateral rewrite", () => {
  assert.deepEqual(
    resolveAutomaticApplyPlan({
      installMode: "restore",
      targetFirmware: firmware(STOCK_SHA),
    }),
    {
      executable: true,
      action: "flash",
      route: "both",
      flashMode: "complete",
      targetSha256: STOCK_SHA,
      reason: "Rewrite the complete pinned Apollo main on both temples.",
    },
  );
});

test("Update ignores legacy comparison inputs and selects a complete official image", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: {},
    differenceSourceFirmware: firmware(STOCK_SHA),
    differencePlan,
    observedTempleVersions: observedBoth("2.2.6.10"),
  });
  assert.equal(result.executable, true);
  assert.equal(result.sourceProofMode, "complete-target-main");
  assert.equal(result.flashMode, "complete");
  assert.match(result.reason, /complete pinned official Apollo main/i);
});

test("Update keeps complete-image mode when source-audit proof is available", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: both(STOCK_SHA),
    differenceSourceFirmware: firmware(STOCK_SHA),
    differencePlan,
  });
  assert.equal(result.executable, true);
  assert.equal(result.flashMode, "complete");
  assert.equal(result.route, "both");
  assert.equal(result.sourceProofMode, "complete-target-main");
});

test("Update falls back to a complete main when the difference proof is unsafe", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: {},
    differenceSourceFirmware: firmware(STOCK_SHA),
    differencePlan: {
      ...differencePlan,
      wireTransfer: {
        ...differencePlan.wireTransfer,
        sparseByteRangesSupported: true,
      },
    },
  });
  assert.equal(result.executable, true);
  assert.equal(result.flashMode, "complete");
  assert.match(result.reason, /complete pinned official Apollo main/i);
});

test("Update falls back to a complete main when no differential pair exists", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: {},
    observedTempleVersions: observedBoth("2.1.1.12"),
  });
  assert.equal(result.executable, true);
  assert.equal(result.flashMode, "complete");
  assert.equal(result.sourceProofMode, "complete-target-main");
  assert.match(result.reason, /complete pinned official Apollo main/i);
});

test("Update falls back to a complete main for proof outside the reviewed pair", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: both("e".repeat(64)),
    differenceSourceFirmware: firmware(STOCK_SHA),
    differencePlan,
  });
  assert.equal(result.executable, true);
  assert.equal(result.flashMode, "complete");
  assert.match(result.reason, /complete pinned official Apollo main/i);
});

test("Update uses a complete main from 2.1.1.12 instead of the official-only differential", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: firmware(STOCK_SHA),
    installedProvenance: {},
    differenceSourceFirmware: firmware(TARGET_SHA),
    differencePlan: reverseDifferencePlan,
    observedTempleVersions: observedBoth("2.1.1.12"),
  });
  assert.equal(result.executable, true);
  assert.equal(result.flashMode, "complete");
  assert.equal(result.sourceProofMode, "complete-target-main");
  assert.match(result.reason, /complete pinned official Apollo main/i);
});

test("fresh 2.1.1.12 identity overrides stale saved Stock differential proof", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: both(STOCK_SHA),
    differenceSourceFirmware: firmware(STOCK_SHA),
    differencePlan,
    observedTempleVersions: observedBoth("2.1.1.12"),
  });
  assert.equal(result.flashMode, "complete");
  assert.equal(result.sourceProofMode, "complete-target-main");
  assert.match(result.reason, /complete pinned official Apollo main/i);
});

test("Update becomes reset-and-verify when both temples already prove target", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: both(TARGET_SHA),
  });
  assert.equal(result.executable, true);
  assert.equal(result.action, "verify-only");
});

test("Update sends no firmware when fresh bilateral versions already match the target", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: {
      ...firmware(TARGET_SHA),
      g2Version: "2.2.6.11",
    },
    installedProvenance: {},
    observedTempleVersions: observedBoth("2.2.6.11"),
  });
  assert.equal(result.action, "verify-only");
  assert.match(result.reason, /send no firmware bytes/i);
});

test("Update skips a live target-matching temple and completely updates only the source side", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: {
      ...firmware(TARGET_SHA),
      g2Version: "2.2.6.11",
    },
    installedProvenance: {},
    differenceSourceFirmware: firmware(STOCK_SHA),
    differencePlan,
    observedTempleVersions: {
      right: { firmwareVersion: "2.2.6.11", hardwareRevision: 5 },
      left: { firmwareVersion: "2.2.6.10", hardwareRevision: 5 },
    },
  });
  assert.equal(result.action, "flash");
  assert.equal(result.route, "left");
  assert.equal(result.flashMode, "complete");
  assert.equal(result.sourceProofMode, "complete-target-main");
});

test("Update skips a live target-matching temple and completely updates only an unrelated side", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: {
      ...firmware(TARGET_SHA),
      g2Version: "2.2.6.11",
    },
    installedProvenance: {},
    observedTempleVersions: {
      right: { firmwareVersion: "2.2.6.11", hardwareRevision: 5 },
      left: { firmwareVersion: "2.1.1.12", hardwareRevision: 5 },
    },
  });
  assert.equal(result.action, "flash");
  assert.equal(result.route, "left");
  assert.equal(result.flashMode, "complete");
  assert.match(result.reason, /left temple only/i);
});

test("USB transfer summary reports complete-image wire bytes", () => {
  const summary = summarizeAutomaticApplyTransfer({
    plan: {
      executable: true,
      action: "flash",
      route: "left",
      flashMode: "complete",
      reason: "test",
    },
    targetFirmware: {
      mainComponent: { payload: new Uint8Array(3_500_000) },
    },
  });
  assert.deepEqual(summary.routes, ["left"]);
  assert.deepEqual(summary.skippedRoutes, ["right"]);
  assert.equal(summary.semanticChangedBytes, null);
  assert.equal(summary.firmwareBytes, 3_500_000);
  assert.equal(summary.sparseByteRangesSupported, false);
  assert.match(summary.protocolBoundary, /no destination-offset field/i);
});

test("same-version USB transfer summary reports no firmware routes", () => {
  const summary = summarizeAutomaticApplyTransfer({
    plan: {
      executable: true,
      action: "verify-only",
      route: "both",
      flashMode: null,
      reason: "already current",
    },
    targetFirmware: {
      mainComponent: { payload: new Uint8Array(3_500_000) },
    },
  });
  assert.deepEqual(summary.routes, []);
  assert.deepEqual(summary.skippedRoutes, ["right", "left"]);
  assert.deepEqual(summary.verificationRoutes, ["right", "left"]);
  assert.equal(summary.firmwareBytes, 0);
});

test("fresh temple identity overrides stale saved target provenance", () => {
  const result = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: {
      ...firmware(TARGET_SHA),
      g2Version: "2.2.6.11",
    },
    installedProvenance: both(TARGET_SHA),
    observedTempleVersions: observedBoth("2.1.1.12"),
  });
  assert.equal(result.action, "flash");
  assert.equal(result.flashMode, "complete");
  assert.match(result.reason, /contradicts the saved target audit/);
});

test("only a fully verified successful audit records installed provenance", () => {
  const audit = {
    outcome: "success",
    imageSha256: TARGET_SHA,
    installedIdentity: {
      channel: "custom",
      reportedVersion: "2.2.6.11",
      displayVersion: "2.2.6.11 experimental",
    },
    routes: ["right", "left"],
    finishedAt: "2026-07-26T00:00:00.000Z",
    verification: {
      everyRouteAcceptedExactTargetBytes: true,
      everyRoutePostflightVersionValid: true,
      finalDualTempleResetVerified: true,
      postResetLivenessVerified: true,
    },
  };
  assert.deepEqual(Object.keys(provenanceFromSuccessfulAudit(audit)).sort(), [
    "left",
    "right",
  ]);
  assert.deepEqual(mergeInstalledProvenance({}, audit), {
    right: {
      imageSha256: TARGET_SHA,
      channel: "custom",
      reportedVersion: "2.2.6.11",
      displayVersion: "2.2.6.11 experimental",
      provenAt: "2026-07-26T00:00:00.000Z",
      proof: "verified-recovery-audit",
    },
    left: {
      imageSha256: TARGET_SHA,
      channel: "custom",
      reportedVersion: "2.2.6.11",
      displayVersion: "2.2.6.11 experimental",
      provenAt: "2026-07-26T00:00:00.000Z",
      proof: "verified-recovery-audit",
    },
  });
});

test("a failed or uncertain audit clears affected route provenance", () => {
  assert.deepEqual(
    mergeInstalledProvenance(both(STOCK_SHA), {
      outcome: "failed_or_uncertain",
      routes: ["right"],
    }),
    { left: { imageSha256: STOCK_SHA } },
  );
});

test("a failed audit retains a route whose own install fully verified", () => {
  const merged = mergeInstalledProvenance(both(STOCK_SHA), {
    outcome: "failed_or_uncertain",
    routes: ["right", "left"],
    imageSha256: TARGET_SHA,
    finishedAt: "2026-07-27T23:59:59.000Z",
    installedIdentity: {
      channel: "custom",
      reportedVersion: "2.2.6.10",
      displayVersion: "2.2.6.10 experimental",
    },
    routeResults: [
      {
        route: "right",
        outcome: "success",
        caseRestoreVerified: true,
        postflightVersion: { firmware: "2.2.6.10", hardware: 5 },
      },
      { route: "left", outcome: "failed_or_uncertain" },
    ],
  });
  assert.deepEqual(merged, {
    right: {
      imageSha256: TARGET_SHA,
      channel: "custom",
      reportedVersion: "2.2.6.10",
      displayVersion: "2.2.6.10 experimental",
      provenAt: "2026-07-27T23:59:59.000Z",
      proof: "route-verified-interrupted-audit",
    },
  });
});

test("a failed audit does not retain a route with an unverified Case restore", () => {
  const merged = mergeInstalledProvenance(both(STOCK_SHA), {
    outcome: "failed_or_uncertain",
    routes: ["right", "left"],
    imageSha256: TARGET_SHA,
    installedIdentity: { channel: "custom", reportedVersion: "2.2.6.10" },
    routeResults: [
      {
        route: "right",
        outcome: "success",
        caseRestoreVerified: false,
        postflightVersion: { firmware: "2.2.6.10", hardware: 5 },
      },
      { route: "left", outcome: "failed_or_uncertain" },
    ],
  });
  assert.deepEqual(merged, {});
});

test("update flashes only the unproven route when the other is target-proven", () => {
  const plan = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: {
      right: {
        imageSha256: TARGET_SHA,
        proof: "route-verified-interrupted-audit",
      },
    },
    differenceSourceFirmware: null,
    differencePlan: null,
    observedTempleVersions: null,
  });
  assert.equal(plan.executable, true);
  assert.equal(plan.action, "flash");
  assert.equal(plan.route, "left");
  assert.equal(plan.flashMode, "complete");
  assert.match(plan.reason, /right temple already holds a verified install/);
});

test("update rewrites both routes when the proven route contradicts observation", () => {
  const plan = resolveAutomaticApplyPlan({
    installMode: "update",
    targetFirmware: { ...firmware(TARGET_SHA), g2Version: "2.2.6.11" },
    installedProvenance: {
      right: { imageSha256: TARGET_SHA },
    },
    differenceSourceFirmware: null,
    differencePlan: null,
    observedTempleVersions: observedBoth("2.2.6.10"),
  });
  assert.equal(plan.executable, true);
  assert.equal(plan.route, "both");
  assert.equal(plan.flashMode, "complete");
});

test("automatic Restore invokes one complete bilateral session", async () => {
  const calls = [];
  const expectedAudit = { outcome: "success" };
  const result = await executeAutomaticApply({
    session: {
      flashPinnedTempleMain: async (...args) => {
        calls.push(args);
        return expectedAudit;
      },
    },
    installMode: "restore",
    targetFirmware: firmware(STOCK_SHA),
  });
  assert.equal(result.audit, expectedAudit);
  assert.deepEqual(calls, [
    [
      firmware(STOCK_SHA),
      "both",
      { mode: "complete" },
    ],
  ]);
});

test("automatic Update invokes the complete bilateral official session", async () => {
  const calls = [];
  const source = firmware(STOCK_SHA);
  await executeAutomaticApply({
    session: {
      flashPinnedTempleMain: async (...args) => {
        calls.push(args);
        return { outcome: "success" };
      },
    },
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: both(STOCK_SHA),
    differenceSourceFirmware: source,
    differencePlan,
  });
  assert.deepEqual(calls, [
    [
      firmware(TARGET_SHA),
      "both",
      {
        mode: "complete",
      },
    ],
  ]);
});

test("automatic Update never starts a legacy differential plan", async () => {
  const calls = [];
  const recoveries = [];
  let resetCalls = 0;
  const successfulAudit = { outcome: "success" };
  const source = firmware(STOCK_SHA);
  const result = await executeAutomaticApply({
    session: {
      flashPinnedTempleMain: async (...args) => {
        calls.push(args);
        if (args[2].mode === "differences") {
          throw Object.assign(new Error("live source mismatch"), {
            audit: safePreflightFailureAudit(),
          });
        }
        return successfulAudit;
      },
      restartAndVerifyBothTemples: async (options) => {
        resetCalls += 1;
        assert.equal(
          options.purpose,
          "Differential-to-complete recovery reset",
        );
        return verifiedReadiness("2.1.1.12");
      },
    },
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: both(STOCK_SHA),
    differenceSourceFirmware: source,
    differencePlan,
    onRecovery: (recovery) => recoveries.push(recovery),
  });

  assert.equal(calls.length, 1);
  assert.equal(resetCalls, 0);
  assert.deepEqual(calls[0], [
    firmware(TARGET_SHA),
    "both",
    { mode: "complete" },
  ]);
  assert.equal(result.plan.flashMode, "complete");
  assert.equal(result.initialPlan, undefined);
  assert.deepEqual(recoveries, []);
});

test("automatic Update goes directly to the complete main", async () => {
  const steps = [];
  const recoveries = [];
  const successfulAudit = { outcome: "success" };
  const source = firmware(STOCK_SHA);
  const result = await executeAutomaticApply({
    session: {
      flashPinnedTempleMain: async (...args) => {
        steps.push(`flash:${args[2].mode}`);
        if (args[2].mode === "differences") {
          throw Object.assign(new Error("postflight liveness failed"), {
            audit: safePostflightFailureAudit(),
          });
        }
        return successfulAudit;
      },
      restartAndVerifyBothTemples: async (options) => {
        steps.push("reset");
        assert.equal(
          options.purpose,
          "Differential-to-complete recovery reset",
        );
        return verifiedReadiness("2.2.6.10");
      },
    },
    installMode: "update",
    targetFirmware: firmware(TARGET_SHA),
    installedProvenance: both(STOCK_SHA),
    differenceSourceFirmware: source,
    differencePlan,
    onRecovery: (recovery) => recoveries.push(recovery),
  });

  assert.deepEqual(steps, ["flash:complete"]);
  assert.deepEqual(recoveries, []);
  assert.equal(result.initialPlan, undefined);
  assert.equal(result.plan.flashMode, "complete");
  assert.equal(result.audit, successfulAudit);
});

test("automatic Update surfaces a complete-image failure without a legacy fallback", async () => {
  const modes = [];
  const source = firmware(STOCK_SHA);
  await assert.rejects(
    executeAutomaticApply({
      session: {
        flashPinnedTempleMain: async (...args) => {
          modes.push(args[2].mode);
          throw Object.assign(new Error("postflight liveness failed"), {
            audit: safePostflightFailureAudit(),
          });
        },
        restartAndVerifyBothTemples: async () => {
          throw new Error("left temple did not answer");
        },
      },
      installMode: "update",
      targetFirmware: firmware(TARGET_SHA),
      installedProvenance: both(STOCK_SHA),
      differenceSourceFirmware: source,
      differencePlan,
    }),
    /postflight liveness failed/i,
  );
  assert.deepEqual(modes, ["complete"]);
});

test("automatic Update invokes a complete bilateral session for 2.1.1.12", async () => {
  const calls = [];
  await executeAutomaticApply({
    session: {
      flashPinnedTempleMain: async (...args) => {
        calls.push(args);
        return { outcome: "success" };
      },
    },
    installMode: "update",
    targetFirmware: firmware(STOCK_SHA),
    installedProvenance: {},
    differenceSourceFirmware: firmware(TARGET_SHA),
    differencePlan: reverseDifferencePlan,
    observedTempleVersions: observedBoth("2.1.1.12"),
  });
  assert.deepEqual(calls, [
    [
      firmware(STOCK_SHA),
      "both",
      { mode: "complete" },
    ],
  ]);
});

test("automatic Update already at target performs reset-only verification", async () => {
  let resetCalls = 0;
  let resetOptions = null;
  const result = await executeAutomaticApply({
    session: {
      restartAndVerifyBothTemples: async (options) => {
        resetCalls += 1;
        resetOptions = options;
        return { applicationLivenessVerified: true };
      },
    },
    installMode: "update",
    targetFirmware: {
      ...firmware(TARGET_SHA),
      g2Version: "2.2.6.11",
    },
    installedProvenance: both(TARGET_SHA),
  });
  assert.equal(resetCalls, 1);
  assert.equal(resetOptions.expectedVersion, "2.2.6.11");
  assert.equal(result.action, "verify-only");
  assert.equal(result.result.applicationLivenessVerified, true);
});

test("automatic Update reuses the fresh matching preflight instead of resetting twice", async () => {
  const readiness = {
    applicationLivenessVerified: true,
    firmwareBytesTransmitted: 0,
    caseVersion: "1.2.57",
    telemetry: { leftPresent: true, rightPresent: true },
    versions: {
      right: {
        firmware: "2.2.6.11",
        hardware: 5,
        yhmRestoreVerified: true,
      },
      left: {
        firmware: "2.2.6.11",
        hardware: 5,
        yhmRestoreVerified: true,
      },
    },
  };
  const result = await executeAutomaticApply({
    session: {
      restartAndVerifyBothTemples: async () => {
        throw new Error("must not issue a second reset");
      },
    },
    installMode: "update",
    targetFirmware: {
      ...firmware(TARGET_SHA),
      g2Version: "2.2.6.11",
    },
    installedProvenance: both(TARGET_SHA),
    observedTempleVersions: observedBoth("2.2.6.11"),
    verifiedTempleReadiness: readiness,
  });

  assert.equal(result.action, "verify-only");
  assert.equal(result.result, readiness);
});

test("classifies a Case-transport probe failure as no temple evidence", () => {
  const transportError = new Error(
    "Timed out reading Go address ACK: received 0 of 1 bytes.",
  );
  transportError.caseTransportFailure = true;
  const classified = classifyAutomaticTempleBootState({
    present: true,
    error: transportError,
  });
  assert.equal(classified.state, "case-transport-failure");
  assert.equal(classified.applicationResponsive, null);

  const healthy = classifyAutomaticTempleBootState({
    present: true,
    probe: versionProbe("2.2.8.4"),
  });
  const plan = minimumAutomaticRecoveryPlan({
    left: classified,
    right: healthy,
  });
  assert.equal(plan.action, "retry-analysis");
  assert.equal(plan.executable, false);
  assert.equal(plan.firmwareWriteRequired, false);
});

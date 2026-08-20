import {
  POGO_TRANSFER_RESEARCH,
  bytesToBase64,
  hex,
  hexBytes,
} from "./firmware.js";
import {
  REVIEWED_CASE_VERSION,
  REVIEWED_CFW_BASE_VERSION,
  REVIEWED_CFW_VERSION,
} from "./pogoFlashBridge.js";
import {
  assessAutomaticTempleContacts,
  minimumAutomaticRecoveryPlan,
} from "./automaticRecovery.js";
import {
  WEBFLASHER_BUILD_LABEL,
  WEBFLASHER_BUILD_SHA,
} from "./releaseIntegrity.js";

export const DEVICE_ANALYTICS_SCHEMA_VERSION = 5;

const FACTORY_QUERIES = Object.freeze([
  Object.freeze({ command: "DEA0", scope: "case", data: "case firmware banner and serial" }),
  Object.freeze({ command: "DEA2", scope: "case", data: "factory identifier" }),
  Object.freeze({ command: "DEA3", scope: "case+glasses", data: "case power, lid, and left/right presence telemetry" }),
  Object.freeze({ command: "DEA4", scope: "case", data: "scalar factory state" }),
]);

function serializeProof(proof) {
  if (!proof) return null;
  return {
    baselineMask: hex(proof.baselineMask),
    selectedMask: hex(proof.selectedMask),
    restoredMask: hex(proof.restoredMask),
    writeMask: hex(proof.writeMask),
    transmittedBytes: proof.transmitted,
    capturedBytes: proof.stored,
    uartErrorMask: hex(proof.errors),
    baselineYhmRegistersHex: hexBytes(proof.baseline),
  };
}

function serializeProbe(probe) {
  if (!probe) return null;
  return {
    operation: probe.operation,
    route: probe.route,
    observedAt: probe.observedAt ?? null,
    decoded: { ...probe.decoded },
    capturedFrameHex: hexBytes(probe.captured),
    capturedFrameBase64: bytesToBase64(probe.captured),
    transportProof: serializeProof(probe.transportProof),
  };
}

function templeAnalytics(side, present, results) {
  const version = serializeProbe(results?.version);
  const status = serializeProbe(results?.status);
  const analysisState =
    version && status
      ? "complete"
      : version || status
        ? "partial"
        : results?.lastProbeFailure
          ? "failed"
          : "not-analyzed";
  const firmwareVersion = version?.decoded?.firmwareVersion ?? null;
  const hardwareRevision = version?.decoded?.hardwareRevision ?? null;
  // A Case-side ROM/serial transport failure happens before the bridge ever
  // queries the temple, so it carries no evidence about temple liveness.
  const caseTransportFailure = Boolean(results?.lastProbeFailure?.caseTransport);
  const applicationResponsive =
    analysisState === "not-analyzed"
      ? null
      : analysisState === "failed"
        ? caseTransportFailure
          ? null
          : false
        : true;
  const completeMainWriterCompatible = version
    ? Boolean(firmwareVersion && hardwareRevision === 5)
    : null;
  const reviewedWriterCompatible = version
    ? [REVIEWED_CFW_BASE_VERSION, REVIEWED_CFW_VERSION].includes(
        firmwareVersion,
      ) && hardwareRevision === 5
    : null;
  return {
    side,
    present: Boolean(present),
    analysisState,
    caseTransportFailure:
      analysisState === "failed" ? caseTransportFailure : false,
    lastProbeFailure: results?.lastProbeFailure
      ? { ...results.lastProbeFailure }
      : null,
    applicationResponsive,
    bootState: !present
      ? "not-seated"
      : applicationResponsive === true
        ? "application"
        : applicationResponsive === false
          ? "recovery-or-unresponsive"
          : "not-analyzed",
    bootStateBoundary:
      applicationResponsive === false
        ? "The Case bridge did not receive an Application-mode reply. It cannot distinguish Apollo recovery/bootloader state from a rebooting, charging-negotiation, or otherwise silent application."
        : analysisState === "failed" && caseTransportFailure
          ? "The Case-side STM32 ROM/serial transport failed before the reviewed bridge could query this temple; the failure carries no evidence about the temple state."
          : null,
    firmwareVersion,
    hardwareRevision,
    batteryPercent: status?.decoded?.batteryPercent ?? null,
    voltageMv: status?.decoded?.voltageMv ?? null,
    reviewedWriterCompatible,
    completeMainWriterCompatible,
    differentialSourceCompatible: reviewedWriterCompatible,
    version,
    status,
  };
}

function recoveryEvidence() {
  const bridge = POGO_TRANSFER_RESEARCH.caseUsbBridge;
  const successfulTransfers = Object.fromEntries(
    Object.entries(bridge.successfulTransfers).map(([side, value]) => [
      side,
      {
        route: value.route,
        imageSha256: value.imageSha256,
        mainPayloadSha256: value.mainPayloadSha256,
        payloadBytes: value.payloadBytes,
        acceptedBytes: value.acceptedBytes,
        recordsSent: value.recordsSent,
        expectedSequence: value.expectedSequence,
        dataRetries: value.dataRetries,
        finishAckReceived: value.finishAckReceived,
        preflightFirmware: value.preflightFirmware,
        postflightFirmware: value.postflightFirmware,
        hardware: value.hardware,
        templeTxCount: value.templeTxCount,
        templeRxCount: value.templeRxCount,
        baselineMask: value.baselineMask,
        selectedMask: value.selectedMask,
        restoredMask: value.restoredMask,
        baselineYhmRegistersHex: value.baseline,
        templeUartErrors: value.templeUartErrors,
        caseApplicationVersion: value.caseApplicationVersion,
        caseRestoreVerified: value.caseRestoreVerified,
      },
    ]),
  );
  return {
    asOf: POGO_TRANSFER_RESEARCH.asOf,
    status: bridge.status,
    attempts: bridge.attempts,
    validationBoundary: bridge.validationBoundary,
    attemptedBridgeSha256: [...bridge.attemptedBridgeSha256],
    currentBridgeDeclaredSha256: bridge.declaredSha256,
    currentBridgeSha256: bridge.observedSha256,
    currentBridgeBytes: bridge.observedBytes,
    currentSourceHardwareRuns: bridge.hardwareAttemptsWithCurrentSource,
    currentSourceSuccessfulHardwareRuns:
      bridge.successfulHardwareAttemptsWithCurrentSource,
    successfulTransfers,
    failureEvidence: {
      bestPartialTransfer: { ...bridge.bestPartialTransfer },
      failClosedAttempt: { ...bridge.failClosedAttempt },
      leftFailClosed: { ...bridge.leftFailClosed },
      leftPartialTransfer: { ...bridge.leftPartialTransfer },
      persistentDataRejectionBoundary: {
        ...bridge.persistentDataRejectionBoundary,
      },
      cachedResponseHeaderTruncation: {
        ...bridge.cachedResponseHeaderTruncation,
        acceptedBytesByAttempt: [
          ...bridge.cachedResponseHeaderTruncation.acceptedBytesByAttempt,
        ],
      },
      cachedResponsePayloadTruncation: {
        ...bridge.cachedResponsePayloadTruncation,
        attempts: bridge.cachedResponsePayloadTruncation.attempts.map(
          (attempt) => ({ ...attempt }),
        ),
      },
      observed33YhmProfile: {
        ...bridge.observed33YhmProfile,
        baselines: [...bridge.observed33YhmProfile.baselines],
      },
    },
    allowlist: {
      component: POGO_TRANSFER_RESEARCH.directTempleHost.component,
      directHostOfflineTestsPassed:
        POGO_TRANSFER_RESEARCH.directTempleHost.offlineTestsPassed,
      startAndHeaderReplayAllowed:
        POGO_TRANSFER_RESEARCH.directTempleHost.startAndHeaderReplayAllowed,
      dataRetryOnly: POGO_TRANSFER_RESEARCH.directTempleHost.dataRetryOnly,
      dataRetryReasons: [
        ...POGO_TRANSFER_RESEARCH.directTempleHost.dataRetryReasons,
      ],
      deferredBatchSettleMs:
        POGO_TRANSFER_RESEARCH.directTempleHost.deferredBatchSettleMs,
      persistentDataRejectionWindowRecords:
        POGO_TRANSFER_RESEARCH.directTempleHost
          .persistentDataRejectionWindowRecords,
      maximumWholeComponentRestarts:
        POGO_TRANSFER_RESEARCH.directTempleHost.maximumWholeComponentRestarts,
      maximumHostTimeoutWholeComponentRestarts:
        POGO_TRANSFER_RESEARCH.directTempleHost
          .maximumHostTimeoutWholeComponentRestarts,
      postflightVersionRequired:
        POGO_TRANSFER_RESEARCH.directTempleHost.postflightVersionRequired,
      bootloaderAllowed: false,
    },
  };
}

function caseVariantAssessment(report) {
  const usb = report.usb ?? {};
  const rom = report.rom ?? {};
  const matchesReviewedElectronicProfile =
    usb.vendorId === 0x1a86 &&
    usb.productId === 0x7523 &&
    rom.protocolVersion === 0x31 &&
    rom.productId === 0x0467 &&
    report.options?.dualBank === true;
  return {
    frameFitVariant: null,
    frameFitVariantReportedByDevice: false,
    matchesReviewedElectronicProfile,
    electronicSignature: {
      usbVendorId: usb.vendorId == null ? null : hex(usb.vendorId, 4),
      usbProductId: usb.productId == null ? null : hex(usb.productId, 4),
      romProtocolVersion:
        rom.protocolVersion == null ? null : hex(rom.protocolVersion, 2),
      stm32ProductId:
        rom.productId == null ? null : hex(rom.productId, 4),
      dualBank: report.options?.dualBank ?? null,
    },
    boundary:
      "The observed factory console and STM32 ROM fields do not identify the G2 Frame A/Frame B case-fit variant. The WebFlasher does not infer that mechanical variant from the factory identifier.",
  };
}

export function buildG2DeviceAnalytics({
  report,
  pogoResults = {},
  recoveryConfig = null,
  templeFlashAudit = null,
  bluetoothFlashAudit = null,
  generatedAt = new Date().toISOString(),
}) {
  if (!report) throw new Error("Analyze the G2 case before building analytics.");
  const telemetry = report.console?.telemetry;
  const left = templeAnalytics("left", telemetry?.leftPresent, pogoResults.left);
  const right = templeAnalytics("right", telemetry?.rightPresent, pogoResults.right);
  left.caseReportedCharging =
    report.console?.templeCharging?.left ?? null;
  right.caseReportedCharging =
    report.console?.templeCharging?.right ?? null;
  const caseVersion =
    report.console?.caseVersion ?? report.banks?.active?.version ?? null;
  const caseCompatible = caseVersion === REVIEWED_CASE_VERSION;
  const contactAssessment = assessAutomaticTempleContacts(telemetry);
  const bothTemplesAnalyzed =
    left.analysisState !== "not-analyzed" &&
    right.analysisState !== "not-analyzed";
  const bothTemplesResponsive = bothTemplesAnalyzed
    ? left.applicationResponsive === true &&
      right.applicationResponsive === true
    : null;
  const bothTemplesWriterCompatible =
    left.completeMainWriterCompatible == null ||
    right.completeMainWriterCompatible == null
      ? null
      : left.completeMainWriterCompatible &&
        right.completeMainWriterCompatible;
  const bothRoutesReady =
    bothTemplesResponsive == null ||
    bothTemplesWriterCompatible == null
      ? null
      : caseCompatible &&
        left.present &&
        right.present &&
        bothTemplesResponsive &&
        bothTemplesWriterCompatible;
  // A Case-side transport failure is "analyzed" in the sense that a probe ran,
  // but it proves nothing about the temple, so the plan must ask for a fresh
  // analysis instead of a recovery step chosen on zero temple evidence.
  const planState = (temple) =>
    temple.caseTransportFailure ? "case-transport-failure" : temple.bootState;
  const minimumPlan = bothTemplesAnalyzed
    ? minimumAutomaticRecoveryPlan({
        left: { state: planState(left) },
        right: { state: planState(right) },
      })
    : {
        action: "probe-applications",
        executable: true,
        firmwareWriteRequired: false,
        reason:
          "Probe both seated temples for checksum-valid Application-mode version replies before choosing any recovery mutation.",
      };

  return {
    schemaVersion: DEVICE_ANALYTICS_SCHEMA_VERSION,
    reportKind: "even-realities-g2-case-and-smart-glasses-analytics",
    generatedAt,
    webFlasher: {
      buildSha: WEBFLASHER_BUILD_SHA,
      buildLabel: WEBFLASHER_BUILD_LABEL,
      productionBuildIdentity:
        /^[0-9a-f]{40}$/i.test(WEBFLASHER_BUILD_SHA),
    },
    chargingCase: {
      scope: "charging-case MCU, USB bridge, factory console, banks, and option bytes",
      firmwareVersion: caseVersion,
      serialNumber: report.console?.serialNumber ?? null,
      factoryIdentifier: report.console?.identifier ?? null,
      telemetry: telemetry ? { ...telemetry } : null,
      templeCharging:
        report.console?.templeCharging
          ? { ...report.console.templeCharging }
          : null,
      usb: { ...report.usb },
      rom: {
        protocolVersion: report.rom?.protocolVersion ?? null,
        productId: report.rom?.productId ?? null,
        commands: [...(report.rom?.commands ?? [])],
      },
      options: report.options
        ? {
            rdp: hex(report.options.rdp, 2),
            dualBank: report.options.dualBank,
            swapBank: report.options.swapBank,
            activePhysicalBank: report.options.activePhysicalBank,
            inactivePhysicalBank: report.options.inactivePhysicalBank,
            userWord: hex(report.options.userWord),
            complement: hex(report.options.complement),
            rawHex: report.optionBytes ? hexBytes(report.optionBytes) : null,
            rawBase64: report.optionBytes
              ? bytesToBase64(report.optionBytes)
              : null,
          }
        : null,
      banks: report.banks
        ? {
            active: { ...report.banks.active },
            inactive: { ...report.banks.inactive },
          }
        : null,
      variantAssessment: caseVariantAssessment(report),
      shell: {
        transport: `${report.usb?.transport ?? "Unknown USB transport"} at 1,000,000 baud, 8N1`,
        allowlistedQueries: FACTORY_QUERIES.map((query) => ({ ...query })),
        rawOutput: report.console?.text ?? "",
      },
    },
    smartGlasses: {
      scope: "left/right running Apollo applications reached through the case pogo routes",
      sourceBoundary:
        "The case reports presence and informational charging estimates. Application version/status and route proof come from the reviewed volatile SRAM bridge.",
      contactAssessment,
      left,
      right,
      // A pair reporting two different versions is the fingerprint of an
      // interrupted cross-version update — one route completed, the other
      // kept its source image. It is a recoverable state, not damage: both
      // applications answer, and converging the off-target route (Automatic
      // Apply, or a one-route complete-main install) heals the pair.
      pairAssessment:
        left.firmwareVersion && right.firmwareVersion
          ? {
              matched: left.firmwareVersion === right.firmwareVersion,
              leftVersion: left.firmwareVersion,
              rightVersion: right.firmwareVersion,
              note:
                left.firmwareVersion === right.firmwareVersion
                  ? "Both temples report the same firmware."
                  : "The temples report different firmware versions — the usual remnant of an interrupted cross-version update. Both applications are responsive; converge the off-target route to heal the pair.",
            }
          : null,
      recoveryAssessment: {
        mode: "running-application Apollo-main reinstall through case USB",
        requiredCaseVersion: REVIEWED_CASE_VERSION,
        requiredTempleVersions: [
          REVIEWED_CFW_BASE_VERSION,
          REVIEWED_CFW_VERSION,
        ],
        requiredTempleVersionsScope: "Stock-CFW differential mode only",
        completeMainSourceRequirement:
          "Any checksum-valid running G2 application on hardware revision 5",
        requiredHardwareRevision: 5,
        caseCompatible,
        bothTemplesAnalyzed,
        bothTemplesResponsive,
        bothTemplesWriterCompatible,
        bothRoutesReady,
        minimumPlan,
        noFlashBilateralResetAvailable:
          left.present && right.present && caseCompatible,
        applicationDeadRecoveryAvailable: false,
        bootloaderWriteAllowed: false,
        limitation:
          "The no-flash path can issue the traced bilateral reset and verify Application-mode return. The validated Case-USB writer can reinstall only a pinned Apollo main while each temple application and pogo UART task remain alive. It cannot read temple flash or address sparse sectors; cross-version installs use the complete target main, and only the exact reviewed Stock-CFW pair may omit unchanged bundle components.",
      },
      offlineRecoveryProvisioning: recoveryConfig,
    },
    validatedRecoveryEvidence: recoveryEvidence(),
    sessionRecoveryAuditState: templeFlashAudit
      ? "captured-current-page-session"
      : "not-captured-in-current-page-session",
    sessionRecoveryAudit: templeFlashAudit,
    sessionBluetoothRecoveryAuditState: bluetoothFlashAudit
      ? "captured-current-page-session"
      : "not-captured-in-current-page-session",
    sessionBluetoothRecoveryAudit: bluetoothFlashAudit,
  };
}

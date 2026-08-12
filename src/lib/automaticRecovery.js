import { decodeOptionBytes } from "./firmware.js";
import { describeByteDifferences } from "./differential.js";

export const DEFAULT_INTERFACE_MODE = "easy";
export const DEFAULT_AUTOMATIC_INSTALL_MODE = "update";
export const DEFAULT_AUTOMATIC_CASE_UPDATE = true;
export const AUTOMATIC_INSTALL_MODES = Object.freeze(["update", "restore"]);

const ROUTES = Object.freeze(["right", "left"]);
const REVIEWED_STOCK_CFW_PAIRS = Object.freeze([
  Object.freeze(["2.2.6.10", "2.2.6.11", "2.2.6.12"]),
]);
const MAIN_COMPONENT = "ota/s200_firmware_ota.bin";

function automaticProbeIdentity(probe) {
  const decoded = probe?.decoded;
  if (
    decoded?.kind !== "version" ||
    !decoded.firmwareVersion ||
    !Number.isInteger(decoded.hardwareRevision)
  ) {
    return null;
  }
  return {
    firmwareVersion: decoded.firmwareVersion,
    hardwareRevision: decoded.hardwareRevision,
  };
}

export function classifyAutomaticTempleBootState({
  present,
  probe = null,
  error = null,
} = {}) {
  if (present !== true) {
    return {
      state: present === false ? "not-seated" : "contact-unknown",
      applicationResponsive: null,
      firmwareVersion: null,
      hardwareRevision: null,
      detail:
        present === false
          ? "The Charging Case does not report this temple as seated."
          : "Fresh Charging Case contact telemetry is unavailable.",
    };
  }
  const identity = automaticProbeIdentity(probe);
  if (identity) {
    return {
      state: "application",
      applicationResponsive: true,
      ...identity,
      detail: `Checksum-valid Application-mode version reply ${identity.firmwareVersion}/hardware ${identity.hardwareRevision}.`,
    };
  }
  return {
    // The reviewed Case bridge can prove a running application, but it cannot
    // interrogate Apollo's ROM/secondary bootloader. Keep the uncertain half
    // explicit instead of mislabelling every silent application as recovery.
    state: "recovery-or-unresponsive",
    applicationResponsive: false,
    firmwareVersion: null,
    hardwareRevision: null,
    detail:
      error?.message ??
      "No checksum-valid Application-mode version reply was received; the temple may be in recovery, rebooting, charging negotiation, or otherwise unresponsive.",
  };
}

export function minimumAutomaticRecoveryPlan(temples) {
  const routes = ROUTES.map((route) => temples?.[route]);
  if (routes.some((temple) => temple?.state === "contact-unknown")) {
    return {
      action: "refresh-telemetry",
      executable: false,
      firmwareWriteRequired: false,
      reason: "Fresh left/right Charging Case contact telemetry is required.",
    };
  }
  if (routes.some((temple) => temple?.state === "not-seated")) {
    return {
      action: "reseat",
      executable: false,
      firmwareWriteRequired: false,
      reason:
        "Both temples must be seated before the bilateral reboot can be issued and verified.",
    };
  }
  if (routes.every((temple) => temple?.state === "application")) {
    return {
      action: "none",
      executable: true,
      firmwareWriteRequired: false,
      reason:
        "Both temples already returned checksum-valid Application-mode version replies; no recovery mutation is needed.",
    };
  }
  return {
    action: "reset-and-verify",
    executable: true,
    firmwareWriteRequired: false,
    reason:
      "At least one seated temple did not answer in Application mode. Issue the traced bilateral reboot once, then prove both applications before considering firmware transfer.",
  };
}

export async function diagnoseAndRecoverAutomaticUsb({
  session,
  onStep = () => {},
  forceResetReason = null,
} = {}) {
  if (
    !session?.readTempleFlashPreflight ||
    !session?.probeRunningTemple ||
    !session?.restartAndVerifyBothTemples
  ) {
    throw new Error(
      "A G2 Case session with telemetry, version-probe, and bilateral-reset support is required.",
    );
  }

  await onStep({ step: "telemetry" });
  const preflight = await session.readTempleFlashPreflight([]);
  const telemetry = preflight?.telemetry;
  const temples = {};
  const probes = {};
  for (let index = 0; index < ROUTES.length; index += 1) {
    const route = ROUTES[index];
    const present =
      route === "left" ? telemetry?.leftPresent : telemetry?.rightPresent;
    if (present !== true) {
      temples[route] = classifyAutomaticTempleBootState({ present });
      continue;
    }
    await onStep({ step: "probe", route });
    try {
      const probe = await session.probeRunningTemple("version", route, {
        progressBase: 0.08 + index * 0.16,
        progressSpan: 0.16,
      });
      probes[route] = probe;
      temples[route] = classifyAutomaticTempleBootState({ present, probe });
    } catch (error) {
      probes[route] = { error: error?.message ?? String(error) };
      temples[route] = classifyAutomaticTempleBootState({ present, error });
    }
  }

  const initialPlan = minimumAutomaticRecoveryPlan(temples);
  if (!initialPlan.executable) {
    const error = new Error(initialPlan.reason);
    error.diagnosis = { preflight, temples, probes, initialPlan };
    throw error;
  }
  if (initialPlan.action === "none" && !forceResetReason) {
    return {
      outcome: "healthy",
      action: "none",
      firmwareBytesTransmitted: 0,
      preflight,
      temples,
      probes,
      initialPlan,
      finalPlan: initialPlan,
    };
  }

  const resetReason = forceResetReason
    ? String(forceResetReason)
    : initialPlan.reason;
  await onStep({ step: "reset", reason: resetReason });
  try {
    const verification = await session.restartAndVerifyBothTemples({
      progressBase: 0.4,
      progressSpan: 0.58,
      purpose: forceResetReason
        ? "Automatic Bluetooth-advertising recovery"
        : "Automatic no-flash recovery",
    });
    const recoveredTemples = Object.fromEntries(
      ROUTES.map((route) => [
        route,
        {
          state: "application",
          applicationResponsive: true,
          firmwareVersion: verification?.versions?.[route]?.firmware ?? null,
          hardwareRevision: verification?.versions?.[route]?.hardware ?? null,
          detail:
            "The bilateral reboot completed and a checksum-valid Application-mode version reply was verified.",
        },
      ]),
    );
    return {
      outcome: "recovered",
      action: forceResetReason
        ? "reset-for-bluetooth-and-verify"
        : "reset-and-verify",
      resetReason,
      firmwareBytesTransmitted: 0,
      preflight,
      temples,
      probes,
      initialPlan,
      verification,
      recoveredTemples,
      finalPlan: minimumAutomaticRecoveryPlan(recoveredTemples),
    };
  } catch (error) {
    error.diagnosis = {
      preflight,
      temples,
      probes,
      initialPlan,
      outcome: "needs-firmware-or-service",
      firmwareBytesTransmitted: 0,
      minimumNextStep:
        "Use a previously authorized direct Bluetooth endpoint if it is reachable. The reviewed Case-USB writer requires a running temple application and cannot repair an Apollo bootloader or read temple flash sectors.",
    };
    throw error;
  }
}

export function assessAutomaticTempleContacts(telemetry) {
  if (
    typeof telemetry?.leftPresent !== "boolean" ||
    typeof telemetry?.rightPresent !== "boolean"
  ) {
    return {
      state: "unknown",
      leftPresent: null,
      rightPresent: null,
      bothPresent: null,
      anyPresent: null,
      automaticApplyAllowed: false,
      resetRecoveryEligible: false,
      reason:
        "Fresh left/right Case contact telemetry is required before Automatic Apply. No Case update or Smart Glasses transfer was started.",
    };
  }
  const leftPresent = telemetry.leftPresent;
  const rightPresent = telemetry.rightPresent;
  const bothPresent = leftPresent && rightPresent;
  const anyPresent = leftPresent || rightPresent;
  if (!anyPresent) {
    return {
      state: "neither-detected",
      leftPresent,
      rightPresent,
      bothPresent,
      anyPresent,
      automaticApplyAllowed: false,
      resetRecoveryEligible: false,
      reason:
        "Fresh Case telemetry reports neither Smart Glasses temple. Seat the matching glasses in the Case, refresh analysis, and retry. No Case update or Smart Glasses transfer was started.",
    };
  }
  return {
    state: bothPresent ? "both-detected" : "partial-contact",
    leftPresent,
    rightPresent,
    bothPresent,
    anyPresent,
    automaticApplyAllowed: true,
    resetRecoveryEligible: !bothPresent,
    reason: bothPresent
      ? "Both Smart Glasses temples are detected."
      : "One temple is detected; the bounded bilateral reset/contact recovery gate must restore both before any glasses transfer.",
  };
}

function compareVersions(left, right) {
  const parse = (version) => {
    const text = String(version ?? "").trim();
    if (!/^\d+(?:\.\d+)*$/.test(text)) return null;
    return text.split(".").map((part) => Number.parseInt(part, 10));
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return null;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function resolveAutomaticCaseUpdatePlan({
  enabled = DEFAULT_AUTOMATIC_CASE_UPDATE,
  currentVersion,
  targetRelease,
}) {
  const targetVersion = targetRelease?.caseVersion;
  if (
    targetRelease?.channel !== "official" ||
    targetRelease?.caseRecoveryEligible === false ||
    !targetVersion
  ) {
    return {
      executable: false,
      action: "blocked",
      reason:
        "The firmware library does not contain a verified official Charging Case update.",
    };
  }

  const comparison = compareVersions(currentVersion, targetVersion);
  if (comparison == null) {
    return {
      executable: false,
      action: "blocked",
      reason:
        `Automatic Apply cannot safely compare Case firmware ${currentVersion ?? "unknown"} with ${targetVersion}.`,
    };
  }
  if (comparison === 0) {
    return {
      executable: true,
      action: "none",
      currentVersion,
      targetVersion,
      reason: `The Charging Case already runs the latest firmware ${targetVersion}.`,
    };
  }
  if (comparison > 0) {
    return {
      executable: false,
      action: "blocked",
      currentVersion,
      targetVersion,
      reason:
        `The Charging Case reports ${currentVersion}, newer than library version ${targetVersion}; Automatic Apply will not downgrade it.`,
    };
  }
  if (!enabled) {
    return {
      executable: false,
      action: "blocked",
      currentVersion,
      targetVersion,
      reason:
        `Automatic Smart Glasses recovery requires Case ${targetVersion}; found ${currentVersion}. Enable “Update Charging Case first” and Apply again.`,
    };
  }
  return {
    executable: true,
    action: "update",
    currentVersion,
    targetVersion,
    reason:
      `Update the Charging Case from ${currentVersion} to ${targetVersion}, verify the new active bank, then continue with Smart Glasses recovery.`,
  };
}

function requirePhysicalBank(value, label) {
  if (value !== 1 && value !== 2) {
    throw new Error(
      `Charging Case bank switch verification is missing ${label}. Smart Glasses flashing was not started.`,
    );
  }
  return value;
}

function verifyPreUpdateBankMapping(report) {
  const activePhysicalBank = requirePhysicalBank(
    report?.options?.activePhysicalBank,
    "the pre-update active physical bank",
  );
  const inactivePhysicalBank = requirePhysicalBank(
    report?.options?.inactivePhysicalBank,
    "the pre-update inactive physical bank",
  );
  let decodedOptions;
  try {
    decodedOptions = decodeOptionBytes(report?.optionBytes);
  } catch (error) {
    throw new Error(
      `The pre-update Charging Case option snapshot is invalid: ${error.message}`,
    );
  }
  if (
    activePhysicalBank === inactivePhysicalBank ||
    report?.options?.rdp !== 0xaa ||
    report?.options?.dualBank !== true ||
    typeof report?.options?.swapBank !== "boolean" ||
    decodedOptions.rdp !== report.options.rdp ||
    decodedOptions.dualBank !== report.options.dualBank ||
    decodedOptions.swapBank !== report.options.swapBank ||
    decodedOptions.activePhysicalBank !== activePhysicalBank ||
    decodedOptions.inactivePhysicalBank !== inactivePhysicalBank ||
    report?.banks?.active?.physicalBank !== activePhysicalBank ||
    report?.banks?.inactive?.physicalBank !== inactivePhysicalBank ||
    !report?.banks?.active?.version ||
    report?.banks?.active?.vectorValid !== true
  ) {
    throw new Error(
      "The pre-update Charging Case option bytes, dual-bank mode, active vector, and physical-bank mapping are incomplete or inconsistent. Analyze the Case again before updating it.",
    );
  }
}

export function verifyAutomaticCaseReadiness(report, expectedVersion) {
  const activePhysicalBank = requirePhysicalBank(
    report?.options?.activePhysicalBank,
    "the active physical bank",
  );
  const fallbackPhysicalBank = requirePhysicalBank(
    report?.options?.inactivePhysicalBank,
    "the fallback physical bank",
  );
  const failures = [];
  let decodedOptions = null;
  if (!expectedVersion) {
    failures.push("the required Case version is unknown");
  }
  if (report?.console?.caseVersion !== expectedVersion) {
    failures.push(
      `the application reports ${report?.console?.caseVersion ?? "an unknown version"}, expected ${expectedVersion}`,
    );
  }
  if (
    !(report?.optionBytes instanceof Uint8Array) ||
    report.optionBytes.length !== 128
  ) {
    failures.push("fresh 128-byte option data is unavailable");
  } else {
    try {
      decodedOptions = decodeOptionBytes(report.optionBytes);
    } catch (error) {
      failures.push(`the option snapshot is invalid (${error.message})`);
    }
  }
  if (
    report?.options?.rdp !== 0xaa ||
    report?.options?.dualBank !== true ||
    typeof report?.options?.swapBank !== "boolean"
  ) {
    failures.push("the Case is not in the reviewed level-0 dual-bank mode");
  }
  if (
    decodedOptions &&
    (decodedOptions.rdp !== report.options.rdp ||
      decodedOptions.dualBank !== report.options.dualBank ||
      decodedOptions.swapBank !== report.options.swapBank ||
      decodedOptions.activePhysicalBank !== activePhysicalBank ||
      decodedOptions.inactivePhysicalBank !== fallbackPhysicalBank)
  ) {
    failures.push("the decoded option snapshot and reported bank mode disagree");
  }
  if (activePhysicalBank === fallbackPhysicalBank) {
    failures.push("the active and fallback physical banks are identical");
  }
  if (
    report?.banks?.active?.physicalBank !== activePhysicalBank ||
    report?.banks?.inactive?.physicalBank !== fallbackPhysicalBank
  ) {
    failures.push("the option bytes and physical-bank aliases disagree");
  }
  if (
    report?.banks?.active?.version !== expectedVersion ||
    report?.banks?.active?.vectorValid !== true
  ) {
    failures.push(
      `active physical bank ${activePhysicalBank} is not a valid ${expectedVersion} image`,
    );
  }
  if (report?.banks?.inactive?.vectorValid !== true) {
    failures.push(
      `fallback physical bank ${fallbackPhysicalBank} does not contain a valid vector table`,
    );
  }

  if (failures.length) {
    throw new Error(
      `Charging Case readiness was not proven: ${failures.join("; ")}. Smart Glasses flashing was not started.`,
    );
  }
  return {
    verified: true,
    expectedVersion,
    activePhysicalBank,
    fallbackPhysicalBank,
    activeVersion: report.banks.active.version,
    fallbackVersion: report.banks.inactive.version ?? null,
    swapBank: report.options.swapBank,
  };
}

export function verifyAutomaticCaseBankSwitch({
  beforeReport,
  afterReport,
  targetVersion,
}) {
  const previousActivePhysicalBank = requirePhysicalBank(
    beforeReport?.options?.activePhysicalBank,
    "the pre-update active physical bank",
  );
  const stagedPhysicalBank = requirePhysicalBank(
    beforeReport?.options?.inactivePhysicalBank,
    "the pre-update inactive physical bank",
  );
  const activePhysicalBank = requirePhysicalBank(
    afterReport?.options?.activePhysicalBank,
    "the post-update active physical bank",
  );
  const fallbackPhysicalBank = requirePhysicalBank(
    afterReport?.options?.inactivePhysicalBank,
    "the post-update inactive physical bank",
  );
  const previousSwapBank = beforeReport?.options?.swapBank;
  const activeSwapBank = afterReport?.options?.swapBank;
  const previousActiveVersion = beforeReport?.banks?.active?.version;
  const fallbackVersion = afterReport?.banks?.inactive?.version;

  const failures = [];
  if (previousActivePhysicalBank === stagedPhysicalBank) {
    failures.push("the pre-update bank mapping is invalid");
  }
  if (
    beforeReport?.banks?.active?.physicalBank !== previousActivePhysicalBank ||
    beforeReport?.banks?.inactive?.physicalBank !== stagedPhysicalBank
  ) {
    failures.push("the pre-update option bytes and bank aliases disagree");
  }
  if (
    typeof previousSwapBank !== "boolean" ||
    typeof activeSwapBank !== "boolean" ||
    previousSwapBank === activeSwapBank
  ) {
    failures.push("the nSWAP_BANK option did not toggle");
  }
  if (
    activePhysicalBank !== stagedPhysicalBank ||
    fallbackPhysicalBank !== previousActivePhysicalBank
  ) {
    failures.push(
      `physical bank ${stagedPhysicalBank} did not become active while physical bank ${previousActivePhysicalBank} became the fallback`,
    );
  }
  if (
    afterReport?.banks?.active?.physicalBank !== activePhysicalBank ||
    afterReport?.banks?.inactive?.physicalBank !== fallbackPhysicalBank
  ) {
    failures.push("the post-update option bytes and bank aliases disagree");
  }
  if (afterReport?.banks?.active?.version !== targetVersion) {
    failures.push(
      `active physical bank ${activePhysicalBank} reports ${afterReport?.banks?.active?.version ?? "an unknown version"}, expected ${targetVersion}`,
    );
  }
  if (
    !previousActiveVersion ||
    fallbackVersion !== previousActiveVersion
  ) {
    failures.push(
      `the fallback bank reports ${fallbackVersion ?? "an unknown version"}, expected the preserved pre-update version ${previousActiveVersion ?? "unknown"}`,
    );
  }

  if (failures.length) {
    throw new Error(
      `Charging Case bank switch was not confirmed after staging ${targetVersion}: ${failures.join("; ")}. Smart Glasses flashing was not started.`,
    );
  }

  return {
    verified: true,
    targetVersion,
    previousActiveVersion,
    fallbackVersion,
    previousActivePhysicalBank,
    stagedPhysicalBank,
    activePhysicalBank,
    fallbackPhysicalBank,
    previousSwapBank,
    activeSwapBank,
  };
}

export async function executeAutomaticCaseUpdate({
  session,
  currentReport,
  targetFirmware,
  onStep,
}) {
  if (!session) throw new Error("An analyzed G2 Case session is required.");
  if (
    !targetFirmware?.caseRecoveryEligible ||
    !(targetFirmware.caseImage instanceof Uint8Array) ||
    !targetFirmware.caseImage.length ||
    !targetFirmware.caseVersion
  ) {
    throw new Error(
      "The automatic Case update requires a validated official Case recovery image.",
    );
  }
  if (!(currentReport?.optionBytes instanceof Uint8Array)) {
    throw new Error(
      "Fresh Case option bytes are required before an automatic Case update.",
    );
  }
  verifyPreUpdateBankMapping(currentReport);

  await onStep?.("stage", targetFirmware);
  const staged = await session.stageCaseImage(
    targetFirmware.caseImage,
    currentReport.optionBytes,
    { progressBase: 0.04, progressSpan: 0.22 },
  );
  await onStep?.("activate", targetFirmware);
  const activation = await session.activateStagedBank(
    targetFirmware.caseImage,
    currentReport.optionBytes,
    { progressBase: 0.26, progressSpan: 0.1 },
  );
  if (activation?.caseVersion !== targetFirmware.caseVersion) {
    throw new Error(
      `The Charging Case restarted on ${activation?.caseVersion ?? "an unknown version"}, expected ${targetFirmware.caseVersion}.`,
    );
  }

  await onStep?.("reanalyze", targetFirmware);
  const report = await session.analyze({
    progressBase: 0.36,
    progressSpan: 0.12,
  });
  if (
    report?.console?.caseVersion !== targetFirmware.caseVersion ||
    report?.banks?.active?.version !== targetFirmware.caseVersion
  ) {
    throw new Error(
      `The Charging Case update was not proven in both the application and active bank (expected ${targetFirmware.caseVersion}).`,
    );
  }

  await onStep?.("verify-bank-switch", targetFirmware);
  const bankSwitch = verifyAutomaticCaseBankSwitch({
    beforeReport: currentReport,
    afterReport: report,
    targetVersion: targetFirmware.caseVersion,
  });

  await onStep?.("confirm", targetFirmware);
  const confirmation = await session.confirmCaseFirmwareVersion(
    targetFirmware.caseVersion,
  );
  if (confirmation?.confirmedVersion !== targetFirmware.caseVersion) {
    throw new Error(
      `The fresh Case firmware confirmation returned ${confirmation?.confirmedVersion ?? "unknown"}, expected ${targetFirmware.caseVersion}.`,
    );
  }
  const readiness = verifyAutomaticCaseReadiness(
    report,
    targetFirmware.caseVersion,
  );
  return { staged, activation, report, bankSwitch, confirmation, readiness };
}

function auditVerificationComplete(audit) {
  const verification = audit?.verification;
  return Boolean(
    audit?.outcome === "success" &&
      verification?.everyRouteAcceptedExactTargetBytes &&
      verification?.everyRoutePostflightVersionValid &&
      verification?.finalDualTempleResetVerified &&
      verification?.postResetLivenessVerified,
  );
}

export function provenanceFromSuccessfulAudit(audit) {
  if (
    !auditVerificationComplete(audit) ||
    !/^[0-9a-f]{64}$/i.test(audit?.imageSha256 ?? "") ||
    !Array.isArray(audit?.routes)
  ) {
    return {};
  }
  return Object.fromEntries(
    audit.routes
      .filter((route) => ROUTES.includes(route))
      .map((route) => [
        route,
        {
          imageSha256: audit.imageSha256.toLowerCase(),
          channel: audit.installedIdentity?.channel ?? "unknown",
          reportedVersion: audit.installedIdentity?.reportedVersion ?? null,
          displayVersion: audit.installedIdentity?.displayVersion ?? null,
          provenAt: audit.finishedAt ?? new Date().toISOString(),
          proof: "verified-recovery-audit",
        },
      ]),
  );
}

function routeResultProvesInstall(routeResult, audit) {
  return Boolean(
    routeResult?.outcome === "success" &&
      routeResult?.caseRestoreVerified === true &&
      routeResult?.postflightVersion?.firmware &&
      routeResult?.postflightVersion?.hardware === 5 &&
      audit?.installedIdentity?.reportedVersion &&
      routeResult.postflightVersion.firmware ===
        audit.installedIdentity.reportedVersion,
  );
}

export function mergeInstalledProvenance(current, audit) {
  const next = { ...(current ?? {}) };
  const affectedRoutes = Array.isArray(audit?.routes)
    ? audit.routes.filter((route) => ROUTES.includes(route))
    : [];

  if (audit?.outcome !== "success") {
    // A later route's failure must not discard an earlier route's complete
    // per-route proof: exact accepted bytes, FINISH acknowledgement,
    // postflight version, and Case restoration were all verified before the
    // failing route ever started. Retain that route under a distinct proof
    // tier; every Update still re-probes just-in-time before any START.
    const validImage = /^[0-9a-f]{64}$/i.test(audit?.imageSha256 ?? "");
    for (const route of affectedRoutes) {
      const routeResult = Array.isArray(audit?.routeResults)
        ? audit.routeResults.find((entry) => entry?.route === route)
        : null;
      if (validImage && routeResultProvesInstall(routeResult, audit)) {
        next[route] = {
          imageSha256: audit.imageSha256.toLowerCase(),
          channel: audit.installedIdentity?.channel ?? "unknown",
          reportedVersion: audit.installedIdentity?.reportedVersion ?? null,
          displayVersion: audit.installedIdentity?.displayVersion ?? null,
          provenAt: audit.finishedAt ?? new Date().toISOString(),
          proof: "route-verified-interrupted-audit",
        };
      } else {
        delete next[route];
      }
    }
    return next;
  }
  return { ...next, ...provenanceFromSuccessfulAudit(audit) };
}

export function templeVersionObservationsFromFlashAudit(
  audit,
  { observedAt = new Date().toISOString() } = {},
) {
  if (!Array.isArray(audit?.routeResults)) return {};
  return Object.fromEntries(
    audit.routeResults
      .map((routeResult) => {
        const version =
          routeResult?.postflightVersion ?? routeResult?.preflightVersion;
        if (
          !ROUTES.includes(routeResult?.route) ||
          !version?.firmware
        ) {
          return null;
        }
        const exactWriterRestoration = Boolean(
          routeResult?.caseRestoreVerified === true &&
            routeResult?.retainedResult?.baselineMask === 0x3ff &&
            routeResult?.retainedResult?.selectedMask === 0x3ff &&
            routeResult?.retainedResult?.restoredMask === 0x3ff,
        );
        return [
          routeResult.route,
          {
            version: {
              operation: "version",
              route: routeResult.route,
              decoded: {
                kind: "version",
                firmwareVersion: version.firmware,
                hardwareRevision: version.hardware ?? null,
              },
              transportProof: {
                restoredMask: exactWriterRestoration ? 0x3ff : null,
              },
              observedAt,
            },
          },
        ];
      })
      .filter(Boolean),
  );
}

const DIRECT_BLUETOOTH_RECOVERY_BOUNDARIES = new Set([
  "wired_start_no_frame_zero_byte_boundary",
  "persistent_temple_data_rejection_boundary",
  "maximum_pacing_temple_data_rejection_boundary",
  "yhm_setup_exhausted_zero_byte_boundary",
]);

export function describeAutomaticApplyFailure(error) {
  const fallbackResult = [...(error?.audit?.routeResults ?? [])]
    .reverse()
    .find((routeResult) =>
      DIRECT_BLUETOOTH_RECOVERY_BOUNDARIES.has(
        routeResult?.recoveryBoundary?.classification,
      ),
    );
  if (!fallbackResult) {
    return {
      message: `Stopped safely · ${error?.message || String(error)}`,
      directBluetoothRecommended: false,
      failedRoute: null,
      preservedRoutes: [],
      classification: null,
    };
  }

  const failedRoute = fallbackResult.route;
  const preservedRoutes = (error.audit.routeResults ?? [])
    .filter(
      (routeResult) =>
        routeResult?.route !== failedRoute &&
        routeResult?.outcome === "success" &&
        routeResult?.caseRestoreVerified === true &&
        routeResult?.postflightVersion?.firmware,
    )
    .map((routeResult) => routeResult.route);
  const beforeFirmware =
    fallbackResult?.acceptedFirmwareBytes === 0 &&
    fallbackResult?.otaMutationAttempted === false;
  const stopDescription = beforeFirmware
    ? `before any ${failedRoute}-side firmware was sent`
    : "after the Case route was restored safely";
  const preservation = preservedRoutes.length
    ? ` The ${preservedRoutes.join(" + ")} target install remains verified and can be retained without rewriting it.`
    : "";

  return {
    message:
      `Stopped safely on the ${failedRoute} Case route ${stopDescription}.${preservation} ` +
      "Use Direct recovery fallback below to finish the complete pinned package over Bluetooth.",
    directBluetoothRecommended: true,
    failedRoute,
    preservedRoutes,
    classification: fallbackResult.recoveryBoundary.classification,
  };
}

function knownRouteProofsBelongToPair(
  provenance,
  sourceSha256,
  targetSha256,
) {
  const pair = new Set([sourceSha256, targetSha256].map((value) =>
    String(value ?? "").toLowerCase(),
  ));
  return ROUTES.every((route) => {
    const known = provenance?.[route]?.imageSha256?.toLowerCase();
    return !known || pair.has(known);
  });
}

function supportsLiveCompatiblePairProof(differencePlan) {
  const source = differencePlan?.source;
  const target = differencePlan?.target;
  const wireTransfer = differencePlan?.wireTransfer;
  const verification = differencePlan?.verification;
  return Boolean(
    differencePlan?.executable &&
      differencePlan?.changedMainOnly === true &&
      new Set([source?.version, target?.version]).size === 2 &&
      REVIEWED_STOCK_CFW_PAIRS.some((pair) =>
        [source?.version, target?.version].every((version) => pair.includes(version)),
      ) &&
      wireTransfer?.component === MAIN_COMPONENT &&
      Number.isInteger(wireTransfer?.bytes) &&
      wireTransfer.bytes > 0 &&
      wireTransfer?.sparseByteRangesSupported === false &&
      verification?.targetBundleSha256?.toLowerCase() ===
        target?.imageSha256?.toLowerCase() &&
      verification?.targetMainSha256?.toLowerCase() ===
        target?.mainSha256?.toLowerCase() &&
      verification?.targetMainBytes === wireTransfer.bytes &&
      verification?.finishAcknowledgementRequired === true &&
      verification?.postResetLivenessRequired === true &&
      verification?.finalDualTempleResetRequired === true,
  );
}

function observedTempleIdentity(observedTempleVersions, route) {
  const observed = observedTempleVersions?.[route];
  return {
    firmwareVersion:
      observed?.firmwareVersion ?? observed?.firmware ?? observed?.version ?? null,
    hardwareRevision:
      observed?.hardwareRevision ?? observed?.hardware ?? null,
  };
}

function targetFirmwareVersion(targetFirmware) {
  return (
    targetFirmware?.templeFlashTarget?.reportedVersion ??
    targetFirmware?.reportedVersion ??
    targetFirmware?.catalogRelease?.reportedVersion ??
    targetFirmware?.g2Version ??
    targetFirmware?.internalVersion ??
    targetFirmware?.version ??
    targetFirmware?.catalogRelease?.internalVersion ??
    targetFirmware?.catalogRelease?.version ??
    null
  );
}

function decodedTempleIdentity(probe, route) {
  const decoded = probe?.decoded;
  if (
    decoded?.kind !== "version" ||
    !decoded.firmwareVersion ||
    decoded.hardwareRevision !== 5
  ) {
    throw new Error(
      `${route}: the clean-start version check requires a checksum-valid hardware-5 temple reply.`,
    );
  }
  return {
    firmwareVersion: decoded.firmwareVersion,
    hardwareRevision: decoded.hardwareRevision,
  };
}

export async function prepareAutomaticTempleUpdate({
  session,
  progressBase = 0,
  progressSpan = 1,
  onStep,
} = {}) {
  if (
    !session?.probeRunningTemple ||
    !session?.restartAndVerifyBothTemples
  ) {
    throw new Error(
      "A G2 Case session with version-probe and bilateral-reset support is required.",
    );
  }

  const initialProbes = {};
  const initialVersions = {};
  for (let index = 0; index < ROUTES.length; index += 1) {
    const route = ROUTES[index];
    await onStep?.({ step: "version-check", route });
    const probe = await session.probeRunningTemple("version", route, {
      progressBase:
        progressBase + (index / ROUTES.length) * progressSpan * 0.3,
      progressSpan: (progressSpan * 0.3) / ROUTES.length,
    });
    initialProbes[route] = probe;
    initialVersions[route] = decodedTempleIdentity(probe, route);
  }

  await onStep?.({ step: "clean-reset" });
  const verifiedTempleReadiness =
    await session.restartAndVerifyBothTemples({
      progressBase: progressBase + progressSpan * 0.3,
      progressSpan: progressSpan * 0.7,
      purpose: "Automatic clean-start reset",
    });
  const observedTempleVersions = Object.fromEntries(
    ROUTES.map((route) => [
      route,
      {
        firmwareVersion:
          verifiedTempleReadiness?.versions?.[route]?.firmware ?? null,
        hardwareRevision:
          verifiedTempleReadiness?.versions?.[route]?.hardware ?? null,
      },
    ]),
  );
  const changedAcrossReset = ROUTES.filter(
    (route) =>
      initialVersions[route].firmwareVersion !==
        observedTempleVersions[route].firmwareVersion ||
      initialVersions[route].hardwareRevision !==
        observedTempleVersions[route].hardwareRevision,
  );

  return {
    initialProbes,
    initialVersions,
    observedTempleVersions,
    changedAcrossReset,
    verifiedTempleReadiness,
  };
}

function isReusableTempleReadiness(readiness, expectedVersion) {
  return Boolean(
    expectedVersion &&
      readiness?.applicationLivenessVerified === true &&
      readiness?.firmwareBytesTransmitted === 0 &&
      readiness?.caseVersion === "1.2.57" &&
      readiness?.telemetry?.leftPresent === true &&
      readiness?.telemetry?.rightPresent === true &&
      ROUTES.every(
        (route) =>
          readiness?.versions?.[route]?.firmware === expectedVersion &&
          readiness.versions[route].hardware === 5 &&
          readiness.versions[route].yhmRestoreVerified === true,
      ),
  );
}

function completeAutomaticUpdatePlan(targetSha256, reason, route = "both") {
  return {
    executable: true,
    action: "flash",
    route,
    flashMode: "complete",
    sourceProofMode: "complete-target-main",
    targetSha256,
    reason,
  };
}

function completeResetLivenessProof(audit) {
  const resetVersions = audit?.finalResetAndLiveness?.versions;
  return Boolean(
    audit?.finalResetAndLiveness?.resetConfirmed === true &&
      audit.finalResetAndLiveness.caseFirmware === "1.2.57" &&
      ROUTES.every(
        (route) =>
          resetVersions?.[route]?.firmware &&
          resetVersions[route].hardware === 5 &&
          resetVersions[route].yhmRestoreVerified === true,
      ),
  );
}

function differentialFallbackDetails(error, plan) {
  const audit = error?.audit;
  const routeResults = audit?.routeResults;
  const requiredSourceVersion =
    audit?.sourceValidation?.requiredLiveFirmware;
  if (
    plan?.flashMode !== "differences" ||
    !plan?.sourceVersion ||
    requiredSourceVersion !== plan.sourceVersion ||
    audit?.outcome !== "failed_or_uncertain" ||
    audit?.flashMode !== "differences" ||
    !Array.isArray(audit?.routes) ||
    audit.routes.length !== ROUTES.length ||
    !ROUTES.every((route) => audit.routes.includes(route)) ||
    !Array.isArray(routeResults) ||
    routeResults.length === 0 ||
    !completeResetLivenessProof(audit)
  ) {
    return null;
  }

  const zeroWritePreflightMismatch =
    [
      audit?.routeOrderSetupStops,
      audit?.supersededSuccessfulRouteResults,
      audit?.routeComponentRestartAttempts,
      audit?.routeComponentRestartResets,
      audit?.persistentDataRejectionStops,
      audit?.routeSetupResetStops,
      audit?.routeSetupResetResults,
    ].every((history) => Array.isArray(history) && history.length === 0) &&
    routeResults.length === 1 &&
    routeResults.every(
      (result) =>
        ROUTES.includes(result?.route) &&
        result?.outcome === "failed_or_uncertain" &&
        result?.failureStage === "PREFLIGHT" &&
        result?.otaMutationAttempted === false &&
        result?.acceptedFirmwareBytes === 0 &&
        result?.preflightVersion?.hardware === 5 &&
        result?.preflightVersion?.firmware &&
        result.preflightVersion.firmware !== requiredSourceVersion &&
        result?.caseRestoreVerified === true &&
        result?.caseApplicationVersion === "1.2.57" &&
        result?.retainedResult?.acceptedSize === 0 &&
        result?.retainedResult?.baselineMask === 0x3ff &&
        result?.retainedResult?.selectedMask === 0x3ff &&
        result?.retainedResult?.restoredMask === 0x3ff &&
        result?.retainedResult?.templeUartErrors === 0,
    );
  if (zeroWritePreflightMismatch) {
    const observedVersion =
      routeResults[0].preflightVersion.firmware;
    return {
      kind: "differential-to-complete",
      trigger: "source-preflight-mismatch",
      observedVersion,
      observedVersions: Object.fromEntries(
        ROUTES.map((route) => [
          route,
          audit.finalResetAndLiveness.versions[route].firmware,
        ]),
      ),
      failedRoutes: [routeResults[0].route],
      reason:
        `Just-in-time preflight reported ${observedVersion}/hardware 5 instead of the reviewed differential source.`,
    };
  }

  const targetBytes =
    audit?.differencePlan?.verification?.targetMainBytes ??
    audit?.differencePlan?.wireTransfer?.bytes;
  const failedPostflightRoutes = routeResults
    .filter(
      (result) =>
        result?.outcome === "failed_or_uncertain" &&
        result?.failureStage === "POSTFLIGHT",
    )
    .map((result) => result.route);
  const targetVersion = audit?.differencePlan?.target?.version;
  const failedFinalLivenessRoutes = targetVersion
    ? ROUTES.filter(
        (route) =>
          audit.finalResetAndLiveness.versions[route].firmware !==
          targetVersion,
      )
    : [];
  const bootFailureRoutes = [
    ...new Set([
      ...failedPostflightRoutes,
      ...failedFinalLivenessRoutes,
    ]),
  ];
  const safeCompletedTransfers = Boolean(
    Number.isInteger(targetBytes) &&
      targetBytes > 0 &&
      bootFailureRoutes.length > 0 &&
      routeResults.every(
        (result) =>
          ROUTES.includes(result?.route) &&
          ["success", "failed_or_uncertain"].includes(result?.outcome) &&
          (result.outcome === "success" ||
            result.failureStage === "POSTFLIGHT") &&
          result?.otaMutationAttempted === true &&
          result?.transfer?.finishAckReceived === true &&
          result.transfer.payloadBytesSent === targetBytes &&
          result?.acceptedFirmwareBytes === targetBytes &&
          result?.caseRestoreVerified === true &&
          result?.caseApplicationVersion === "1.2.57" &&
          result?.retainedResult?.acceptedSize === targetBytes &&
          result?.retainedResult?.baselineMask === 0x3ff &&
          result?.retainedResult?.selectedMask === 0x3ff &&
          result?.retainedResult?.restoredMask === 0x3ff &&
          result?.retainedResult?.templeUartErrors === 0,
      ),
  );
  if (!safeCompletedTransfers) return null;

  const observedVersions = Object.fromEntries(
    ROUTES.map((route) => [
      route,
      audit.finalResetAndLiveness.versions[route].firmware,
    ]),
  );
  return {
    kind: "differential-to-complete",
    trigger:
      failedPostflightRoutes.length > 0
        ? "postflight-boot-liveness-failure"
        : "final-boot-liveness-failure",
    observedVersion: null,
    observedVersions,
    failedRoutes: bootFailureRoutes,
    reason:
      `The differential target was accepted, but ${bootFailureRoutes.join(" + ")} did not return the expected target version during boot/liveness verification.`,
  };
}

export function canFallbackDifferentialToComplete(error, plan) {
  return Boolean(differentialFallbackDetails(error, plan));
}

export function resolveAutomaticApplyPlan({
  installMode = DEFAULT_AUTOMATIC_INSTALL_MODE,
  targetFirmware,
  installedProvenance,
  differenceSourceFirmware,
  differencePlan,
  observedTempleVersions,
}) {
  if (!AUTOMATIC_INSTALL_MODES.includes(installMode)) {
    return {
      executable: false,
      reason: `Unknown install mode: ${installMode}.`,
    };
  }
  if (targetFirmware?.firmwareRevocation) {
    return {
      executable: false,
      reason: `G2 firmware ${targetFirmware.firmwareRevocation.version} is revoked from recovery: ${targetFirmware.firmwareRevocation.reason}.`,
    };
  }
  if (!targetFirmware?.templeFlashEligible) {
    return {
      executable: false,
      reason:
        "Choose an exact, hash-pinned Stock or reviewed CFW Smart Glasses bundle.",
    };
  }

  const targetSha256 = targetFirmware.fileSha256?.toLowerCase();
  const targetVersion = targetFirmwareVersion(targetFirmware);
  const observedIdentities = Object.fromEntries(
    ROUTES.map((route) => [
      route,
      observedTempleIdentity(observedTempleVersions, route),
    ]),
  );
  if (installMode === "restore") {
    return {
      executable: true,
      action: "flash",
      route: "both",
      flashMode: "complete",
      targetSha256,
      reason: "Rewrite the complete pinned Apollo main on both temples.",
    };
  }

  const liveTargetRoutes = targetVersion
    ? ROUTES.filter(
        (route) =>
          observedIdentities[route].firmwareVersion === targetVersion &&
          observedIdentities[route].hardwareRevision === 5,
      )
    : [];
  const auditedTargetRoutes = ROUTES.filter((route) => {
    const observed = observedIdentities[route];
    return Boolean(
      installedProvenance?.[route]?.imageSha256?.toLowerCase() ===
        targetSha256 &&
        !(
          targetVersion &&
          observed.firmwareVersion &&
          observed.firmwareVersion !== targetVersion
        ) &&
        !(observed.hardwareRevision != null && observed.hardwareRevision !== 5),
    );
  });
  const targetProvenRoutes = ROUTES.filter(
    (route) =>
      liveTargetRoutes.includes(route) || auditedTargetRoutes.includes(route),
  );
  const savedTargetAuditRoutes = ROUTES.filter(
    (route) =>
      installedProvenance?.[route]?.imageSha256?.toLowerCase() === targetSha256,
  );
  if (targetProvenRoutes.length === ROUTES.length) {
    return {
      executable: true,
      action: "verify-only",
      route: "both",
      flashMode: null,
      targetSha256,
      reason:
        liveTargetRoutes.length === ROUTES.length
          ? `Fresh checksum-valid replies show both temples already running ${targetVersion}/hardware 5. Update mode will send no firmware bytes; use Restore only to force an exact pinned-image reinstall.`
          : "Both temples already have a verified audit for the selected target; reset and liveness verification are sufficient.",
    };
  }
  if (
    savedTargetAuditRoutes.length === ROUTES.length &&
    targetProvenRoutes.length === 0
  ) {
    return completeAutomaticUpdatePlan(
      targetSha256,
      `Fresh Smart Glasses identity contradicts the saved target audit${targetVersion ? ` for ${targetVersion}` : ""}; write the complete pinned target Apollo main on both temples.`,
    );
  }
  // A fresh checksum-valid target version is sufficient to skip mutation in
  // Update mode. It is not claimed as an exact image hash; Restore remains the
  // explicit path for an operator who wants byte-for-byte reinstallation.
  const routesToUpdate = ROUTES.filter(
    (route) => !targetProvenRoutes.includes(route),
  );
  const routeSelection =
    routesToUpdate.length === ROUTES.length ? "both" : routesToUpdate[0];
  const routeDescription =
    routeSelection === "both" ? "both temples" : `the ${routeSelection} temple only`;
  const preservedRoutePrefix =
    targetProvenRoutes.length === 1
      ? auditedTargetRoutes.includes(targetProvenRoutes[0])
        ? `The ${targetProvenRoutes[0]} temple already holds a verified install of the selected target; `
        : `The ${targetProvenRoutes[0]} temple already returns the selected target version in a fresh hardware-5 Application reply; `
      : "";

  const sourceSha256 = differenceSourceFirmware?.fileSha256?.toLowerCase();
  if (
    !differencePlan?.executable ||
    !sourceSha256 ||
    differencePlan.source?.imageSha256?.toLowerCase() !== sourceSha256 ||
    differencePlan.target?.imageSha256?.toLowerCase() !== targetSha256
  ) {
    return completeAutomaticUpdatePlan(
      targetSha256,
      `${preservedRoutePrefix}the installed firmware on ${routeDescription} is not the exact reviewed differential source; write the complete pinned target Apollo main on ${routeDescription}.`,
      routeSelection,
    );
  }
  const sourceVersion = differencePlan.source?.version;
  const observedSourceCompatible = routesToUpdate.every(
    (route) =>
      observedIdentities[route].firmwareVersion === sourceVersion &&
      observedIdentities[route].hardwareRevision === 5,
  );
  const observedSourceContradiction = routesToUpdate.some((route) => {
    const observed = observedIdentities[route];
    return Boolean(
      (observed.firmwareVersion &&
        observed.firmwareVersion !== sourceVersion) ||
        (observed.hardwareRevision != null &&
          observed.hardwareRevision !== 5),
    );
  });
  if (
    !knownRouteProofsBelongToPair(
      installedProvenance,
      sourceSha256,
      targetSha256,
    )
  ) {
    return completeAutomaticUpdatePlan(
      targetSha256,
      `${preservedRoutePrefix}saved proof identifies firmware outside the exact reviewed Stock ↔ CFW pair; write the complete pinned target Apollo main on ${routeDescription}.`,
      routeSelection,
    );
  }

  const exactSourceProven = routesToUpdate.every(
    (route) =>
      installedProvenance?.[route]?.imageSha256?.toLowerCase() === sourceSha256,
  );
  if (
    observedSourceContradiction ||
    !supportsLiveCompatiblePairProof(differencePlan) ||
    (!exactSourceProven && !observedSourceCompatible)
  ) {
    const observed = routesToUpdate
      .map((route) => observedIdentities[route].firmwareVersion)
      .filter(Boolean);
    return completeAutomaticUpdatePlan(
      targetSha256,
      observedSourceContradiction
        ? `${preservedRoutePrefix}observed Smart Glasses firmware ${[...new Set(observed)].join(" / ")} on ${routeDescription} is outside the exact ${sourceVersion} differential source; write the complete pinned target Apollo main on ${routeDescription}.`
        : `${preservedRoutePrefix}no exact Stock ↔ CFW source proof is available for ${routeDescription}; write the complete pinned target Apollo main on ${routeDescription}.`,
      routeSelection,
    );
  }

  return {
    executable: true,
    action: "flash",
    route: routeSelection,
    flashMode: "differences",
    sourceProofMode: exactSourceProven
      ? "verified-source-audits"
      : "live-compatible-pair-preflight",
    sourceVersion,
    sourceSha256,
    targetSha256,
    reason: exactSourceProven
      ? `Saved audits prove the exact source on ${routeDescription}. Skip byte-identical bundle components and transfer the changed, CRC-gated Apollo main to ${routeDescription}.`
      : `Fresh analysis reports the exact reviewed source on ${routeDescription}. Each selected temple must still return a just-in-time checksum-valid ${differencePlan.source.version}/hardware-5 reply before START.`,
  };
}

export function summarizeAutomaticApplyTransfer({
  plan,
  targetFirmware,
  differencePlan = null,
  comparisonSourceFirmwareByRoute = {},
} = {}) {
  if (!plan?.executable) {
    return {
      executable: false,
      reason: plan?.reason ?? "No executable USB update plan is available.",
    };
  }
  const routes =
    plan.action !== "flash"
      ? []
      : plan.route === "both"
        ? [...ROUTES]
        : plan.route
          ? [plan.route]
          : [];
  const payloadBytesPerRoute = targetFirmware?.mainComponent?.payload?.length ?? 0;
  const firmwareBytes =
    plan.action === "flash" ? payloadBytesPerRoute * routes.length : 0;
  const semanticDifferencesByRoute = Object.fromEntries(
    routes.map((route) => {
      const source = comparisonSourceFirmwareByRoute?.[route];
      const comparison = source?.mainComponent?.payload
        ? describeByteDifferences(
            source.mainComponent.payload,
            targetFirmware?.mainComponent?.payload,
          )
        : plan.flashMode === "differences"
          ? differencePlan?.mainDifferences ?? null
          : null;
      return [route, comparison];
    }),
  );
  const comparableDifferences = Object.values(semanticDifferencesByRoute).filter(
    Boolean,
  );
  const semanticChangedBytes =
    comparableDifferences.length === routes.length
      ? comparableDifferences.reduce(
          (total, comparison) => total + comparison.changedBytes,
          0,
        )
      : null;
  return {
    executable: true,
    action: plan.action,
    flashMode: plan.flashMode,
    routes,
    payloadBytesPerRoute,
    firmwareBytes,
    semanticChangedBytes,
    semanticDifferencesByRoute,
    sparseByteRangesSupported: false,
    skippedRoutes: ROUTES.filter((route) => !routes.includes(route)),
    verificationRoutes: [...ROUTES],
    reason: plan.reason,
    protocolBoundary:
      plan.action === "flash"
        ? "The running-temple 0x54 DATA command is sequential and has no destination-offset field. The receiver requires the complete changed component plus its declared size and CRC before FINISH."
        : "No firmware component transfer is planned.",
  };
}

export async function executeAutomaticApply({
  session,
  installMode,
  targetFirmware,
  installedProvenance,
  differenceSourceFirmware,
  differencePlan,
  initialTempleVersions,
  observedTempleVersions,
  verifiedTempleReadiness,
  onPlan,
  onRecovery,
}) {
  if (!session) throw new Error("An analyzed G2 Case session is required.");
  const plan = resolveAutomaticApplyPlan({
    installMode,
    targetFirmware,
    installedProvenance,
    differenceSourceFirmware,
    differencePlan,
    observedTempleVersions,
  });
  if (!plan.executable) throw new Error(plan.reason);
  await onPlan?.(plan);

  if (plan.action === "verify-only") {
    const expectedVersion = targetFirmwareVersion(targetFirmware);
    return {
      plan,
      action: "verify-only",
      result: isReusableTempleReadiness(
        verifiedTempleReadiness,
        expectedVersion,
      )
        ? verifiedTempleReadiness
        : await session.restartAndVerifyBothTemples({
            expectedVersion,
            purpose: "Already-target verification",
          }),
    };
  }

  const automaticPreflight = initialTempleVersions
    ? {
        initialVersions: initialTempleVersions,
        postResetVersions: observedTempleVersions ?? null,
        cleanStartResetVerified:
          verifiedTempleReadiness?.applicationLivenessVerified === true &&
          verifiedTempleReadiness?.firmwareBytesTransmitted === 0,
        resetAttempts:
          verifiedTempleReadiness?.resetAttempts ?? [],
      }
    : null;
  try {
    const audit = await session.flashPinnedTempleMain(
      targetFirmware,
      plan.route,
      plan.flashMode === "differences"
        ? {
            mode: plan.flashMode,
            differenceSourceFirmware,
            sourceProofMode: plan.sourceProofMode,
          }
        : {
            mode: plan.flashMode,
            differenceSourceFirmware: null,
          },
    );
    if (automaticPreflight) {
      audit.automaticPreflight = automaticPreflight;
    }
    return {
      plan,
      action: "flash",
      audit,
    };
  } catch (error) {
    if (automaticPreflight && error?.audit) {
      error.audit.automaticPreflight = automaticPreflight;
    }
    const recovery = differentialFallbackDetails(error, plan);
    if (!recovery) throw error;
    const fallbackPlan = completeAutomaticUpdatePlan(
      plan.targetSha256,
      `${recovery.reason} Reset both temples from a clean Case state, then retry with the complete pinned target Apollo main.`,
    );
    await onRecovery?.({
      ...recovery,
      priorPlan: plan,
      fallbackPlan,
      priorAudit: error.audit,
    });
    let recoveryReset;
    try {
      recoveryReset = await session.restartAndVerifyBothTemples({
        purpose: "Differential-to-complete recovery reset",
      });
    } catch (resetError) {
      const blocked = new Error(
        `The differential happy path did not pass, and the clean recovery reset did not prove both temple applications are reachable. The complete-image fallback was not started: ${resetError.message}`,
        { cause: resetError },
      );
      blocked.audit = error.audit;
      blocked.automaticFallback = {
        ...recovery,
        outcome: "blocked-before-complete",
        resetError: resetError.message,
      };
      throw blocked;
    }

    let audit;
    try {
      audit = await session.flashPinnedTempleMain(
        targetFirmware,
        fallbackPlan.route,
        { mode: "complete", differenceSourceFirmware: null },
      );
    } catch (fallbackError) {
      if (fallbackError?.audit) {
        fallbackError.audit.automaticFallback = {
          ...recovery,
          outcome: "complete-failed-or-uncertain",
          recoveryReset,
          priorAudit: error.audit,
        };
      }
      throw fallbackError;
    }
    audit.automaticFallback = {
      ...recovery,
      outcome: "complete-success",
      recoveryReset,
      priorAudit: error.audit,
    };
    return {
      plan: fallbackPlan,
      initialPlan: plan,
      action: "flash",
      audit,
      recovery,
    };
  }
}

export function installedProvenanceStorageKey(
  caseSerial,
  factoryIdentifier = null,
) {
  const serial = String(caseSerial ?? "").trim();
  if (serial) return `evenrealities-webflasher:g2-installed-provenance:${serial}`;
  const identifier = String(factoryIdentifier ?? "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();
  const usableIdentifier =
    identifier && !/^(?:00){8}$|^(?:FF){8}$/.test(identifier);
  return usableIdentifier
    ? `evenrealities-webflasher:g2-installed-provenance:factory-${identifier}`
    : null;
}

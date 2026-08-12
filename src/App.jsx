import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  POGO_TRANSFER_RESEARCH,
  formatBytes,
  hex,
  hexBytes,
  parseFirmwareInput,
} from "./lib/firmware.js";
import {
  G2CaseSession,
  g2CaseTransportLabel,
  isG2CaseUsbConnectionEvent,
  isG2CaseSerialPort,
  portUsesUsbDevice,
  requestG2CasePort,
  webSerialSupported,
  webUsbSupported,
} from "./lib/serial.js";
import {
  buildG2SystemBackupArtifact,
  findMatchingGlassesRecoveryRelease,
  validateGlassesRecoveryBundle,
} from "./lib/backup.js";
import { buildG2DeviceAnalytics } from "./lib/analytics.js";
import {
  consoleTranscriptStorageKey,
  formatBluetoothRecoveryTranscript,
  formatConsoleTranscriptDownload,
  formatShellEvidenceTranscript,
  pruneConsoleTranscripts,
  readConsoleTranscript,
  resolveConsoleTranscriptTabId,
  writeConsoleTranscript,
} from "./lib/consoleTranscript.js";
import {
  buildDeviceFingerprint,
  caseDeviceKey,
  usbBridgeRevisionOf,
} from "./lib/deviceIdentity.js";
import {
  detectTempleFirmwareRegression,
  readDeviceHistory,
  readDeviceLabel,
  recordDeviceOperation,
  summarizeDeviceHistory,
  writeDeviceLabel,
} from "./lib/deviceHistory.js";
import { decodeApollo510RecoveryConfig } from "./lib/recoveryConfig.js";
import { TEMPLE_FLASH_TARGETS } from "./lib/templeFlashTargets.js";
import {
  assertFirmwareCatalogCoversPinnedImages,
  findUnservedPinnedImages,
} from "./lib/catalogCoverage.js";
import {
  OPERATION_TOTALS,
  operationProgress,
} from "./lib/operationProgress.js";
import {
  DEFAULT_TEMPLE_FLASH_ROUTE,
  findDefaultFirmwareRelease,
  findLatestCaseFirmwareRelease,
  findLatestOfficialStockRelease,
  firmwareReleaseDisplayName,
} from "./lib/recoveryDefaults.js";
import {
  DEFAULT_AUTOMATIC_CASE_UPDATE,
  DEFAULT_AUTOMATIC_INSTALL_MODE,
  DEFAULT_INTERFACE_MODE,
  assessAutomaticTempleContacts,
  describeAutomaticApplyFailure,
  diagnoseAndRecoverAutomaticUsb,
  executeAutomaticCaseUpdate,
  executeAutomaticApply,
  installedProvenanceStorageKey,
  mergeInstalledProvenance,
  prepareAutomaticTempleUpdate,
  resolveAutomaticCaseUpdatePlan,
  resolveAutomaticApplyPlan,
  summarizeAutomaticApplyTransfer,
  templeVersionObservationsFromFlashAudit,
  verifyAutomaticCaseReadiness,
} from "./lib/automaticRecovery.js";
import { REVIEWED_CASE_VERSION } from "./lib/pogoFlashBridge.js";
import {
  WEBFLASHER_BUILD_LABEL,
  WEBFLASHER_FIRMWARE_CATALOG_URL,
  assertStableMutationRuntime,
  assertCurrentWebFlasherRelease,
  webflasherAssetUrl,
} from "./lib/releaseIntegrity.js";
import {
  IDLE_WAKE_LOCK_STATUS,
  MutationWakeLock,
} from "./lib/wakeLock.js";
import {
  G2BleOtaSession,
  assertPinnedG2BleBundle,
  flashG2BleSessionsConcurrently,
  g2BleDeviceSide,
  g2BleRoutesAwaitingCaseVerification,
  g2BleSupported,
  G2_KNOWN_NAME_TOKENS,
  g2BleTargetReportedVersion,
  g2BleTargetVersionProof,
  g2NameToken,
  probeAuthorizedG2BleDevices,
  requestG2BleDevice,
} from "./lib/g2BleOta.js";
import {
  assertPinnedR1Release,
  enterR1DfuMode,
  flashR1SecureDfu,
  prepareR1DfuPackage,
  requestR1ApplicationDevice,
  requestR1DfuDevice,
} from "./lib/r1Dfu.js";

const EMPTY_PROGRESS = {
  fraction: 0,
  detail: "Ready",
  visible: false,
  name: null,
  total: 1,
  completed: 0,
  current: 1,
  percent: 0,
};

// Name tokens observed on real hardware, merged with the built-in list. A G2
// advertising a token nobody has recorded cannot be reached by a side-specific
// name prefix, so remembering each one seen keeps the filter working for that
// operator's own devices from the second session onward.
const OBSERVED_NAME_TOKENS_KEY = "webflasher.g2NameTokens";
// The exact advertised name last seen for each side, which pins that side's
// chooser to one device. Per-side and never derived from the other arm: the
// trailing hex is the arm's own address tail, so one says nothing about the other.
const REMEMBERED_TEMPLE_NAMES_KEY = "webflasher.g2TempleNames";

function readJsonSetting(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonSetting(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Remembering is a convenience; failing to remember changes nothing.
  }
}

function readObservedNameTokens() {
  const stored = readJsonSetting(OBSERVED_NAME_TOKENS_KEY, []);
  return [
    ...new Set([
      ...G2_KNOWN_NAME_TOKENS,
      ...(Array.isArray(stored) ? stored.filter((t) => typeof t === "string") : []),
    ]),
  ];
}

function rememberNameToken(name) {
  const token = g2NameToken(name);
  if (!token || G2_KNOWN_NAME_TOKENS.includes(token)) return;
  const stored = readJsonSetting(OBSERVED_NAME_TOKENS_KEY, []);
  const next = [...new Set([...(Array.isArray(stored) ? stored : []), token])];
  writeJsonSetting(OBSERVED_NAME_TOKENS_KEY, next);
}

function readRememberedTempleNames() {
  const stored = readJsonSetting(REMEMBERED_TEMPLE_NAMES_KEY, {});
  return {
    left: typeof stored?.left === "string" ? stored.left : null,
    right: typeof stored?.right === "string" ? stored.right : null,
  };
}

function rememberTempleName(side, name) {
  if (!name) return;
  writeJsonSetting(REMEMBERED_TEMPLE_NAMES_KEY, {
    ...readRememberedTempleNames(),
    [side]: name,
  });
}

const EMPTY_BLE_ROUTE_PROGRESS = Object.freeze({
  left: Object.freeze({
    fraction: 0,
    percent: 0,
    status: "preparing",
    detail: "Waiting for the pinned package gate",
  }),
  right: Object.freeze({
    fraction: 0,
    percent: 0,
    status: "preparing",
    detail: "Waiting for the pinned package gate",
  }),
});

const OPERATION_LABELS = Object.freeze({
  analyze: "Analyze Case",
  backup: "Preserve recovery backup",
  firmware: "Validate firmware",
  "glasses-analyze": "Analyze Smart Glasses",
  pogo: "Query temple",
  recheck: "Reset and recheck",
  "temple-flash": "Restore Smart Glasses",
  "ble-temple-flash": "Restore Smart Glasses over Bluetooth",
  "bluetooth-probe": "Check Bluetooth Application mode",
  "automatic-apply": "Recover Smart Glasses over USB",
  "automatic-plan": "Preview Smart Glasses USB transfer",
  "automatic-recovery": "Diagnose and recover without flashing",
  "ring-dfu-enter": "Restart R1 in update mode",
  "ring-dfu": "Update R1 Ring",
  stage: "Stage Case bank",
  activate: "Activate Case bank",
});

const PERSISTENT_MUTATION_OPERATIONS = new Set([
  "automatic-apply",
  "automatic-recovery",
  "ble-temple-flash",
  "temple-flash",
  "stage",
  "activate",
  "ring-dfu-enter",
  "ring-dfu",
]);
const FIRMWARE_CATALOG_MUTATION_OPERATIONS = new Set([
  "automatic-apply",
  "ble-temple-flash",
  "temple-flash",
]);

function cx(...values) {
  return values.filter(Boolean).join(" ");
}

async function fetchCatalogRelease(release, label = "Firmware archive") {
  const urls = [
    ...new Set(
      [release?.url, release?.sourceUrl]
        .filter(Boolean)
        .map((url) => webflasherAssetUrl(url)),
    ),
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response;
      lastError = new Error(`${url} returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `${label} could not be downloaded${lastError?.message ? `: ${lastError.message}` : "."}`,
  );
}

function Icon({ name }) {
  if (name === "tools") {
    return (
      <span className="icon icon-tools" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M8.7 8.7a4 4 0 0 1-5.5-5.5l2.4 2.4 2-2-2.4-2.4a4 4 0 0 1 5.5 5.5L19 15a2.5 2.5 0 1 1-4 4l-8.3-8.3" />
          <path d="m4 20 3.2-.8L18.4 8l-2.4-2.4L4.8 16.8 4 20Z" />
          <path d="m16 5.6 1.2-1.2 2.4 2.4L18.4 8" />
        </svg>
      </span>
    );
  }

  const glyphs = {
    usb: "⌁",
    scan: "◎",
    backup: "↓",
    firmware: "◇",
    recover: "↻",
    terminal: ">_",
    check: "✓",
    warning: "!",
    case: "▱",
    glasses: "⌐",
    bank: "▥",
    file: "▤",
  };
  return (
    <span className={cx("icon", `icon-${name}`)} aria-hidden="true">
      {glyphs[name] ?? "•"}
    </span>
  );
}

function EvenRealitiesLogo() {
  return (
    <span className="even-realities-logo">
      <svg viewBox="0 0 18 15" aria-hidden="true" focusable="false">
        <path d="M6.1 0H17.3V2.8H6.1V0Z" fill="currentColor" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M3.3 0H.5v14h2.8v-2.8h2.8V14h11.2v-2.8H6.1V8.4h11.2V5.6H6.1V2.8H3.3V0Zm0 8.4h2.8V5.6H3.3v2.8Z"
          fill="currentColor"
        />
      </svg>
      <span>Even Realities</span>
    </span>
  );
}

function Button({
  children,
  tone = "primary",
  busy = false,
  className,
  ...props
}) {
  return (
    <button
      className={cx("button", `button-${tone}`, className)}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

function Field({ label, value, detail, status }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-value">
        {status ? <span className={cx("tiny-dot", `tiny-dot-${status}`)} /> : null}
        {value ?? "—"}
      </div>
      {detail ? <div className="field-detail">{detail}</div> : null}
    </div>
  );
}

export const WORKFLOW_STEPS = [
  ["connect", "Connect", "USB Serial"],
  ["analyze", "Analyze", "Status + banks"],
  ["backup", "Preserve", "Case + Glasses backup"],
  ["firmware", "Choose image", "CDN or local file"],
];
export const RECOVERY_STEPS = [
  ["recover", "Recovery Console", "Stage, flash, verify"],
];
export const SECTION_KEYS = [...WORKFLOW_STEPS, ...RECOVERY_STEPS].map(
  ([key]) => key,
);

function StepRail({ complete, active }) {
  const renderGroup = (steps, offset) =>
    steps.map(([key, title, detail], index) => (
      <a
        href={`#${key}`}
        className={cx(
          "step-link",
          complete[key] && "is-complete",
          active === key && "is-current",
        )}
        aria-current={active === key ? "page" : undefined}
        onClick={() => {
          // Clicking the current entry leaves the hash unchanged, so no
          // hashchange fires — return to the top of the pane here.
          if (active === key) {
            document
              .querySelector(".pane-viewport")
              ?.scrollTo({ top: 0, behavior: "instant" });
          }
        }}
        key={key}
      >
        <span className="step-number">
          {complete[key] ? (
            <Icon name="check" />
          ) : key === "recover" ? (
            <Icon name="tools" />
          ) : (
            String(index + offset + 1).padStart(2, "0")
          )}
        </span>
        <span>
          <strong>{title}</strong>
          <small>{detail}</small>
        </span>
      </a>
    ));
  return (
    <div className="step-rails">
      <nav className="step-rail" aria-label="Setup workflow">
        {renderGroup(WORKFLOW_STEPS, 0)}
      </nav>
      <nav className="step-rail step-rail-recovery" aria-label="Recovery">
        {renderGroup(RECOVERY_STEPS, WORKFLOW_STEPS.length)}
      </nav>
    </div>
  );
}

function SectionHeading({ eyebrow, title, copy, action }) {
  return (
    <div className="section-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
        {copy ? <p>{copy}</p> : null}
      </div>
      {action}
    </div>
  );
}

function StatusPill({ children, tone = "neutral" }) {
  return <span className={cx("status-pill", `status-pill-${tone}`)}>{children}</span>;
}

function InstallModeSelector({ value, onChange, disabled = false, idPrefix }) {
  return (
    <fieldset className="install-mode-selector">
      <legend>Install method</legend>
      <div className="install-mode-options">
        {[
          [
            "update",
            "Update",
            "Use the complete pinned official main for version changes.",
          ],
          [
            "restore",
            "Restore",
            "Rewrite the complete pinned main firmware on both sides.",
          ],
        ].map(([mode, label, detail]) => (
          <label
            className={cx(value === mode && "is-selected")}
            htmlFor={`${idPrefix}-${mode}`}
            key={mode}
          >
            <input
              id={`${idPrefix}-${mode}`}
              type="radio"
              name={`${idPrefix}-install-mode`}
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
              disabled={disabled}
            />
            <span>
              <strong>{label}</strong>
              <small>{detail}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AutomaticCaseUpdateOption({
  checked,
  onChange,
  disabled = false,
  currentVersion,
  targetVersion,
  idPrefix,
}) {
  const detail =
    currentVersion && targetVersion
      ? currentVersion === targetVersion
        ? `Case ${currentVersion} is already current; no Case write will occur.`
        : `Current Case ${currentVersion} · latest verified Case ${targetVersion}.`
      : targetVersion
        ? `If needed, install verified Case ${targetVersion} before flashing the glasses.`
        : "The latest verified official Case image will be selected from the library.";
  return (
    <label
      className={cx("automatic-case-update", checked && "is-selected")}
      htmlFor={`${idPrefix}-case-update`}
    >
      <input
        id={`${idPrefix}-case-update`}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span>
        <strong>Update Charging Case first</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function TempleProbeResult({ side, results }) {
  const status = results?.status;
  const version = results?.version;
  return (
    <div className={cx("pogo-result", (status || version) && "has-result")}>
      <div className="pogo-result-heading">
        <span>{side} temple</span>
        <strong>
          {version
            ? `G2 ${version.decoded.firmwareVersion}`
            : "Version not queried"}
        </strong>
      </div>
      <div className="pogo-result-facts">
        <span>
          HW revision <strong>{version?.decoded.hardwareRevision ?? "—"}</strong>
        </span>
        <span>
          Battery <strong>{status ? `${status.decoded.batteryPercent}%` : "—"}</strong>
        </span>
        <span>
          Voltage <strong>{status ? `${status.decoded.voltageMv} mV` : "—"}</strong>
        </span>
      </div>
      {status || version ? (
        <code>
          {hexBytes((status ?? version).captured)}
        </code>
      ) : (
        <small>No SRAM bridge transaction has been run this session.</small>
      )}
    </div>
  );
}

function RecoveryConfigResult({ report }) {
  if (!report) return null;
  const uart = report.info0?.uart;
  const decision = report.decision;
  return (
    <div className="sbl-result">
      <div className="sbl-facts">
        <div>
          <span>WIRED_CONFIG</span>
          <strong>
            {report.wiredConfiguration
              ? `${report.wiredConfiguration.raw} · UART${report.wiredConfiguration.uartModule}`
              : "INFOC required"}
          </strong>
        </div>
        <div>
          <span>ACTIVE INFO0</span>
          <strong>
            {report.info0Selector
              ? `${report.info0Selector.selectedSpace} · ${report.info0Selector.raw}`
              : "INFOC required"}
          </strong>
        </div>
        <div>
          <span>SBL UART</span>
          <strong>
            {uart
              ? `${uart.baud.toLocaleString()} baud · ${uart.dataBits}${uart.parity === "none" ? "N" : uart.parity[0].toUpperCase()}${uart.stopBits}`
              : "INFO0 required"}
          </strong>
        </div>
        <div>
          <span>CONTACT PINS</span>
          <strong>{uart ? `GPIO${uart.rxPin}/RX · GPIO${uart.txPin}/TX` : "INFO0 required"}</strong>
        </div>
        <div>
          <span>POGO FIELD MATCH</span>
          <strong>
            {report.pogoMatch
              ? report.pogoMatch.allKnownFieldsMatch
                ? "All known fields match"
                : "Does not match the app pogo route"
              : "Both dumps required"}
          </strong>
        </div>
        <div>
          <span>RECEIVE WINDOW</span>
          <strong>
            {report.info0 ? `${report.info0.wiredTimeoutMs} ms` : "INFO0 required"}
          </strong>
        </div>
        <div>
          <span>SBL RESTORE CANDIDATE</span>
          <strong className={decision?.sblUartRestoreCandidate ? "is-positive" : ""}>
            {decision?.sblUartRestoreCandidate ? "Provisioning matches" : "Not proven"}
          </strong>
        </div>
        <div>
          <span>MRAM WIRED RECOVERY</span>
          <strong className={decision?.mramWiredRecoveryCandidate ? "is-positive" : ""}>
            {decision?.mramWiredRecoveryCandidate ? "Provisioning matches" : "Not proven"}
          </strong>
        </div>
      </div>
      <small>
        GPIO override on a known contact:{" "}
        {decision?.forcedEntryContactCandidate ? "candidate" : "not proven"}.
        {" "}Restore evidence only; Ambiq's documented UART host does not provide
        installed-MRAM backup or readback.
      </small>
    </div>
  );
}

function SmartGlassesAnalyticsCard({ analytics, label, probeFailure = null }) {
  const proof =
    analytics.version?.transportProof ?? analytics.status?.transportProof;
  const applicationBatteryAvailable = analytics.batteryPercent != null;
  const applicationVoltageAvailable = analytics.voltageMv != null;
  const displayedBattery = applicationBatteryAvailable
    ? `${analytics.batteryPercent}%`
    : analytics.caseReportedCharging?.batteryPercent == null
      ? null
      : `Case ${analytics.caseReportedCharging.batteryPercent}%`;
  const displayedVoltage = applicationVoltageAvailable
    ? `${analytics.voltageMv} mV`
    : analytics.caseReportedCharging?.voltageMv == null
      ? null
      : `Case ${analytics.caseReportedCharging.voltageMv} mV`;
  return (
    <article className={cx(
      "glasses-analytics-card",
      analytics.applicationResponsive && "is-responsive",
    )}>
      <div className="glasses-analytics-heading">
        <div>
          <span>{label} temple</span>
          <h3>
            {analytics.firmwareVersion
              ? `G2 ${analytics.firmwareVersion}`
              : analytics.present
                ? "Seated · not yet queried"
                : "Not detected"}
          </h3>
        </div>
        <StatusPill
          tone={
            analytics.applicationResponsive
              ? probeFailure
                ? "warm"
                : "success"
              : analytics.present
                ? "warm"
                : "quiet"
          }
        >
          {analytics.applicationResponsive
            ? probeFailure
              ? "Stale · last probe failed"
              : "Application responsive"
            : analytics.present
              ? "Presence only"
              : "Absent"}
        </StatusPill>
      </div>
      {probeFailure ? (
        <small className="glasses-analytics-stale-note">
          Shown values predate a failed probe
          {probeFailure.at ? ` (${probeFailure.at})` : ""}:{" "}
          {probeFailure.message}
        </small>
      ) : null}
      <div className="glasses-analytics-facts">
        <Field
          label="Firmware"
          value={analytics.firmwareVersion}
          detail="Checksum-validated 0x23 version reply"
        />
        <Field
          label="Hardware"
          value={analytics.hardwareRevision}
          detail="Apollo hardware revision"
        />
        <Field
          label="Battery"
          value={displayedBattery}
          detail={
            applicationBatteryAvailable
              ? "0x2C running-app status reply"
              : "Informational Charging Case console estimate; run Glasses analysis for application status"
          }
        />
        <Field
          label="Voltage"
          value={displayedVoltage}
          detail={
            applicationVoltageAvailable
              ? "0x2C running-app status reply"
              : "Informational Charging Case console estimate; run Glasses analysis for application status"
          }
        />
      </div>
      <div className="glasses-route-proof">
        <span>CASE → POGO ROUTE PROOF</span>
        <code>
          {proof
            ? `${proof.baselineMask} → ${proof.selectedMask} → ${proof.restoredMask}`
            : "Run the full Glasses analysis to capture transport proof"}
        </code>
        {proof ? (
          <small>
            {proof.transmittedBytes} bytes sent · {proof.capturedBytes} captured ·
            UART errors {proof.uartErrorMask}
          </small>
        ) : null}
      </div>
      <div className={cx(
        "writer-compatibility",
        analytics.completeMainWriterCompatible && "is-compatible",
      )}>
        <Icon
          name={
            analytics.completeMainWriterCompatible ? "check" : "warning"
          }
        />
        <span>
          {analytics.completeMainWriterCompatible
            ? "Running hardware-5 application supports complete pinned-main recovery"
            : "Recovery compatibility has not been proven for this temple"}
        </span>
      </div>
    </article>
  );
}

function ShellEvidenceView({ analytics, onDownload }) {
  const caseShell = analytics.chargingCase.shell;
  const glasses = analytics.smartGlasses;
  const evidence = analytics.validatedRecoveryEvidence;
  return (
    <div className="shell-analysis">
      <div className="shell-analysis-heading">
        <div>
          <div className="eyebrow">Local evidence export</div>
          <h3>Case shell, Glasses frames, and recovery provenance</h3>
          <p>
            Factory-console output belongs to the Charging Case. Temple frames and
            YHM masks belong to the selected Glasses route and were transported
            through the Case’s volatile SRAM bridge.
          </p>
        </div>
        <Button tone="secondary" onClick={onDownload}>
          <Icon name="backup" />
          Download analytics JSON
        </Button>
      </div>
      <div className="shell-analysis-grid">
        <article className="shell-panel">
          <div className="scope-label">CHARGING CASE · FACTORY SHELL</div>
          <div className="shell-command-list">
            {caseShell.allowlistedQueries.map((query) => (
              <div key={query.command}>
                <code>{query.command}</code>
                <span>{query.data}</span>
                <small>{query.scope}</small>
              </div>
            ))}
          </div>
          <details open>
            <summary>Raw Case console output</summary>
            <pre>{caseShell.rawOutput || "No console output captured."}</pre>
          </details>
        </article>
        <article className="shell-panel">
          <div className="scope-label">SMART GLASSES · CASE-TO-POGO FRAMES</div>
          {["left", "right"].map((side) => {
            const temple = glasses[side];
            return (
              <div className="shell-temple" key={side}>
                <strong>{side.toUpperCase()} TEMPLE</strong>
                <span>
                  {temple.applicationResponsive
                    ? `${temple.firmwareVersion} · HW ${temple.hardwareRevision}`
                    : temple.present
                      ? "Seated; no application reply captured"
                      : "Not detected by Case telemetry"}
                </span>
                {["version", "status"].map((kind) => (
                  <code key={kind}>
                    {kind.toUpperCase()} ·
                    {" "}{temple[kind]?.capturedFrameHex ?? "not captured"}
                  </code>
                ))}
              </div>
            );
          })}
          <div className="shell-recovery-proof">
            <span>VALIDATED RECOVERY RECORD</span>
            <strong>
              {evidence.status} · {evidence.attempts} hardware attempts
            </strong>
            <small>
              {Object.values(evidence.successfulTransfers)
                .map((item) =>
                  `${item.route}: ${item.payloadBytes.toLocaleString()} B / ${item.recordsSent.toLocaleString()} records`,
                )
                .join(" · ")}
            </small>
          </div>
        </article>
      </div>
    </div>
  );
}

function BluetoothRecoveryCard({
  variant = "easy",
  directBleSupported,
  operation,
  bleDevices,
  onSelectTemple,
  bleReady,
  onReadyChange,
  bleFlashReady,
  onFlash,
  selectedRelease,
  bleResults,
  bleStatus,
}) {
  const advanced = variant === "advanced";
  const primary = variant === "primary";
  return (
    <article
      className={cx(
        "ble-recovery-card",
        primary && "is-primary",
        advanced && "is-advanced",
      )}
      id={advanced ? "advanced-bluetooth-recovery" : "bluetooth-recovery"}
    >
      <div className="ble-recovery-copy">
        <div className="eyebrow">
          {advanced
            ? "Primary Smart Glasses update"
            : "02 · Pair + update over Bluetooth"}
        </div>
        <h3>Update both temples directly over Bluetooth</h3>
        <p>
          Chrome transfers every component in the selected hash-pinned package
          to both temples simultaneously, using independent per-block
          acknowledgements and component verification for each side. No Case
          USB connection is required.
        </p>
        <ol>
          <li>Remove both temples from the Case and keep them powered nearby.</li>
          <li>
            Disconnect the paired phone, then select the explicitly labeled
            Left and Right devices below.
          </li>
          <li>
            The chooser may list both sides, but this webflasher accepts only an
            unambiguous side marker that matches the button you selected.
          </li>
          <li>
            Keep this WebFlasher tab in front during the update. If it becomes
            hidden, the webflasher pauses before the next OTA command and resumes
            from that verified boundary when you return.
          </li>
        </ol>
      </div>
      <div className="ble-recovery-actions">
        <div className="ble-device-buttons">
          {["left", "right"].map((side) => (
            <Button
              key={side}
              tone="secondary"
              onClick={() => onSelectTemple(side)}
              disabled={!directBleSupported || Boolean(operation)}
            >
              {bleDevices[side]
                ? `${side === "left" ? "Left" : "Right"} · ${bleDevices[side].name}`
                : `Select ${side === "left" ? "LEFT" : "RIGHT"} temple`}
            </Button>
          ))}
        </div>
        <label className="ble-ready-confirm">
          <input
            type="checkbox"
            checked={bleReady}
            onChange={(event) => onReadyChange(event.target.checked)}
            disabled={
              !directBleSupported ||
              !bleDevices.left ||
              !bleDevices.right ||
              Boolean(operation)
            }
          />
          <span>
            Both advertised names explicitly match their assigned physical
            sides; the phone is disconnected and the temples will stay powered
            and nearby; this WebFlasher tab will stay in front.
          </span>
        </label>
        <Button
          className="ble-recovery-start"
          onClick={onFlash}
          busy={operation === "ble-temple-flash"}
          disabled={!bleFlashReady}
        >
          Update{" "}
          {selectedRelease
            ? firmwareReleaseDisplayName(selectedRelease)
            : "selected firmware"}{" "}
          over Bluetooth
        </Button>
        <div className="automatic-status" role="status">
          <span
            className={cx(
              "tiny-dot",
              bleResults?.outcome === "success" ? "tiny-dot-success" : "",
              bleResults?.outcome === "awaiting_case_verification"
                ? "tiny-dot-warm"
                : "",
            )}
          />
          <span>{bleStatus}</span>
        </div>
        {!directBleSupported ? (
          <small className="browser-note">
            Primary updates need Web Bluetooth in current Chrome. USB recovery
            is available below when Bluetooth cannot be used.
          </small>
        ) : null}
      </div>
    </article>
  );
}

function OperationError({ error, onDismiss }) {
  if (!error) return null;
  const staleRelease = error.includes(
    "Reload this page before changing device firmware",
  );
  return (
    <div className="error-banner" role="alert">
      <Icon name="warning" />
      <div>
        <strong>Operation stopped safely</strong>
        <span>{error}</span>
        {staleRelease ? (
          <Button tone="secondary" onClick={() => window.location.reload()}>
            Reload now
          </Button>
        ) : null}
      </div>
      <button onClick={onDismiss} aria-label="Dismiss error">
        ×
      </button>
    </div>
  );
}

function Console({
  open,
  entries,
  fullTranscript = null,
  onClose,
  onClear,
  onDownload,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);
  if (!open) return null;
  const displayedEntries = Array.isArray(fullTranscript)
    ? fullTranscript
    : entries;
  return (
    <div className="console-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="console-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="console-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="console-header">
          <div>
            <div className="eyebrow">Live session</div>
            <h2 id="console-title">Recovery console log</h2>
          </div>
          <button className="console-close" onClick={onClose} aria-label="Close console">
            ×
          </button>
        </div>
        <div className="console-output" aria-live="polite">
          {displayedEntries.length ? (
            displayedEntries.map((entry, index) => (
              <div className={cx("console-line", `console-${entry.tone}`)} key={index}>
                <time>{entry.time}</time>
                {entry.tone === "evidence" ? (
                  <details className="console-evidence-entry">
                    <summary>
                      {entry.message.split("\n", 1)[0]} · Complete JSON preserved
                    </summary>
                    <pre>{entry.message}</pre>
                  </details>
                ) : (
                  <span>{entry.message}</span>
                )}
              </div>
            ))
          ) : (
            <div className="console-empty">No session events yet.</div>
          )}
        </div>
        <div className="console-actions">
          <span className="console-transcript-state">
            Full transcript · {displayedEntries.length} entries
          </span>
          <Button tone="ghost" onClick={onClear}>
            Clear
          </Button>
          <Button
            tone="secondary"
            onClick={onDownload}
            disabled={!displayedEntries.length}
          >
            Download log
          </Button>
        </div>
      </section>
    </div>
  );
}

function TaskProgress({ progress, wakeLockStatus, bleRouteProgress }) {
  if (!progress.visible) return null;
  const showBleRoutes =
    progress.name === "ble-temple-flash" && bleRouteProgress;
  const wakeLockVisible = wakeLockStatus?.state !== "idle";
  const wakeLockActive = wakeLockStatus?.state === "active";
  const wakeLockPending = wakeLockStatus?.state === "requesting";
  const wakeLockHeading =
    wakeLockStatus?.state === "suspended"
      ? "Computer sleep prevention paused"
      : wakeLockStatus?.state === "released"
        ? "Computer sleep prevention released"
        : wakeLockActive
          ? "Computer sleep prevention active"
          : wakeLockPending
            ? "Enabling computer sleep prevention"
            : "Computer sleep prevention unavailable";
  return (
    <div className="footer-task-progress" role="status" aria-live="polite">
      <div className="footer-task-progress-heading">
        <span>
          {OPERATION_LABELS[progress.name] ?? "Recovery operation"}
        </span>
        <strong>
          Operation {progress.current} of {progress.total} · {progress.percent}%
        </strong>
      </div>
      {showBleRoutes ? (
        <div className="footer-ble-route-progress">
          {["left", "right"].map((side) => {
            const route = bleRouteProgress[side];
            return (
              <div
                className={cx(
                  "footer-ble-route",
                  `is-${side}`,
                  `is-${route.status.replaceAll(" ", "-")}`,
                )}
                key={side}
              >
                <div className="footer-ble-route-heading">
                  <strong>{side.toUpperCase()}</strong>
                  <span>{route.status.replaceAll("_", " ")}</span>
                  <b>{route.percent}%</b>
                </div>
                <div
                  className="footer-progress-track"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow={route.percent}
                  aria-label={`${side} Bluetooth update progress`}
                >
                  <span style={{ width: `${route.percent}%` }} />
                </div>
                <div className="footer-current-task">{route.detail}</div>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div
            className="footer-progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={progress.percent}
            aria-label={OPERATION_LABELS[progress.name] ?? "Recovery progress"}
          >
            <span style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="footer-current-task">{progress.detail}</div>
        </>
      )}
      {wakeLockVisible ? (
        <div
          className={cx(
            "footer-wake-lock",
            wakeLockActive && "is-active",
            wakeLockPending && "is-pending",
            !wakeLockActive && !wakeLockPending && "is-warning",
          )}
        >
          <span aria-hidden="true" />
          <strong>{wakeLockHeading}</strong>
          <small>{wakeLockStatus.message}</small>
        </div>
      ) : null}
    </div>
  );
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// The full transcript outlives the 300-entry React update window so a crash or
// tab close during a recovery cannot destroy the evidence of what was written
// to the device. The Console always renders this complete persisted copy; the
// smaller state array only keeps high-frequency React updates bounded.
const CONSOLE_TRANSCRIPT_STORAGE_KEY = consoleTranscriptStorageKey(
  resolveConsoleTranscriptTabId(
    typeof window === "undefined" ? null : window.sessionStorage,
  ),
);
const CONSOLE_TRANSCRIPT_ENTRY_LIMIT = 5000;
const TRANSCRIPT_NOTICE_TIME = "--:--:--";

// Lines the transcript writes about itself, rather than anything the device
// did. They are shown once and never carried into the next session.
function isTranscriptRecoveryNotice(entry) {
  return Boolean(
    entry?.time === TRANSCRIPT_NOTICE_TIME ||
      /^Recovered \d+ console (entry|entries) from the previous session/.test(
        entry?.message ?? "",
      ),
  );
}

function readStoredConsoleTranscript() {
  const recovered = readConsoleTranscript(
    window.localStorage,
    CONSOLE_TRANSCRIPT_STORAGE_KEY,
  );
  // Housekeeping only; a live transcript in another tab is left alone.
  pruneConsoleTranscripts(window.localStorage, CONSOLE_TRANSCRIPT_STORAGE_KEY);
  return recovered;
}

function App() {
  const linkedDevice =
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("device") ?? "";
  const [report, setReport] = useState(null);
  const [backup, setBackup] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogState, setCatalogState] = useState("loading");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [ringCatalog, setRingCatalog] = useState([]);
  const [selectedRingReleaseId, setSelectedRingReleaseId] = useState("");
  const [ringApplicationDevice, setRingApplicationDevice] = useState(null);
  const [ringDfuDevice, setRingDfuDevice] = useState(null);
  const [ringReady, setRingReady] = useState(false);
  const [ringStatus, setRingStatus] = useState(
    "Select your connected R1, restart it into update mode, then select the R1 DFU device.",
  );
  const [firmware, setFirmware] = useState(null);
  const [staged, setStaged] = useState(null);
  const [progress, setProgress] = useState(EMPTY_PROGRESS);
  const [operation, setOperation] = useState(null);
  const [wakeLockStatus, setWakeLockStatus] = useState(
    IDLE_WAKE_LOCK_STATUS,
  );
  const [error, setError] = useState("");
  const [logs, setLogs] = useState([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [interfaceMode, setInterfaceMode] = useState(DEFAULT_INTERFACE_MODE);
  const [automaticInstallMode, setAutomaticInstallMode] = useState(
    DEFAULT_AUTOMATIC_INSTALL_MODE,
  );
  const [automaticCaseUpdate, setAutomaticCaseUpdate] = useState(
    DEFAULT_AUTOMATIC_CASE_UPDATE,
  );
  const [automaticStatus, setAutomaticStatus] = useState(
    "Open USB recovery, select a Case, then choose the recovery method.",
  );
  const [automaticRecoveryDiagnosis, setAutomaticRecoveryDiagnosis] =
    useState(null);
  const [automaticTransferPreview, setAutomaticTransferPreview] =
    useState(null);
  const [installedProvenance, setInstalledProvenance] = useState({});
  const [deviceHistory, setDeviceHistory] = useState(() => readDeviceHistory());
  const [deviceLabelDraft, setDeviceLabelDraft] = useState("");
  const [activeSection, setActiveSection] = useState(SECTION_KEYS[0]);
  const pendingAnchorRef = useRef(null);
  const [confirmText, setConfirmText] = useState("");
  const [confirmBackup, setConfirmBackup] = useState(false);
  const [recheckReport, setRecheckReport] = useState(null);
  const [analysisView, setAnalysisView] = useState("case");
  const [glassesAnalyzeConfirm, setGlassesAnalyzeConfirm] = useState(false);
  const [pogoResults, setPogoResults] = useState({});
  const [pogoRoute, setPogoRoute] = useState("left");
  const [pogoOperation, setPogoOperation] = useState("version");
  const [pogoConfirm, setPogoConfirm] = useState(false);
  const [templeFlashRoute, setTempleFlashRoute] = useState(
    DEFAULT_TEMPLE_FLASH_ROUTE,
  );
  const [templeFlashSeated, setTempleFlashSeated] = useState(false);
  const [templeFlashRisk, setTempleFlashRisk] = useState(false);
  const [templeFlashText, setTempleFlashText] = useState("");
  const [templeFlashAudit, setTempleFlashAudit] = useState(null);
  const [bleDevices, setBleDevices] = useState({
    left: null,
    right: null,
  });
  const [bleReady, setBleReady] = useState(false);
  const [bleStatus, setBleStatus] = useState(
    "Choose firmware, disconnect the Even app, then pair the explicitly labeled Left and Right temples.",
  );
  const [bleResults, setBleResults] = useState(null);
  const [bleRecoveryHint, setBleRecoveryHint] = useState(null);
  const [bleRouteProgress, setBleRouteProgress] = useState(
    EMPTY_BLE_ROUTE_PROGRESS,
  );
  const [usbRecoveryRequested, setUsbRecoveryRequested] = useState(false);
  const [recoveryDumps, setRecoveryDumps] = useState({});
  const [recoveryConfig, setRecoveryConfig] = useState(null);
  const [recoveryConfigError, setRecoveryConfigError] = useState("");
  const portRef = useRef(null);
  const sessionRef = useRef(null);
  const activeOperationRef = useRef(null);
  const activeOperationTotalRef = useRef(null);
  const progressLogRef = useRef({ name: null, bucket: -1 });
  const progressRenderRef = useRef({ name: null, updatedAt: 0 });
  const progressHideTimerRef = useRef(null);
  const mutationWakeLockRef = useRef(null);
  const transcriptRef = useRef([]);
  const transcriptPersistTimerRef = useRef(null);
  const transcriptRecoveredRef = useRef(false);
  // Set only once the previous transcript has been read and adopted, or shown
  // to be absent. Until then this session must not overwrite what is stored.
  const transcriptCustodyRef = useRef(false);

  const writeTranscriptNow = useCallback(() => {
    if (transcriptPersistTimerRef.current) {
      clearTimeout(transcriptPersistTimerRef.current);
      transcriptPersistTimerRef.current = null;
    }
    // Saving replaces the whole stored transcript, so it may only happen once
    // this session has actually taken custody of the previous one. Without
    // this guard any load-time failure turns the next save into data loss:
    // a broken build left recovery throwing, and the first save afterwards
    // replaced a 1,727-entry history with a handful of new lines.
    if (!transcriptCustodyRef.current) return;
    writeConsoleTranscript(
      window.localStorage,
      CONSOLE_TRANSCRIPT_STORAGE_KEY,
      transcriptRef.current,
      new Date().toISOString(),
    );
  }, []);

  const persistTranscript = useCallback(() => {
    if (transcriptPersistTimerRef.current) return;
    transcriptPersistTimerRef.current = setTimeout(writeTranscriptNow, 400);
  }, [writeTranscriptNow]);

  const addLog = useCallback(
    (message, tone = "info") => {
      const time = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const entry = { time, message, tone };
      transcriptRef.current = [
        ...transcriptRef.current.slice(-(CONSOLE_TRANSCRIPT_ENTRY_LIMIT - 1)),
        entry,
      ];
      persistTranscript();
      setLogs((current) => [...current.slice(-299), entry]);
    },
    [persistTranscript],
  );

  const handleWakeLockStatus = useCallback(
    (status) => {
      setWakeLockStatus(status);
      if (status.state === "active") {
        addLog(
          status.reacquired
            ? "Computer sleep prevention restored after the WebFlasher tab became visible."
            : "Computer sleep prevention active for this firmware operation.",
          "success",
        );
      } else if (
        ["unsupported", "failed", "released", "suspended"].includes(
          status.state,
        )
      ) {
        addLog(
          `${status.message}${status.error ? ` ${status.error}` : ""}`,
          "warn",
        );
      }
    },
    [addLog],
  );

  const setSessionProgress = useCallback((fraction, detail) => {
    const name = activeOperationRef.current;
    const normalized = operationProgress(
      name,
      fraction,
      activeOperationTotalRef.current,
    );
    const now = performance.now();
    const previousRender = progressRenderRef.current;
    const shouldRender =
      previousRender.name !== name ||
      normalized.fraction <= 0 ||
      normalized.fraction >= 1 ||
      now - previousRender.updatedAt >= 100;
    if (shouldRender) {
      progressRenderRef.current = { name, updatedAt: now };
      setProgress({
        ...normalized,
        name,
        detail,
        visible: true,
      });
    }
    const bucket = Math.min(20, Math.floor(normalized.fraction * 20));
    if (
      name &&
      (progressLogRef.current.name !== name ||
        progressLogRef.current.bucket !== bucket)
    ) {
      progressLogRef.current = { name, bucket };
      addLog(`[${normalized.percent}%] ${detail}`);
    }
  }, [addLog]);

  const getSession = useCallback(
    (port = portRef.current, caseReport = report) => {
      if (!port) throw new Error("Connect the G2 Case first.");
      if (!sessionRef.current || sessionRef.current.port !== port) {
        sessionRef.current = new G2CaseSession(port, {
          log: addLog,
          progress: setSessionProgress,
        });
      }
      // Keep the session pointed at the physical unit in front of us so
      // per-device records (pacing memory, audit fingerprints) never blend
      // two Cases together.
      sessionRef.current.deviceKey = caseDeviceKey(caseReport);
      return sessionRef.current;
    },
    [addLog, report, setSessionProgress],
  );

  const recordShellEvidenceSnapshot = useCallback(
    ({
      caseReport = report,
      results = pogoResults,
      phase,
      recoveryConfigSnapshot = recoveryConfig,
      templeFlashAuditSnapshot = templeFlashAudit,
      bluetoothFlashAuditSnapshot = bleResults,
    }) => {
      if (!caseReport) return null;
      const capturedAt = new Date().toISOString();
      const analytics = buildG2DeviceAnalytics({
        report: caseReport,
        pogoResults: results,
        recoveryConfig: recoveryConfigSnapshot,
        templeFlashAudit: templeFlashAuditSnapshot,
        bluetoothFlashAudit: bluetoothFlashAuditSnapshot,
        generatedAt: capturedAt,
      });
      addLog(
        formatShellEvidenceTranscript(analytics, { phase, capturedAt }),
        "evidence",
      );
      return analytics;
    },
    [
      addLog,
      bleResults,
      pogoResults,
      recoveryConfig,
      report,
      templeFlashAudit,
    ],
  );

  // A Bluetooth transfer whose final reboot did not re-advertise stays
  // pending until both checksum-valid Case routes report the target runtime.
  // This is deliberately a state transition rather than just presentation:
  // downloaded evidence and the Easy Mode completion badge must agree that a
  // vanished temple has not yet been proven healthy.
  useEffect(() => {
    if (bleResults?.outcome !== "awaiting_case_verification") return;
    const targetReportedVersion = bleResults.reportedVersion;
    if (
      !["left", "right"].every((side) =>
        g2BleTargetVersionProof(pogoResults[side], targetReportedVersion),
      )
    ) {
      return;
    }
    const verifiedAt = new Date().toISOString();
    const finalized = {
      ...bleResults,
      outcome: "success",
      caseVerifiedAt: verifiedAt,
      routes: Object.fromEntries(
        ["left", "right"].map((side) => [
          side,
          {
            ...bleResults.routes?.[side],
            verifiedBy: "fresh-case-version-proof",
            caseVerifiedAt: verifiedAt,
          },
        ]),
      ),
    };
    setBleResults(finalized);
    setBleStatus(
      `Bluetooth update complete · the Case verified checksum-valid left + right Application liveness at reported G2 ${targetReportedVersion}.`,
    );
    addLog(
      `Direct Bluetooth restore completed only after fresh Case proof · both routes report checksum-valid G2 ${targetReportedVersion} Application liveness.`,
      "success",
    );
    addLog(
      formatBluetoothRecoveryTranscript(finalized, {
        phase: "bluetooth-smart-glasses-recovery-case-verified",
        buildLabel: WEBFLASHER_BUILD_LABEL,
      }),
      "evidence",
    );
    recordShellEvidenceSnapshot({
      phase: "post-bluetooth-smart-glasses-recovery-case-verified",
      results: pogoResults,
      bluetoothFlashAuditSnapshot: finalized,
    });
  }, [
    addLog,
    bleResults,
    pogoResults,
    recordShellEvidenceSnapshot,
  ]);

  // Panes are addressed by hash so deep links, back/forward, and in-page anchors
  // keep working even though the page no longer scrolls as one document.
  useEffect(() => {
    const applyHash = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      if (id === "easy") {
        pendingAnchorRef.current = null;
        setInterfaceMode("easy");
        return;
      }
      if (SECTION_KEYS.includes(id)) {
        setInterfaceMode("advanced");
        pendingAnchorRef.current = null;
        setActiveSection((current) => {
          // Re-selecting the open pane produces no re-render, so reset here.
          if (current === id) {
            document
              .querySelector(".pane-viewport")
              ?.scrollTo({ top: 0, behavior: "instant" });
          }
          return id;
        });
        return;
      }
      // An anchor inside a pane (e.g. #smart-glasses-recovery): open its pane,
      // then bring the target into view within that pane.
      const target = document.getElementById(id);
      const pane = target?.closest("[data-pane]");
      if (!pane) return;
      if (pane.classList.contains("is-active")) {
        // Already showing: no re-render is coming, so scroll now.
        target.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      // Hand off to the post-render effect, which would otherwise reset us to
      // the top of the newly opened pane.
      pendingAnchorRef.current = id;
      setActiveSection(pane.dataset.pane);
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  useEffect(() => {
    setAutomaticTransferPreview(null);
  }, [automaticInstallMode, selectedReleaseId]);

  useEffect(() => {
    const key = installedProvenanceStorageKey(
      report?.console?.serialNumber,
      report?.console?.identifier,
    );
    if (!key) {
      setInstalledProvenance({});
      return;
    }
    try {
      const stored = window.localStorage.getItem(key);
      setInstalledProvenance(stored ? JSON.parse(stored) : {});
    } catch {
      setInstalledProvenance({});
      addLog(
        "Saved installed-firmware proof could not be read; Update will fail closed.",
        "warn",
      );
    }
  }, [
    addLog,
    report?.console?.identifier,
    report?.console?.serialNumber,
  ]);

  // Each pane is its own scroll context; entering one starts at its top unless
  // the navigation targeted an anchor inside it.
  useEffect(() => {
    const viewport = document.querySelector(".pane-viewport");
    if (!viewport) return;
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    if (anchor) {
      // The pane itself just swapped in, so land on the anchor directly rather
      // than animating from a position the user never saw.
      document
        .getElementById(anchor)
        ?.scrollIntoView({ block: "start", behavior: "instant" });
      return;
    }
    viewport.scrollTo({ top: 0, behavior: "instant" });
  }, [activeSection, interfaceMode]);

  useEffect(() => {
    let active = true;
    fetch(WEBFLASHER_FIRMWARE_CATALOG_URL, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((value) => {
        if (!active) return;
        const releases = Array.isArray(value.releases)
          ? value.releases
              .filter((release) => (release.channel ?? "official") === "official")
              .map((release) => ({
                ...release,
                id: release.id ?? `g2-official-${release.version}`,
                channel: "official",
                caseRecoveryEligible: release.caseRecoveryEligible ?? true,
              }))
          : [];
        setCatalog(releases);
        setSelectedReleaseId(findDefaultFirmwareRelease(releases)?.id ?? "");
        const ringReleases = Array.isArray(value.ringReleases)
          ? value.ringReleases
          : [];
        setRingCatalog(ringReleases);
        setSelectedRingReleaseId(ringReleases[0]?.id ?? "");
        setCatalogState("ready");
      })
      .catch(() => {
        if (active) setCatalogState("offline");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (linkedDevice.toLowerCase() !== "r1" || catalogState !== "ready") return;
    document
      .getElementById("ring-update")
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [catalogState, linkedDevice]);

  // Warn when the served library is behind the images this build already
  // trusts. Retired older images are ignored on purpose;
  // see findUnservedPinnedImages for why the check is one-directional.
  const catalogCoverageWarnedRef = useRef("");
  useEffect(() => {
    if (catalogState !== "ready") return;
    const missing = findUnservedPinnedImages({
      catalog,
      targets: TEMPLE_FLASH_TARGETS,
    });
    const signature = missing.map((target) => target.imageSha256).join(",");
    if (catalogCoverageWarnedRef.current === signature) return;
    catalogCoverageWarnedRef.current = signature;
    if (missing.length === 0) return;
    addLog(
      `Firmware library is missing ${missing.length} pinned image${
        missing.length === 1 ? "" : "s"
      } this build already trusts: ${missing
        .map((target) => `${target.label} (${target.imageSha256.slice(0, 12)}…)`)
        .join(", ")}. The served catalog is older than the running bundle, so those images cannot be selected here and a temple can end up on an older build than intended. Republish public/firmware-updates/ alongside the app bundle.`,
      "warn",
    );
  }, [addLog, catalog, catalogState]);

  useEffect(
    () => () => {
      if (progressHideTimerRef.current) {
        clearTimeout(progressHideTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const handleError = (event) => {
      addLog(`Browser error: ${event.message || "unknown script error"}`, "error");
    };
    const handleRejection = (event) => {
      const message =
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason ?? "unknown rejected promise");
      addLog(`Unhandled browser rejection: ${message}`, "error");
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, [addLog]);

  useEffect(() => {
    if (transcriptRecoveredRef.current) return;
    transcriptRecoveredRef.current = true;
    let stored = null;
    try {
      stored = readStoredConsoleTranscript();
    } catch (error) {
      // Custody stays false, so the stored transcript is left untouched
      // rather than replaced by this session's few lines.
      addLog(
        `The previous console transcript could not be read (${error.message}); it has been left untouched and this session will not overwrite it.`,
        "warn",
      );
      addLog(
        `Current WebFlasher session opened · build ${WEBFLASHER_BUILD_LABEL}.`,
      );
      return;
    }
    transcriptCustodyRef.current = true;
    if (!stored) {
      addLog(
        `Current WebFlasher session opened · build ${WEBFLASHER_BUILD_LABEL}.`,
      );
      return;
    }
    // Drop the bookkeeping lines a previous recovery wrote. Persisting them
    // made every reload add two permanent entries, so a tab reloaded often
    // slowly filled its own transcript with recovery notices instead of
    // device history.
    const deviceEntries = stored.entries.filter(
      (entry) => !isTranscriptRecoveryNotice(entry),
    );
    if (deviceEntries.length) {
      // Prepend the recovered entries so they persist again and appear in
      // downloads; the visible console only announces the recovery.
      transcriptRef.current = [
        ...deviceEntries,
        {
          time: TRANSCRIPT_NOTICE_TIME,
          message: `———— end of previous session transcript${stored.savedAt ? ` (last saved ${stored.savedAt})` : ""} ————`,
          tone: "info",
        },
        ...transcriptRef.current,
      ].slice(-CONSOLE_TRANSCRIPT_ENTRY_LIMIT);
      addLog(
        `Recovered ${deviceEntries.length} console ${deviceEntries.length === 1 ? "entry" : "entries"} from the previous session; Download log includes them.`,
      );
    }
    addLog(
      deviceEntries.length
        ? `Current WebFlasher session opened · build ${WEBFLASHER_BUILD_LABEL}. Entries above the separator belong to earlier browser sessions.`
        : `Current WebFlasher session opened · build ${WEBFLASHER_BUILD_LABEL}.`,
    );
    // Recover exactly once per load.
  }, []);

  useEffect(() => {
    if (!webSerialSupported()) return undefined;
    const eventPort = (event) => event.port ?? event.target;
    const handleDisconnect = (event) => {
      const port = eventPort(event);
      if (!portRef.current || port !== portRef.current) return;
      portRef.current = null;
      sessionRef.current = null;
      setReport(null);
      setRecheckReport(null);
      addLog(
        "The Case USB serial device disconnected. Reconnect the Case and run a fresh analysis before any recovery step.",
        "error",
      );
    };
    const handleConnect = (event) => {
      if (!isG2CaseSerialPort(eventPort(event))) return;
      addLog(
        "A G2 Case USB serial interface was connected. Select the Case to analyze it.",
      );
    };
    navigator.serial.addEventListener("disconnect", handleDisconnect);
    navigator.serial.addEventListener("connect", handleConnect);
    return () => {
      navigator.serial.removeEventListener("disconnect", handleDisconnect);
      navigator.serial.removeEventListener("connect", handleConnect);
    };
  }, [addLog]);

  useEffect(() => {
    if (!webUsbSupported()) return undefined;
    const handleDisconnect = (event) => {
      const device = event.device ?? event.target;
      if (!portRef.current || !portUsesUsbDevice(portRef.current, device)) return;
      portRef.current = null;
      sessionRef.current = null;
      setReport(null);
      setRecheckReport(null);
      addLog(
        "The Case WebUSB device disconnected. Reconnect it and run a fresh analysis before any recovery step.",
        "error",
      );
    };
    const handleConnect = (event) => {
      if (!isG2CaseUsbConnectionEvent(event)) return;
      addLog("A G2 Case WebUSB interface connected. Select it to analyze the Case.");
    };
    navigator.usb.addEventListener("disconnect", handleDisconnect);
    navigator.usb.addEventListener("connect", handleConnect);
    return () => {
      navigator.usb.removeEventListener("disconnect", handleDisconnect);
      navigator.usb.removeEventListener("connect", handleConnect);
    };
  }, [addLog]);

  useEffect(() => {
    // A debounced write can lose the final entries when the tab closes;
    // pagehide is the last reliable moment to flush them.
    window.addEventListener("pagehide", writeTranscriptNow);
    return () => window.removeEventListener("pagehide", writeTranscriptNow);
  }, [writeTranscriptNow]);

  useEffect(() => {
    if (!PERSISTENT_MUTATION_OPERATIONS.has(operation)) return undefined;
    const preventOperationUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventOperationUnload);
    return () =>
      window.removeEventListener("beforeunload", preventOperationUnload);
  }, [operation]);

  useEffect(
    () => () => {
      void mutationWakeLockRef.current?.stop();
    },
    [],
  );

  const run = useCallback(async (name, task, { total = null } = {}) => {
    let mutationWakeLock = null;
    if (progressHideTimerRef.current) {
      clearTimeout(progressHideTimerRef.current);
      progressHideTimerRef.current = null;
    }
    activeOperationRef.current = name;
    activeOperationTotalRef.current = total ?? OPERATION_TOTALS[name] ?? 1;
    progressLogRef.current = { name, bucket: -1 };
    setOperation(name);
    setError("");
    const starting = operationProgress(
      name,
      0,
      activeOperationTotalRef.current,
    );
    setProgress({
      ...starting,
      name,
      detail: "Starting…",
      visible: true,
    });
    addLog(
      `${OPERATION_LABELS[name] ?? name} started · WebFlasher ${WEBFLASHER_BUILD_LABEL}.`,
    );
    try {
      if (PERSISTENT_MUTATION_OPERATIONS.has(name)) {
        assertStableMutationRuntime();
        mutationWakeLock = new MutationWakeLock({
          onStatus: handleWakeLockStatus,
        });
        mutationWakeLockRef.current = mutationWakeLock;
        await mutationWakeLock.start();
        const release = await assertCurrentWebFlasherRelease();
        addLog(
          `Release integrity passed · running and deployed WebFlasher ${release.deployedSha.slice(0, 7)} match.`,
          "success",
        );
        if (FIRMWARE_CATALOG_MUTATION_OPERATIONS.has(name)) {
          assertFirmwareCatalogCoversPinnedImages({
            catalog,
            targets: TEMPLE_FLASH_TARGETS,
          });
          addLog(
            "Firmware library integrity passed · the served catalog covers this build's newest pinned temple images.",
            "success",
          );
        }
      }
      const result = await task();
      addLog(`${OPERATION_LABELS[name] ?? name} finished.`, "success");
      return result;
    } catch (caught) {
      const message =
        caught?.operationMessage ?? caught?.message ?? String(caught);
      setError(message);
      addLog(message, "error");
      return null;
    } finally {
      if (mutationWakeLock) {
        await mutationWakeLock.stop();
        if (mutationWakeLockRef.current === mutationWakeLock) {
          mutationWakeLockRef.current = null;
        }
      }
      setOperation(null);
      activeOperationRef.current = null;
      activeOperationTotalRef.current = null;
      progressHideTimerRef.current = setTimeout(
        () => setProgress((value) => ({ ...value, visible: false })),
        2200,
      );
    }
  }, [addLog, catalog, handleWakeLockStatus]);



  const collectSmartGlassesAnalysis = useCallback(
    async ({
      caseReport = report,
      initialResults = pogoResults,
      progressBase = 0,
      progressSpan = 1,
      evidencePhase = "smart-glasses-analysis",
      recoveryConfigSnapshot = recoveryConfig,
      templeFlashAuditSnapshot = templeFlashAudit,
      bluetoothFlashAuditSnapshot = bleResults,
    } = {}) => {
      if (
        !caseReport?.console?.telemetry?.leftPresent ||
        !caseReport?.console?.telemetry?.rightPresent
      ) {
        throw new Error(
          "Seat both Smart Glasses temples, refresh the Case analysis, and try again.",
        );
      }
      const session = getSession(portRef.current, caseReport);
      let nextResults = { ...initialResults };
      const requests = [
        ["left", "version"],
        ["left", "status"],
        ["right", "version"],
        ["right", "status"],
      ];
      for (const [index, [route, request]] of requests.entries()) {
        try {
          const result = await session.probeRunningTemple(request, route, {
            progressBase:
              progressBase + (index / requests.length) * progressSpan,
            progressSpan: progressSpan / requests.length,
          });
          nextResults = {
            ...nextResults,
            [route]: {
              ...nextResults[route],
              [request]: {
                ...result,
                observedAt: new Date().toISOString(),
              },
              lastProbeFailure: null,
            },
          };
          setPogoResults(nextResults);
        } catch (error) {
          // Preserve every successful frame collected before the failure and
          // make the failure itself part of the same downloadable evidence.
          nextResults = {
            ...nextResults,
            [route]: {
              ...nextResults[route],
              lastProbeFailure: {
                at: new Date().toISOString(),
                operation: request,
                message: error.message,
              },
            },
          };
          setPogoResults(nextResults);
          recordShellEvidenceSnapshot({
            caseReport,
            results: nextResults,
            phase: `${evidencePhase}-partial`,
            recoveryConfigSnapshot,
            templeFlashAuditSnapshot,
            bluetoothFlashAuditSnapshot,
          });
          throw error;
        }
      }
      setGlassesAnalyzeConfirm(false);
      setSessionProgress(progressBase + progressSpan, "Both Smart Glasses temples analyzed");
      addLog(
        "Smart Glasses analysis complete · both version/status frames and route-restoration proofs captured.",
        "success",
      );
      recordShellEvidenceSnapshot({
        caseReport,
        results: nextResults,
        phase: evidencePhase,
        recoveryConfigSnapshot,
        templeFlashAuditSnapshot,
        bluetoothFlashAuditSnapshot,
      });
      return nextResults;
    },
    [
      addLog,
      bleResults,
      getSession,
      pogoResults,
      recordShellEvidenceSnapshot,
      recoveryConfig,
      report,
      setSessionProgress,
      templeFlashAudit,
    ],
  );

  const connectAndAnalyze = async (transportOrEvent = "auto") => {
    const transport =
      typeof transportOrEvent === "string" ? transportOrEvent : "auto";
    await run("analyze", async () => {
      const preferredTransport =
        transport === "auto"
          ? webUsbSupported()
            ? "recommended WebUSB"
            : "Web Serial"
          : transport === "webusb"
            ? "WebUSB"
            : "Web Serial";
      addLog(
        `Waiting for a G2 Case ${preferredTransport} selection.`,
      );
      const port = await requestG2CasePort({ transport });
      portRef.current = port;
      sessionRef.current = null;
      addLog(`G2 Case ${g2CaseTransportLabel(port)} interface selected.`);
      const result = await getSession(port).analyze({
        progressBase: 0,
        progressSpan: 0.48,
      });
      getSession(port, result);
      setReport(result);
      setBackup(null);
      setStaged(null);
      setPogoResults({});
      setPogoConfirm(false);
      setGlassesAnalyzeConfirm(false);
      setAnalysisView("case");
      setTempleFlashAudit(null);
      addLog(
        "Charging Case analysis complete. No device memory was changed.",
        "success",
      );
      recordShellEvidenceSnapshot({
        caseReport: result,
        results: {},
        phase: "charging-case-analysis",
        recoveryConfigSnapshot: null,
        templeFlashAuditSnapshot: null,
        bluetoothFlashAuditSnapshot: null,
      });
      if (
        !result.console?.telemetry?.leftPresent ||
        !result.console?.telemetry?.rightPresent
      ) {
        setSessionProgress(
          1,
          "Case analyzed; automatic Glasses analysis needs both temples",
        );
        addLog(
          "Automatic Smart Glasses analysis skipped because the Case did not report both temples seated. The complete Charging Case Shell & Evidence snapshot was retained.",
          "warn",
        );
        return;
      }
      addLog(
        "Automatically collecting bilateral Smart Glasses version, status, captured-frame, and route-restoration evidence.",
      );
      await collectSmartGlassesAnalysis({
        caseReport: result,
        initialResults: {},
        progressBase: 0.48,
        progressSpan: 0.52,
        evidencePhase: "automatic-smart-glasses-analysis",
        recoveryConfigSnapshot: null,
        templeFlashAuditSnapshot: null,
        bluetoothFlashAuditSnapshot: null,
      });
    });
  };

  const reanalyze = async () => {
    await run("analyze", async () => {
      const result = await getSession().analyze({
        progressBase: 0,
        progressSpan: 0.48,
      });
      getSession(portRef.current, result);
      setReport(result);
      setBackup(null);
      setStaged(null);
      setPogoResults({});
      setPogoConfirm(false);
      setGlassesAnalyzeConfirm(false);
      setTempleFlashAudit(null);
      addLog("Fresh analysis complete.", "success");
      recordShellEvidenceSnapshot({
        caseReport: result,
        results: {},
        phase: "refreshed-charging-case-analysis",
        recoveryConfigSnapshot: null,
        templeFlashAuditSnapshot: null,
        bluetoothFlashAuditSnapshot: null,
      });
      if (
        result.console?.telemetry?.leftPresent &&
        result.console?.telemetry?.rightPresent
      ) {
        addLog(
          "Automatically refreshing bilateral Smart Glasses analysis evidence.",
        );
        await collectSmartGlassesAnalysis({
          caseReport: result,
          initialResults: {},
          progressBase: 0.48,
          progressSpan: 0.52,
          evidencePhase: "refreshed-automatic-smart-glasses-analysis",
          recoveryConfigSnapshot: null,
          templeFlashAuditSnapshot: null,
          bluetoothFlashAuditSnapshot: null,
        });
      } else {
        setSessionProgress(
          1,
          "Case refreshed; automatic Glasses analysis needs both temples",
        );
        addLog(
          "Automatic Smart Glasses analysis skipped because the refreshed Case telemetry did not report both temples seated.",
          "warn",
        );
      }
    });
  };

  const createBackup = async () => {
    await run("backup", async () => {
      if (
        !report?.console?.telemetry?.leftPresent ||
        !report?.console?.telemetry?.rightPresent
      ) {
        throw new Error(
          "Seat both Smart Glasses temples in the Case, refresh analysis, and try the combined backup again.",
        );
      }
      if (catalogState !== "ready") {
        throw new Error(
          "The firmware archive must be available to include the matching Smart Glasses recovery image.",
        );
      }

      const session = getSession();
      const result = await session.backup({
        progressBase: 0,
        progressSpan: 0.62,
      });
      const templeProbes = {};
      for (const [index, route] of ["left", "right"].entries()) {
        templeProbes[route] = await session.probeRunningTemple(
          "version",
          route,
          {
            progressBase: 0.62 + index * 0.14,
            progressSpan: 0.14,
          },
        );
      }
      const recoveryRelease = findMatchingGlassesRecoveryRelease(
        catalog,
        templeProbes,
      );
      setSessionProgress(0.91, "Loading matching Smart Glasses recovery firmware");
      const response = await fetchCatalogRelease(
        recoveryRelease,
        "Smart Glasses recovery archive",
      );
      const recoveryBundleBytes = new Uint8Array(await response.arrayBuffer());
      await validateGlassesRecoveryBundle(
        recoveryBundleBytes,
        recoveryRelease,
      );
      setSessionProgress(0.97, "Packaging combined recovery backup");

      const artifact = buildG2SystemBackupArtifact({
        caseBackup: result,
        report,
        templeProbes,
        recoveryRelease,
        recoveryBundleBytes,
      });
      const nameVersion =
        artifact.chargingCase.firmwareVersion ?? "unknown";
      downloadBlob(
        new Blob([`${JSON.stringify(artifact, null, 2)}\n`], {
          type: "application/json",
        }),
        `g2-system-${nameVersion}-${new Date().toISOString().slice(0, 10)}.g2-backup.json`,
      );
      setBackup({
        ...result,
        artifact,
        templeProbes,
        recoveryRelease,
      });
      setPogoResults((current) => ({
        ...current,
        left: {
          ...current.left,
          version: {
            ...templeProbes.left,
            observedAt: artifact.createdAt,
          },
        },
        right: {
          ...current.right,
          version: {
            ...templeProbes.right,
            observedAt: artifact.createdAt,
          },
        },
      }));
      setSessionProgress(1, "Case + Smart Glasses backup verified");
      addLog(
        `Combined backup downloaded · full Case + both G2 ${recoveryRelease.version} temple snapshots + validated official recovery bundle.`,
        "success",
      );
    });
  };

  const prepareFirmware = async (bytes, fileName, expected) => {
    const parsed = await parseFirmwareInput(bytes, fileName);
    if (expected) {
      if (parsed.fileSize !== expected.size) {
        throw new Error("The mirrored firmware size does not match its catalog.");
      }
      if (parsed.fileSha256 !== expected.sha256) {
        throw new Error("The mirrored firmware SHA-256 does not match its catalog.");
      }
    }
    return expected
      ? {
          ...parsed,
          provenance: {
            ...parsed.provenance,
            channel: expected.channel,
            trust: expected.trust ?? parsed.provenance.trust,
            label: `Verified G2 ${expected.version} · archived SHA-256`,
            capabilities:
              expected.capabilities ?? parsed.provenance.capabilities ?? [],
          },
          caseRecoveryEligible:
            expected.caseRecoveryEligible ?? parsed.caseRecoveryEligible,
          catalogRelease: expected,
        }
      : parsed;
  };

  const acceptPreparedFirmware = (accepted) => {
    if (
      accepted.kind === "bundle" &&
      accepted.provenance.channel !== "official"
    ) {
      throw new Error("This fork accepts only official G2 firmware bundles.");
    }
    if (accepted.firmwareRevocation) {
      throw new Error(
        `G2 firmware ${accepted.firmwareRevocation.version} is revoked from all recovery paths: ${accepted.firmwareRevocation.reason}.`,
      );
    }
    setFirmware(accepted);
    setStaged(null);
    setTempleFlashAudit(null);
    setTempleFlashText("");
    setTempleFlashSeated(false);
    setTempleFlashRisk(false);
    addLog(
      `Validated ${accepted.fileName} · ${accepted.provenance.label} · ${accepted.fileSha256.slice(0, 16)}…`,
      "success",
    );
    return accepted;
  };

  const acceptFirmware = async (bytes, fileName, expected) => {
    return acceptPreparedFirmware(
      await prepareFirmware(bytes, fileName, expected),
    );
  };

  const fetchCatalogFirmware = async (release) => {
    const response = await fetchCatalogRelease(release);
    return prepareFirmware(
      new Uint8Array(await response.arrayBuffer()),
      release.fileName,
      release,
    );
  };

  const loadMirroredFirmware = async () => {
    const release = catalog.find((item) => item.id === selectedReleaseId);
    if (!release) {
      setError("Select an archived firmware release.");
      return;
    }
    await run("firmware", async () => {
      addLog(
        `Loading verified ${release.caseRecoveryEligible ? "Charging Case" : "Smart Glasses"} image ${release.version}.`,
      );
      acceptPreparedFirmware(await fetchCatalogFirmware(release));
      setSessionProgress(1, "Firmware validated");
    });
  };

  const selectBleTemple = async (side) => {
    if (operation) return;
    setError("");
    const marker = side === "left" ? "_L_" : "_R_";
    setBleStatus(
      `Waiting for Chrome's Bluetooth chooser · it will list Even G2 devices whose name contains ${marker}.`,
    );
    addLog(
      `Waiting for the ${side} G2 temple in Chrome's Bluetooth chooser · restricted to names containing ${marker}.`,
    );
    try {
      const device = await requestG2BleDevice(side, undefined, {
        // This side's own remembered name, never the other arm's.
        expectedName: readRememberedTempleNames()[side],
        tokens: readObservedNameTokens(),
      });
      rememberNameToken(device?.name);
      rememberTempleName(side, device?.name);
      const otherSide = side === "left" ? "right" : "left";
      if (
        bleDevices[otherSide]?.id &&
        bleDevices[otherSide].id === device.id
      ) {
        throw new Error(
          `${device.name || "That G2 temple"} is already selected as ${otherSide}. Select the other physical temple for ${side}.`,
        );
      }
      const observedSide = g2BleDeviceSide(device.name);
      setBleDevices((current) => ({
        ...current,
        [side]: device,
      }));
      setBleRecoveryHint((current) =>
        current?.side === side ? null : current,
      );
      setBleResults(null);
      setBleStatus(
        `${side} selected · ${device.name} · advertised ${observedSide} marker verified. Select the other temple before updating.`,
      );
      addLog(
        `${side}: selected Bluetooth device ${JSON.stringify(device.name)} · advertised side=${observedSide}. No firmware bytes were sent.`,
        "success",
      );
    } catch (caught) {
      const requestedSideUnavailable =
        caught?.name === "NotFoundError" ||
        caught?.code === "WRONG_G2_SIDE" ||
        caught?.code === "AMBIGUOUS_G2_SIDE";
      const message =
        caught?.name === "NotFoundError"
          ? `The ${side} Bluetooth chooser closed without a selection. Chrome uses the same result when no matching advertisement is visible; wake and remove that temple from the Case, disconnect it from the Even app or phone, then retry.`
          : caught?.message || String(caught);
      if (requestedSideUnavailable) {
        setBleRecoveryHint({
          side,
          reason:
            caught?.name === "NotFoundError"
              ? "no matching advertisement was selectable"
              : caught?.code === "WRONG_G2_SIDE"
                ? `Chrome returned the ${caught.observedSide} temple instead`
                : "the returned device had no trustworthy side marker",
          observedSide: caught?.observedSide ?? null,
          observedName: caught?.deviceName ?? null,
          observedAt: new Date().toISOString(),
        });
        setUsbRecoveryRequested(true);
        setBleStatus(
          `${message} The Case recovery panel is open: select the Case and run “Diagnose & recover without flashing” before considering a firmware rewrite.`,
        );
      } else {
        setBleStatus(message);
      }
      if (caught?.name === "NotFoundError") {
        addLog(
          `${message} Opening the Case no-flash recovery path for one bounded reset and bilateral Application proof.`,
          "warn",
        );
      } else {
        if (
          /Web Bluetooth is unavailable/i.test(message)
        ) {
          setUsbRecoveryRequested(true);
        }
        setError(message);
        addLog(
          requestedSideUnavailable
            ? `${message} The requested ${side} side remains unproven over Bluetooth; opening the Case no-flash recovery path before any firmware rewrite.`
            : message,
          "error",
        );
      }
    }
  };

  const flashBleTempleFirmware = async () => {
    const release = catalog.find((item) => item.id === selectedReleaseId);
    if (!release || !bleDevices.left || !bleDevices.right || !bleReady) return;
    setBleRouteProgress({
      left: { ...EMPTY_BLE_ROUTE_PROGRESS.left },
      right: { ...EMPTY_BLE_ROUTE_PROGRESS.right },
    });
    return run(
      "ble-temple-flash",
      async () => {
        const completedRoutes =
          bleResults?.imageSha256 === release.sha256
            ? { ...(bleResults.routes ?? {}) }
            : {};
        try {
          setBleStatus("Loading and re-validating the pinned Bluetooth package…");
          const prepared = await fetchCatalogFirmware(release);
          assertPinnedG2BleBundle(prepared);
          acceptPreparedFirmware(prepared);
          const targetReportedVersion =
            g2BleTargetReportedVersion(prepared);
          addLog(
            `Direct Bluetooth gate passed · exact package ${prepared.fileSha256.slice(0, 16)}… · ${prepared.componentImages.length} component headers, payload CRC32Cs, and Apollo MRAM bounds verified.`,
            "success",
          );

          const routeProgress = { left: 0, right: 0 };
          const setRouteProgress = (
            side,
            fraction,
            detail,
            explicitStatus = null,
          ) => {
            const normalized = Math.min(Math.max(Number(fraction) || 0, 0), 1);
            routeProgress[side] = Math.max(routeProgress[side], normalized);
            const leftPercent = Math.round(routeProgress.left * 100);
            const rightPercent = Math.round(routeProgress.right * 100);
            setBleRouteProgress((current) => ({
              ...current,
              [side]: {
                fraction: routeProgress[side],
                percent: Math.round(routeProgress[side] * 100),
                status:
                  explicitStatus ??
                  (routeProgress[side] >= 1
                    ? "verifying"
                    : routeProgress[side] > 0
                      ? "flashing"
                      : "connecting"),
                detail,
              },
            }));
            setSessionProgress(
              (routeProgress.left + routeProgress.right) / 2,
              `Left ${leftPercent}% · Right ${rightPercent}%`,
            );
          };
          const routesToFlash = [];
          for (const side of ["left", "right"]) {
            const device = bleDevices[side];
            if (
              g2BleTargetVersionProof(
                pogoResults[side],
                targetReportedVersion,
              )
            ) {
              completedRoutes[side] = {
                side,
                deviceId: device.id,
                deviceName: device.name,
                imageSha256: prepared.fileSha256,
                version: prepared.g2Version,
                reportedVersion: targetReportedVersion,
                components: [],
                blockAcks: 0,
                verifiedBy: "fresh-case-version-proof",
                skipped: true,
                outcome: "success",
              };
              setBleResults({
                imageSha256: prepared.fileSha256,
                version: prepared.g2Version,
                routes: { ...completedRoutes },
                outcome: "in_progress",
              });
              setRouteProgress(
                side,
                1,
                `${side}: retaining fresh Case proof of reported G2 ${targetReportedVersion}`,
                "retained",
              );
              addLog(
                `${side}: fresh checksum-valid Case interrogation already proves reported G2 ${targetReportedVersion} for package ${prepared.g2Version} with exact route restoration. Bluetooth will not rewrite this temple.`,
                "success",
              );
              continue;
            }
            if (
              completedRoutes[side]?.outcome === "success" &&
              completedRoutes[side]?.deviceId === device.id
            ) {
              setRouteProgress(
                side,
                1,
                `${side}: retaining the already verified Bluetooth package result`,
                "verified",
              );
              addLog(
                `${side}: this exact device already completed all six components in the current recovery attempt; it will not be rewritten.`,
                "success",
              );
              continue;
            }
            delete completedRoutes[side];
            routesToFlash.push({ side, device });
            setRouteProgress(
              side,
              0,
              `${side}: connecting to the selected Bluetooth endpoint`,
              "connecting",
            );
          }

          if (routesToFlash.length) {
            const flashingSides = routesToFlash.map(({ side }) => side);
            const simultaneous = routesToFlash.length === 2;
            setBleStatus(
              simultaneous
                ? "Flashing Left + Right simultaneously over independent Bluetooth sessions · keep both temples powered nearby and this WebFlasher tab in front."
                : `Flashing ${flashingSides[0]} over Bluetooth; the other side is already proven · keep this WebFlasher tab in front.`,
            );
            addLog(
              simultaneous
                ? "left + right: starting simultaneous direct Bluetooth OTA sessions. Each side retains independent ACK, retry, heartbeat, and completion evidence."
                : `${flashingSides[0]}: starting the only Bluetooth OTA session still required.`,
              "info",
            );
          }

          const sessionEntries = routesToFlash.map(({ side, device }) => ({
            side,
            device,
            session: new G2BleOtaSession(device, {
              side,
              log: addLog,
              progress: (fraction, detail, status) =>
                setRouteProgress(side, fraction, detail, status),
            }),
          }));
          const routeOutcomes = await flashG2BleSessionsConcurrently(
            sessionEntries,
            prepared,
            {
              onSettled: ({ side, status, value, reason }) => {
                if (status === "fulfilled") {
                  const postUpdate = value?.components?.at(-1)?.postUpdate;
                  if (
                    postUpdate?.freshReconnectAttempted &&
                    !postUpdate.reconnected
                  ) {
                    setRouteProgress(
                      side,
                      1,
                      `${side}: transfer verified; reboot reconnect exhausted, awaiting final Case version proof`,
                      "awaiting verification",
                    );
                    return;
                  }
                  setRouteProgress(
                    side,
                    1,
                    `${side}: all six components and fresh post-END GATT liveness verified`,
                    "verified",
                  );
                  return;
                }
                setRouteProgress(
                  side,
                  routeProgress[side],
                  `${side}: ${reason?.message || String(reason)}`,
                  "failed",
                );
              },
            },
          );
          for (const outcome of routeOutcomes) {
            const { side, device } = outcome;
            if (outcome.status === "fulfilled") {
              const postUpdate = outcome.value?.components?.at(-1)?.postUpdate;
              completedRoutes[side] = {
                ...outcome.value,
                deviceId: device.id,
              };
              if (
                postUpdate?.freshReconnectAttempted &&
                !postUpdate.reconnected
              ) {
                setRouteProgress(
                  side,
                  1,
                  `${side}: all six component ENDs verified; awaiting final Case version proof`,
                  "awaiting verification",
                );
              } else {
                setRouteProgress(
                  side,
                  1,
                  `${side}: all six Bluetooth components and post-reboot liveness verified`,
                  "verified",
                );
              }
              continue;
            }
            const failure = outcome.reason;
            completedRoutes[side] = failure?.partialResult
              ? {
                  ...failure.partialResult,
                  deviceId: device.id,
                }
              : {
                  side,
                  deviceId: device.id,
                  deviceName: device.name,
                  imageSha256: prepared.fileSha256,
                  version: prepared.g2Version,
                  reportedVersion: targetReportedVersion,
                  components: [],
                  completedComponentCount: 0,
                  blockAcks: 0,
                  verifiedPayloadBytes: 0,
                  outcome: "failed_before_transfer",
                  failure: {
                    message: failure?.message || String(failure),
                    code: failure?.code ?? null,
                  },
                };
          }
          setBleResults({
            imageSha256: prepared.fileSha256,
            version: prepared.g2Version,
            reportedVersion: targetReportedVersion,
            routes: { ...completedRoutes },
            outcome: "in_progress",
          });

          const failedOutcomes = routeOutcomes.filter(
            ({ status }) => status === "rejected",
          );
          if (failedOutcomes.length) {
            const failureSummary = failedOutcomes
              .map(
                ({ side, reason }) =>
                  `${side}: ${reason?.message || String(reason)}`,
              )
              .join("; ");
            const sessionSummary =
              routeOutcomes.length === 2
                ? "The simultaneous Bluetooth sessions finished"
                : "The Bluetooth session finished";
            throw new Error(
              `${sessionSummary} with ${failedOutcomes.length} failed side${failedOutcomes.length === 1 ? "" : "s"}. ${failureSummary}`,
            );
          }
          const awaitingCaseSides =
            g2BleRoutesAwaitingCaseVerification(completedRoutes);
          const awaitingCaseVerification = awaitingCaseSides.length > 0;
          const result = {
            imageSha256: prepared.fileSha256,
            version: prepared.g2Version,
            reportedVersion: targetReportedVersion,
            routes: completedRoutes,
            outcome: awaitingCaseVerification
              ? "awaiting_case_verification"
              : "success",
          };
          setBleResults(result);
          setBleReady(false);
          const retainedSides = ["right", "left"].filter(
            (side) => completedRoutes[side]?.skipped,
          );
          const transferredSides = ["right", "left"].filter(
            (side) => !completedRoutes[side]?.skipped,
          );
          const routeSummary = [
            retainedSides.length
              ? `${retainedSides.join(" + ")} retained from fresh target-version proof`
              : null,
            transferredSides.length
              ? `${transferredSides.join(" + ")} verified all six Bluetooth components`
              : null,
          ]
            .filter(Boolean)
            .join("; ");
          if (awaitingCaseVerification) {
            setUsbRecoveryRequested(true);
            setSessionProgress(
              1,
              `Bluetooth transfer accepted; awaiting Case proof for ${awaitingCaseSides.join(" + ")}`,
            );
            setBleStatus(
              `Bluetooth transfer accepted, but ${awaitingCaseSides.join(" + ")} did not complete a fresh reboot reconnect. Recovery is pending: re-seat both temples, select the Case, and run the no-flash recovery or Smart Glasses analysis.`,
            );
            addLog(
              `Direct Bluetooth transfer is not yet a completed recovery · ${awaitingCaseSides.join(" + ")} exhausted the fresh post-END reconnect. Re-seat both temples and obtain checksum-valid Case proof of reported G2 ${targetReportedVersion}; firmware will not be replayed.`,
              "warn",
            );
          } else {
            setSessionProgress(
              1,
              "Both temples proven at target by transfer or fresh Case version",
            );
            setBleStatus(
              `Bluetooth update complete on right + left · ${routeSummary}. Both routes have post-reboot Application proof.`,
            );
            addLog(
              `Direct Bluetooth restore completed · ${routeSummary}. Both routes have fresh post-reboot Application proof for package ${prepared.g2Version}.`,
              "success",
            );
          }
          addLog(
            formatBluetoothRecoveryTranscript(result, {
              phase: awaitingCaseVerification
                ? "bluetooth-smart-glasses-recovery-awaiting-case-verification"
                : "bluetooth-smart-glasses-recovery",
              buildLabel: WEBFLASHER_BUILD_LABEL,
            }),
            "evidence",
          );
          recordShellEvidenceSnapshot({
            phase: awaitingCaseVerification
              ? "post-bluetooth-smart-glasses-recovery-awaiting-case-verification"
              : "post-bluetooth-smart-glasses-recovery",
            bluetoothFlashAuditSnapshot: result,
          });
          return result;
        } catch (caught) {
          const failureResult = {
            imageSha256: release.sha256,
            version: release.version,
            routes: { ...completedRoutes },
            outcome: "failed_or_partial",
            error: caught?.message || String(caught),
            stoppedAt: new Date().toISOString(),
          };
          setBleResults(failureResult);
          setUsbRecoveryRequested(true);
          setBleStatus(
            `Bluetooth recovery stopped · ${caught?.message || String(caught)}`,
          );
          addLog(
            formatBluetoothRecoveryTranscript(failureResult, {
              phase: "bluetooth-smart-glasses-recovery-partial",
              buildLabel: WEBFLASHER_BUILD_LABEL,
            }),
            "evidence",
          );
          recordShellEvidenceSnapshot({
            phase: "post-bluetooth-smart-glasses-recovery-partial",
            bluetoothFlashAuditSnapshot: failureResult,
          });
          throw caught;
        }
      },
      { total: 16 },
    );
  };

  const loadLocalFirmware = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await run("firmware", async () => {
      addLog(`Inspecting local firmware file ${file.name}.`);
      await acceptFirmware(new Uint8Array(await file.arrayBuffer()), file.name);
      setSessionProgress(1, "Firmware validated");
    });
  };

  const loadRecoveryDump = async (kind, event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const next = {
      ...recoveryDumps,
      [kind]: {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      },
    };
    setRecoveryDumps(next);
    try {
      const decoded = decodeApollo510RecoveryConfig({
        infoc: next.infoc?.bytes,
        info0: next.info0?.bytes,
      });
      setRecoveryConfig(decoded);
      setRecoveryConfigError("");
      addLog(`Decoded read-only Apollo510 ${kind.toUpperCase()} dump ${file.name}.`, "success");
    } catch (caught) {
      setRecoveryConfig(null);
      setRecoveryConfigError(caught.message);
    }
  };

  const clearRecoveryDumps = () => {
    setRecoveryDumps({});
    setRecoveryConfig(null);
    setRecoveryConfigError("");
  };

  const restartAndRecheck = async () => {
    await run("recheck", async () => {
      const result = await getSession().restartAndVerifyBothTemples();
      setRecheckReport(result);
      if (report) {
        setReport({
          ...report,
          console: { ...report.console, ...result, telemetry: result.telemetry },
        });
      }
      setSessionProgress(1, "Recovery check complete");
      setPogoResults({});
      setPogoConfirm(false);
      setGlassesAnalyzeConfirm(false);
      addLog(
        "Both temples were reset; reopened Case telemetry and checksum-valid application liveness were verified without sending firmware.",
        "success",
      );
    });
  };

  const automaticRecoverWithoutFlash = async () => {
    if (!report) return null;
    setAutomaticStatus("Diagnosing Application mode on both temples…");
    return run("automatic-recovery", async () => {
      try {
        const diagnosis = await diagnoseAndRecoverAutomaticUsb({
          session: getSession(),
          forceResetReason: bleRecoveryHint
            ? `${bleRecoveryHint.side} Bluetooth selection failed because ${bleRecoveryHint.reason}`
            : null,
          onStep: ({ step, route, reason }) => {
            if (step === "telemetry") {
              setSessionProgress(0.03, "Refreshing Case and temple contacts");
            } else if (step === "probe") {
              setSessionProgress(
                route === "right" ? 0.1 : 0.26,
                `Checking ${route} Application-mode liveness`,
              );
            } else if (step === "reset") {
              setAutomaticStatus(
                bleRecoveryHint
                  ? `Both applications answer through the Case, but ${bleRecoveryHint.side} Bluetooth is unavailable; issuing one bounded bilateral reboot before any firmware write…`
                  : "A temple is outside proven Application mode; issuing the bounded bilateral reboot…",
              );
              setSessionProgress(0.4, "Rebooting both temples and verifying liveness");
              addLog(
                `No-flash bilateral reset requested · ${reason}`,
                "warn",
              );
            }
          },
        });
        setAutomaticRecoveryDiagnosis(diagnosis);
        const observedAt = new Date().toISOString();
        const versionResults = Object.fromEntries(
          ["left", "right"].flatMap((route) => {
            const initial = diagnosis.probes?.[route];
            const verified = diagnosis.verification?.versions?.[route];
            if (!initial?.decoded && !verified) return [];
            return [[
              route,
              {
                version: initial?.decoded
                  ? { ...initial, observedAt }
                  : {
                      operation: "version",
                      route,
                      decoded: {
                        kind: "version",
                        firmwareVersion: verified.firmware,
                        hardwareRevision: verified.hardware,
                      },
                      transportProof: {
                        restoredMask: verified.yhmRestoreVerified ? 0x3ff : null,
                      },
                      observedAt,
                    },
              },
            ]];
          }),
        );
        setPogoResults((current) => ({ ...current, ...versionResults }));
        if (diagnosis.verification) {
          setRecheckReport(diagnosis.verification);
          setReport((current) =>
            current
              ? {
                  ...current,
                  console: {
                    ...current.console,
                    ...diagnosis.verification,
                    telemetry: diagnosis.verification.telemetry,
                  },
                }
              : current,
          );
        }

        setSessionProgress(0.98, "Checking previously authorized Bluetooth endpoints");
        const bluetooth = await probeAuthorizedG2BleDevices({
          devices: bleDevices,
        });
        const complete = bluetooth.bothApplicationsReachable;
        const bluetoothDetail = complete
          ? "both previously authorized Bluetooth Application services are reachable"
          : bluetooth.chooserRequired
            ? "Bluetooth verification needs the local user to select both temples once"
            : `Bluetooth Application service reachable on ${bluetooth.reachableSides.join(" + ") || "neither side"}`;
        const completed = { ...diagnosis, bluetooth };
        setAutomaticRecoveryDiagnosis(completed);
        setSessionProgress(1, "Minimum recovery complete");
        setAutomaticStatus(
          diagnosis.action === "none"
            ? `Healthy · both temples were already in Application mode; ${bluetoothDetail}.`
            : `Recovered without firmware · both temples rebooted into Application mode; ${bluetoothDetail}.`,
        );
        if (diagnosis.action === "reset-for-bluetooth-and-verify") {
          setBleStatus(
            `The Case reset and checksum-valid left + right Application proof completed with zero firmware bytes. Remove the ${bleRecoveryHint?.side ?? "missing"} temple from the Case and retry its Bluetooth selection.`,
          );
          // A successful reset consumes this recovery request. A subsequent
          // chooser failure will create a fresh hint; repeated button presses
          // must not keep rebooting healthy temples without a new observation.
          setBleRecoveryHint(null);
        }
        addLog(
          `${diagnosis.action === "none" ? "No-flash diagnosis" : "No-flash recovery"} complete · firmware bytes sent 0 · ${bluetoothDetail}.`,
          complete ? "success" : "warn",
        );
        return completed;
      } catch (caught) {
        if (caught?.diagnosis) {
          setAutomaticRecoveryDiagnosis(caught.diagnosis);
          addLog(
            `Automatic no-flash diagnosis · ${JSON.stringify(caught.diagnosis)}`,
            "evidence",
          );
        }
        setAutomaticStatus(
          `No-flash recovery stopped · ${caught?.message ?? String(caught)}`,
        );
        throw caught;
      }
    }, { total: 8 });
  };

  const analyzeSmartGlasses = async () => {
    if (!glassesAnalyzeConfirm) return;
    await run("glasses-analyze", async () => {
      await collectSmartGlassesAnalysis();
    });
  };

  const probeRunningTemple = async () => {
    if (!pogoConfirm) return;
    await run("pogo", async () => {
      let result;
      try {
        result = await getSession().probeRunningTemple(
          pogoOperation,
          pogoRoute,
        );
      } catch (error) {
        setPogoResults((current) => ({
          ...current,
          [pogoRoute]: {
            ...current[pogoRoute],
            lastProbeFailure: {
              at: new Date().toLocaleTimeString(),
              message: error.message,
            },
          },
        }));
        throw error;
      }
      setPogoResults((current) => ({
        ...current,
        [pogoRoute]: {
          ...current[pogoRoute],
          [pogoOperation]: {
            ...result,
            observedAt: new Date().toISOString(),
          },
          lastProbeFailure: null,
        },
      }));
      setPogoConfirm(false);
      addLog(
        `${pogoRoute} temple ${pogoOperation} captured through the reviewed read-only SRAM bridge.`,
        "success",
      );
    });
  };

  // A fingerprint of the unit an operation ran against. Everything in it is
  // observed rather than inferred; the operator label is the only place the
  // things a human can see — case colour, frame fit, which unit this is —
  // can be recorded, because the device reports none of them.
  const describeConnectedDevice = useCallback(
    (deviceReport = report) => {
      const deviceKey = caseDeviceKey(deviceReport);
      return buildDeviceFingerprint({
        report: deviceReport,
        transport: portRef.current
          ? g2CaseTransportLabel(portRef.current)
          : null,
        usbBridgeRevision: usbBridgeRevisionOf(portRef.current),
        templeVersions: {
          left: pogoResults.left?.version?.decoded ?? null,
          right: pogoResults.right?.version?.decoded ?? null,
        },
        operatorLabel: readDeviceLabel(deviceKey),
      });
    },
    [pogoResults, report],
  );

  // File the outcome under the device so patterns across runs become visible:
  // which route rejects, how often an image needed an extra activation reset,
  // what pacing each side settled at.
  const recordDeviceRun = useCallback(
    (operation, audit, outcome) => {
      try {
        const fingerprint = describeConnectedDevice();
        recordDeviceOperation({
          report,
          operation,
          audit,
          fingerprint,
          outcome,
        });
        setDeviceHistory(readDeviceHistory());
      } catch {
        // History is diagnostic only and must never affect an operation.
      }
    },
    [describeConnectedDevice, report],
  );

  // A temple flash queries and verifies the version it just installed, but the
  // Smart Glasses panels only ever filled from an explicit read-only probe —
  // so immediately after a verified write they still read "Version not
  // queried", and the operator had to re-probe a freshly written temple to see
  // what the run already knew. Fold those replies into the same panel state.
  const absorbTempleFlashVersions = useCallback((audit) => {
    const observed =
      templeVersionObservationsFromFlashAudit(audit);
    if (Object.keys(observed).length === 0) return;
    setPogoResults((current) => {
      const next = { ...current };
      for (const [route, value] of Object.entries(observed)) {
        next[route] = { ...current[route], ...value };
      }
      return next;
    });
  }, []);

  const connectedDevice = useMemo(
    () => describeConnectedDevice(),
    [describeConnectedDevice],
  );
  const connectedDeviceHistory = useMemo(
    () => summarizeDeviceHistory(deviceHistory[connectedDevice.deviceKey]),
    [connectedDevice.deviceKey, deviceHistory],
  );
  // A temple running an older image than this browser last recorded on it is
  // the one thing a single session cannot see, and it changes the diagnosis:
  // an image that does not stay installed is a different fault from one that
  // will not write. Surfaced, never gating.
  const templeFirmwareRegressions = useMemo(
    () =>
      detectTempleFirmwareRegression(deviceHistory[connectedDevice.deviceKey], {
        left: pogoResults.left?.version?.decoded?.firmwareVersion ?? null,
        right: pogoResults.right?.version?.decoded?.firmwareVersion ?? null,
      }),
    [connectedDevice.deviceKey, deviceHistory, pogoResults],
  );

  // Load the saved label whenever a different physical Case is connected.
  useEffect(() => {
    setDeviceLabelDraft(readDeviceLabel(connectedDevice.deviceKey));
  }, [connectedDevice.deviceKey]);

  const recordInstalledProvenance = (
    audit,
    caseSerial,
    factoryIdentifier,
  ) => {
    setInstalledProvenance((current) => {
      const next = mergeInstalledProvenance(current, audit);
      const key = installedProvenanceStorageKey(
        caseSerial ?? report?.console?.serialNumber,
        factoryIdentifier ?? report?.console?.identifier,
      );
      if (key) {
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          addLog(
            "Installed-firmware proof could not be saved; a later Update may require Restore first.",
            "warn",
          );
        }
      }
      return next;
    });
  };

  const flashTempleFirmware = async () => {
    if (
      !firmware?.templeFlashEligible ||
      !templeFlashSeated ||
      !templeFlashRisk ||
      templeFlashText.trim().toUpperCase() !== "FLASH GLASSES FIRMWARE"
    ) {
      return;
    }
    await run("temple-flash", async () => {
      try {
        const audit = await getSession().flashPinnedTempleMain(
          firmware,
          templeFlashRoute,
          {
            mode: "complete",
          },
        );
        setTempleFlashAudit(audit);
        recordInstalledProvenance(audit);
        absorbTempleFlashVersions(audit);
        recordDeviceRun("temple-flash", audit, audit?.outcome ?? "success");
        setTempleFlashText("");
        setTempleFlashSeated(false);
        setTempleFlashRisk(false);
        addLog(
          `${audit.imageLabel} complete-main restore completed on ${audit.routes.join(" + ")}; finish CRC, route restoration, final dual reset, contacts, and post-reset liveness verified.`,
          "success",
        );
      } catch (caught) {
        if (caught?.audit) {
          setTempleFlashAudit(caught.audit);
          recordInstalledProvenance(caught.audit);
          absorbTempleFlashVersions(caught.audit);
          recordDeviceRun("temple-flash", caught.audit, "failed_or_uncertain");
        }
        throw caught;
      }
    }, {
      total: templeFlashRoute === "both" ? 14 : 9,
    });
  };

  const previewAutomaticUsbTransfer = async () => {
    const release = catalog.find((item) => item.id === selectedReleaseId);
    if (!report) {
      setError("Select and analyze the G2 Case before previewing the USB transfer.");
      return;
    }
    if (!release) {
      setError("Choose a firmware release before previewing the USB transfer.");
      return;
    }

    return run("automatic-plan", async () => {
      setAutomaticStatus("Building a no-write USB transfer preview…");
      setSessionProgress(0.1, "Loading the selected pinned firmware");
      const targetFirmware = acceptPreparedFirmware(
        await fetchCatalogFirmware(release),
      );


      const observedTempleVersions = Object.fromEntries(
        ["right", "left"].map((route) => {
          const decoded = pogoResults?.[route]?.version?.decoded;
          if (
            decoded?.kind !== "version" ||
            !decoded.firmwareVersion ||
            decoded.hardwareRevision !== 5
          ) {
            throw new Error(
              `Run the Smart Glasses version analysis before previewing; ${route} has no checksum-valid Application-mode version reply.`,
            );
          }
          return [
            route,
            {
              firmwareVersion: decoded.firmwareVersion,
              hardwareRevision: decoded.hardwareRevision,
            },
          ];
        }),
      );
      const plan = resolveAutomaticApplyPlan({
        installMode: automaticInstallMode,
        targetFirmware,
        installedProvenance,
        differenceSourceFirmware: null,
        differencePlan: null,
        observedTempleVersions,
      });

      const comparisonCache = new Map();
      const comparisonSourceFirmwareByRoute = {};
      for (const route of ["right", "left"]) {
        const observedVersion = observedTempleVersions[route].firmwareVersion;
        if (plan.route !== "both" && plan.route !== route) continue;
        if (!comparisonCache.has(observedVersion)) {
          const observedRelease = catalog.find(
            (item) =>
              item.channel === "official" &&
              (item.reportedVersion ?? item.internalVersion ?? item.version) ===
                observedVersion,
          );
          comparisonCache.set(
            observedVersion,
            observedRelease
              ? await fetchCatalogFirmware(observedRelease)
              : null,
          );
        }
        comparisonSourceFirmwareByRoute[route] =
          comparisonCache.get(observedVersion);
      }
      const summary = summarizeAutomaticApplyTransfer({
        plan,
        targetFirmware,
        differencePlan: null,
        comparisonSourceFirmwareByRoute,
      });
      setAutomaticTransferPreview(summary);
      setSessionProgress(1, "USB transfer preview ready; no firmware sent");
      const routeLabel = summary.routes.length
        ? summary.routes.join(" + ")
        : "none";
      setAutomaticStatus(
        summary.action === "verify-only"
          ? "Preview complete · both live versions match; Update will send 0 firmware bytes."
          : `Preview complete · ${routeLabel} · ${formatBytes(summary.firmwareBytes)} will cross USB. No firmware was sent by this preview.`,
      );
      addLog(
        summary.action === "verify-only"
          ? `USB transfer preview · target already live on both temples · 0 firmware bytes planned.`
          : `USB transfer preview · ${routeLabel} · ${formatBytes(summary.firmwareBytes)} on the wire${summary.semanticChangedBytes == null ? "" : ` for ${formatBytes(summary.semanticChangedBytes)} of known source-byte differences`} · sparse records unavailable in the running-temple OTA protocol.`,
        summary.action === "verify-only" ? "success" : "warn",
      );
      return summary;
    });
  };

  const automaticApply = async () => {
    const release = catalog.find((item) => item.id === selectedReleaseId);
    const latestCaseFirmwareRelease =
      findLatestCaseFirmwareRelease(catalog);
    if (!report) {
      setError("Select and analyze the G2 Case before applying firmware.");
      setAutomaticStatus("Waiting for a selected and analyzed Case.");
      return;
    }
    if (!release) {
      setError("Choose a firmware release before applying it.");
      return;
    }

    setAutomaticStatus("Running automatic preflight…");
    return run(
      "automatic-apply",
      async () => {
        try {
          const session = getSession();
          addLog(
            `Automatic USB recovery requested · Smart Glasses ${automaticInstallMode} · Update Charging Case first ${automaticCaseUpdate ? "enabled" : "disabled"}.`,
          );
          setSessionProgress(
            0.02,
            "Re-analyzing Case banks, option bytes, and contacts",
          );
          let fresh = await session.analyze({
            progressBase: 0.01,
            progressSpan: 0.07,
          });
          setReport(fresh);
          let freshTelemetry = fresh.console?.telemetry;
          const caseUpdatePlan = resolveAutomaticCaseUpdatePlan({
            enabled: automaticCaseUpdate,
            currentVersion: fresh.console?.caseVersion,
            targetRelease: latestCaseFirmwareRelease,
          });
          if (!caseUpdatePlan.executable) {
            throw new Error(caseUpdatePlan.reason);
          }
          const contactPreflight =
            assessAutomaticTempleContacts(freshTelemetry);
          if (!contactPreflight.automaticApplyAllowed) {
            throw new Error(contactPreflight.reason);
          }
          addLog(
            `Charging Case preflight · observed ${caseUpdatePlan.currentVersion} · latest ${caseUpdatePlan.targetVersion} · ${caseUpdatePlan.action === "update" ? "update required" : "already current"}.`,
            caseUpdatePlan.action === "update" ? "warn" : "success",
          );
          if (caseUpdatePlan.targetVersion !== REVIEWED_CASE_VERSION) {
            throw new Error(
              `This WebFlasher's glasses writer requires Case ${REVIEWED_CASE_VERSION}, but the latest library Case is ${caseUpdatePlan.targetVersion}. Update the WebFlasher before continuing.`,
            );
          }
          if (contactPreflight.resetRecoveryEligible) {
            addLog(
              `${contactPreflight.reason} Automatic USB recovery will attempt the traced bilateral reset and require both temples to return before any firmware transfer.`,
              "warn",
            );
          }

          let caseUpdateFirmware = null;
          if (caseUpdatePlan.action === "update") {
            setAutomaticStatus(
              `Updating Charging Case ${caseUpdatePlan.currentVersion} → ${caseUpdatePlan.targetVersion}…`,
            );
            setSessionProgress(
              0.04,
              `Loading verified Case ${caseUpdatePlan.targetVersion}`,
            );
            caseUpdateFirmware = await fetchCatalogFirmware(
              latestCaseFirmwareRelease,
            );
            const caseUpdate = await executeAutomaticCaseUpdate({
              session,
              currentReport: fresh,
              targetFirmware: caseUpdateFirmware,
              onStep: (step) => {
                if (step === "stage") {
                  setSessionProgress(
                    0.05,
                    `Staging Case ${caseUpdatePlan.targetVersion} in the inactive bank`,
                  );
                } else if (step === "activate") {
                  setSessionProgress(
                    0.27,
                    "Activating the verified Case bank",
                  );
                } else if (step === "reanalyze") {
                  setSessionProgress(
                    0.37,
                    "Re-analyzing the updated Charging Case",
                  );
                } else if (step === "verify-bank-switch") {
                  setSessionProgress(
                    0.48,
                    "Verifying the Charging Case physical bank switch",
                  );
                } else if (step === "confirm") {
                  setSessionProgress(
                    0.49,
                    `Confirming Case ${caseUpdatePlan.targetVersion} in a fresh DEA0 session`,
                  );
                }
              },
            });
            fresh = caseUpdate.report;
            setReport(fresh);
            setBackup(null);
            setStaged(null);
            const postUpdateConsole =
              await session.readTempleFlashPreflight([]);
            fresh = {
              ...fresh,
              console: {
                ...fresh.console,
                ...postUpdateConsole,
              },
            };
            setReport(fresh);
            freshTelemetry = fresh.console?.telemetry;
            setAutomaticStatus(
              `Charging Case ${caseUpdate.confirmation.confirmedVersion} confirmed by fresh DEA0; starting Smart Glasses ${automaticInstallMode}…`,
            );
            addLog(
              `Charging Case updated ${caseUpdatePlan.currentVersion} → ${caseUpdatePlan.targetVersion}; physical bank ${caseUpdate.bankSwitch.stagedPhysicalBank} activated (nSWAP_BANK ${Number(caseUpdate.bankSwitch.previousSwapBank)} → ${Number(caseUpdate.bankSwitch.activeSwapBank)}), physical bank ${caseUpdate.bankSwitch.fallbackPhysicalBank} preserved as the ${caseUpdate.bankSwitch.fallbackVersion} fallback, and fresh ${caseUpdate.confirmation.confirmationCommand} attempt ${caseUpdate.confirmation.confirmationAttempt}/${caseUpdate.confirmation.confirmationAttempts} verified.`,
              "success",
            );
          }

          const caseReadiness = verifyAutomaticCaseReadiness(
            fresh,
            caseUpdatePlan.targetVersion,
          );
          addLog(
            `Charging Case write gate passed · active physical bank ${caseReadiness.activePhysicalBank} ${caseReadiness.activeVersion} · fallback physical bank ${caseReadiness.fallbackPhysicalBank} ${caseReadiness.fallbackVersion ?? "version unknown"} · nSWAP_BANK ${Number(caseReadiness.swapBank)}.`,
            "success",
          );
          const caseCharging = fresh.console?.templeCharging;
          if (caseCharging?.left || caseCharging?.right) {
            const summarizeCharging = (side, value) =>
              value
                ? `${side} ${value.batteryPercent}%/${value.voltageMv} mV${value.charging ? " charging" : ""}`
                : `${side} unavailable`;
            addLog(
              `Informational Case charging telemetry · ${summarizeCharging("right", caseCharging.right)} · ${summarizeCharging("left", caseCharging.left)}. Running-app liveness remains separately required before START.`,
            );
          }

          setAutomaticStatus(
            "Checking installed versions before the clean-start reset…",
          );
          const templePreparation =
            await prepareAutomaticTempleUpdate({
              session,
              progressBase:
                caseUpdatePlan.action === "update" ? 0.5 : 0.09,
              progressSpan: 0.06,
              onStep: ({ step, route }) => {
                if (step === "version-check") {
                  setSessionProgress(
                    caseUpdatePlan.action === "update" ? 0.5 : 0.09,
                    `Checking ${route} installed version before reset`,
                  );
                } else if (step === "clean-reset") {
                  setAutomaticStatus(
                    "Resetting both temples into a clean starting state…",
                  );
                  setSessionProgress(
                    caseUpdatePlan.action === "update" ? 0.52 : 0.11,
                    "Resetting both temples before firmware planning",
                  );
                }
              },
            });
          const {
            initialVersions,
            observedTempleVersions,
            changedAcrossReset,
            verifiedTempleReadiness: templeReadiness,
          } = templePreparation;
          const observedAt = new Date().toISOString();
          setRecheckReport(templeReadiness);
          setPogoResults(
            Object.fromEntries(
              ["right", "left"].map((route) => [
                route,
                {
                  version: {
                    operation: "version",
                    route,
                    decoded: {
                      kind: "version",
                      firmwareVersion:
                        observedTempleVersions[route].firmwareVersion,
                      hardwareRevision:
                        observedTempleVersions[route].hardwareRevision,
                    },
                    transportProof: {
                      restoredMask:
                        templeReadiness.versions[route]
                          .yhmRestoreVerified
                          ? 0x3ff
                          : null,
                    },
                    observedAt,
                  },
                },
              ]),
            ),
          );
          fresh = {
            ...fresh,
            console: {
              ...fresh.console,
              ...templeReadiness,
              telemetry: templeReadiness.telemetry,
            },
          };
          setReport(fresh);
          addLog(
            `Smart Glasses read-only version check passed · right ${initialVersions.right.firmwareVersion}/hardware ${initialVersions.right.hardwareRevision} · left ${initialVersions.left.firmwareVersion}/hardware ${initialVersions.left.hardwareRevision}.`,
            "success",
          );
          addLog(
            `Clean-start DEB0 passed · right ${observedTempleVersions.right.firmwareVersion}/hardware ${observedTempleVersions.right.hardwareRevision} · left ${observedTempleVersions.left.firmwareVersion}/hardware ${observedTempleVersions.left.hardwareRevision} · reset attempt ${templeReadiness.resetAttempts.length}/2.`,
            "success",
          );
          if (changedAcrossReset.length > 0) {
            addLog(
              `Temple identity changed across the clean-start reset on ${changedAcrossReset.join(" + ")}; automatic USB recovery will plan from the fresh post-reset identity.`,
              "warn",
            );
          }

          setSessionProgress(
            caseUpdatePlan.action === "update" ? 0.57 : 0.16,
            "Loading and validating selected Smart Glasses firmware",
          );
          const targetFirmware = acceptPreparedFirmware(
            caseUpdateFirmware?.catalogRelease?.id === release.id
              ? caseUpdateFirmware
              : await fetchCatalogFirmware(release),
          );
          setSessionProgress(
            0.13,
            "Selecting the complete pinned official transfer",
          );

          const planInputs = {
            installMode: automaticInstallMode,
            targetFirmware,
            installedProvenance,
            differenceSourceFirmware: null,
            differencePlan: null,
            initialTempleVersions: initialVersions,
            observedTempleVersions,
            verifiedTempleReadiness: templeReadiness,
          };
          const execution = await executeAutomaticApply({
            session,
            ...planInputs,
            onPlan: (applyPlan) => {
              addLog(
                `Automatic ${automaticInstallMode} plan accepted · ${applyPlan.reason}`,
                "success",
              );
              if (applyPlan.action === "verify-only") {
                setSessionProgress(
                  0.72,
                  "Target already proven; resetting both temples",
                );
              } else {
                if (
                  applyPlan.sourceProofMode ===
                  "live-compatible-pair-preflight"
                ) {
                  setSessionProgress(
                    0.16,
                    "Validating live 2.2.6.10/hardware-5 compatibility before each temple START",
                  );
                } else if (applyPlan.flashMode === "complete") {
                  setSessionProgress(
                    0.16,
                    "Using the complete pinned target main for this version change",
                  );
                }
                setAutomaticStatus(
                  `${automaticInstallMode === "update" ? "Updating" : "Restoring"} both temples automatically…`,
                );
              }
            },
            onRecovery: (recovery) => {
              if (
                recovery.trigger !== "source-preflight-mismatch"
              ) {
                addLog(
                  `Differential transfer reached FINISH, but ${recovery.failedRoutes.join(" + ")} did not return the expected target liveness. Case-route cleanup and the prior reset proof are complete; Automatic Update will require one fresh bilateral recovery reset before switching to the complete pinned target main.`,
                  "warn",
                );
              } else {
                addLog(
                  `Differential preflight observed ${recovery.observedVersion}/hardware 5 before START. No firmware bytes were accepted and cleanup is verified; Automatic Update will require one fresh bilateral recovery reset before switching to the complete pinned target main.`,
                  "warn",
                );
              }
              setSessionProgress(
                0.16,
                "Resetting both temples before complete-image fallback",
              );
              setAutomaticStatus(
                "Differential happy path failed safely; resetting before the complete pinned target main…",
              );
            },
          });

          if (execution.action === "verify-only") {
            const result = execution.result;
            setRecheckReport(result);
            setReport({
              ...fresh,
              console: {
                ...fresh.console,
                ...result,
                telemetry: result.telemetry,
              },
            });
            setSessionProgress(1, "Reset and bilateral liveness verified");
            setAutomaticStatus(
              "Already up to date · both temples reset and verified.",
            );
            return execution;
          }

          const audit = execution.audit;
          setTempleFlashAudit(audit);
          absorbTempleFlashVersions(audit);
          recordInstalledProvenance(
            audit,
            fresh.console?.serialNumber,
            fresh.console?.identifier,
          );
          recordDeviceRun(
            "automatic-apply",
            audit,
            audit?.outcome ?? "success",
          );
          setAutomaticStatus(
            `${automaticInstallMode === "update" ? "Update" : "Restore"} complete · both temples reset and verified.`,
          );
          addLog(
            `Automatic ${automaticInstallMode} completed on right + left${execution.initialPlan ? " after safe differential-to-complete fallback" : ""} with FINISH, route restoration, final DEB0 reset, contacts, and application liveness verified.`,
            "success",
          );
          return execution;
        } catch (caught) {
          if (caught?.audit) {
            setTempleFlashAudit(caught.audit);
            absorbTempleFlashVersions(caught.audit);
            recordInstalledProvenance(
              caught.audit,
              report?.console?.serialNumber,
              report?.console?.identifier,
            );
            recordDeviceRun(
              "automatic-apply",
              caught.audit,
              "failed_or_uncertain",
            );
          }
          const failure = describeAutomaticApplyFailure(caught);
          setAutomaticStatus(failure.message);
          if (failure.directBluetoothRecommended) {
            setBleStatus(failure.message);
            caught.operationMessage = failure.message;
          }
          throw caught;
        }
      },
      { total: automaticCaseUpdate ? 22 : 16 },
    );
  };

  const probeBluetoothApplications = async () =>
    run("bluetooth-probe", async () => {
      setSessionProgress(0.1, "Checking previously authorized G2 Bluetooth handles");
      const result = await probeAuthorizedG2BleDevices({ devices: bleDevices });
      setSessionProgress(1, "Bluetooth Application-service check complete");
      setBleStatus(
        result.bothApplicationsReachable
          ? "Bluetooth check passed · both G2 Application services are reachable from this computer."
          : result.chooserRequired
            ? "Bluetooth check needs the person at the glasses to select both temples once. Remote browser commands cannot open Chrome's protected device chooser."
            : `Bluetooth check reached ${result.reachableSides.join(" + ") || "neither side"}; wake or remove the unavailable temple from the Case and retry.`,
      );
      addLog(
        `Bluetooth Application-mode check · authorized ${result.authorizedSides.join(" + ") || "none"} · reachable ${result.reachableSides.join(" + ") || "none"}.`,
        result.bothApplicationsReachable ? "success" : "warn",
      );
      return result;
    }, { total: 2 });

  const stageFirmware = async () => {
    if (!report || !backup || !firmware?.caseRecoveryEligible) return;
    await run("stage", async () => {
      const result = await getSession().stageCaseImage(
        firmware.caseImage,
        report.optionBytes,
      );
      setStaged({ ...result, firmware });
      addLog(
        `Case ${firmware.caseVersion} is verified in the inactive bank. The active bank is unchanged.`,
        "success",
      );
    });
  };

  const activateFirmware = async () => {
    if (
      !staged ||
      !report ||
      !confirmBackup ||
      confirmText.trim().toUpperCase() !== "ACTIVATE CASE BANK"
    ) {
      return;
    }
    await run("activate", async () => {
      const result = await getSession().activateStagedBank(
        staged.firmware.caseImage,
        report.optionBytes,
      );
      setRecheckReport(result);
      setConfirmText("");
      setConfirmBackup(false);
      addLog("The staged Case bank was activated and the Case restarted.", "success");
      const fresh = await getSession().analyze();
      setReport(fresh);
      setBackup(null);
      setStaged(null);
    });
  };

  const complete = {
    connect: Boolean(report),
    analyze: Boolean(report),
    backup: Boolean(backup),
    firmware: Boolean(
      firmware?.caseRecoveryEligible || firmware?.templeFlashEligible,
    ),
    recover: Boolean(
      staged ||
        templeFlashAudit?.outcome === "success" ||
        recheckReport ||
        Object.keys(pogoResults).length,
    ),
  };
  const telemetry = report?.console?.telemetry;
  const automaticContactAssessment =
    assessAutomaticTempleContacts(telemetry);
  const caseDisplayIdentity =
    report?.console?.serialNumber ??
    report?.console?.identifier ??
    "Identity unavailable";
  const selectedTemplePresent =
    pogoRoute === "left" ? telemetry?.leftPresent : telemetry?.rightPresent;
  const flashRoutesPresent =
    templeFlashRoute === "both"
      ? telemetry?.leftPresent && telemetry?.rightPresent
      : templeFlashRoute === "left"
        ? telemetry?.leftPresent
        : telemetry?.rightPresent;
  const templeFlashReady = Boolean(
    report?.console?.caseVersion === "1.2.57" &&
    firmware?.templeFlashEligible &&
    flashRoutesPresent &&
    templeFlashSeated &&
    templeFlashRisk &&
    templeFlashText.trim().toUpperCase() === "FLASH GLASSES FIRMWARE" &&
    !operation
  );
  const canStage = Boolean(
    report && backup && firmware?.caseRecoveryEligible && !operation,
  );
  const activationReady =
    Boolean(staged) &&
    confirmBackup &&
    confirmText.trim().toUpperCase() === "ACTIVATE CASE BANK";
  const caseReleases = catalog.filter((item) => item.caseRecoveryEligible);
  const latestCaseRelease = findLatestOfficialStockRelease(caseReleases);
  const latestCaseFirmwareRelease = findLatestCaseFirmwareRelease(catalog);
  const selectedRelease = catalog.find((item) => item.id === selectedReleaseId);
  const selectedRingRelease = ringCatalog.find(
    (item) => item.id === selectedRingReleaseId,
  );
  const selectRingApplication = async () => {
    setError("");
    try {
      const device = await requestR1ApplicationDevice();
      setRingApplicationDevice(device);
      setRingReady(false);
      setRingStatus(`${device.name ?? "R1"} selected and ready to enter update mode.`);
      addLog(`Selected R1 application device ${device.name ?? device.id}.`, "success");
    } catch (caught) {
      if (caught?.name === "NotFoundError") return;
      setError(caught?.message ?? String(caught));
    }
  };
  const restartRingForDfu = () =>
    run("ring-dfu-enter", async () => {
      assertPinnedR1Release(selectedRingRelease);
      await enterR1DfuMode(ringApplicationDevice);
      setRingApplicationDevice(null);
      setRingStatus(
        "R1 update mode is advertising. Select the R1 DFU device in the next chooser.",
      );
      addLog("R1 restarted into its signed Nordic Secure DFU bootloader.", "success");
    });
  const selectRingBootloader = async () => {
    setError("");
    try {
      const device = await requestR1DfuDevice();
      setRingDfuDevice(device);
      setRingReady(false);
      setRingStatus(`${device.name ?? "R1 DFU"} selected. Confirm the safety check to update.`);
      addLog(`Selected R1 DFU device ${device.name ?? device.id}.`, "success");
    } catch (caught) {
      if (caught?.name === "NotFoundError") return;
      setError(caught?.message ?? String(caught));
    }
  };
  const flashRingFirmware = () =>
    run("ring-dfu", async () => {
      const release = assertPinnedR1Release(selectedRingRelease);
      setSessionProgress(0.01, "Downloading and verifying the reviewed R1 package");
      const response = await fetchCatalogRelease(release, "R1 firmware archive");
      const prepared = await prepareR1DfuPackage(
        new Uint8Array(await response.arrayBuffer()),
        release,
      );
      addLog(
        `R1 package integrity passed · ${release.version} · ${release.sha256.slice(0, 16)}…`,
        "success",
      );
      await flashR1SecureDfu(ringDfuDevice, prepared, {
        onProgress(fraction, detail) {
          setSessionProgress(0.02 + fraction * 0.98, detail);
        },
      });
      setRingReady(false);
      setRingStatus(
        `R1 ${release.version} transferred successfully. Its authorized DFU identity is retained for guarded recovery; reselect the application after it restarts.`,
      );
    });
  const directBleSupported = g2BleSupported();
  const ringFlashReady = Boolean(
    selectedRingRelease && ringDfuDevice && ringReady && !operation,
  );
  const bleFlashReady = Boolean(
    directBleSupported &&
      selectedRelease &&
      bleDevices.left &&
      bleDevices.right &&
      bleReady &&
      !operation,
  );
  const bluetoothUpdateComplete =
    bleResults?.outcome === "success" &&
    bleResults?.imageSha256 === selectedRelease?.sha256;
  const bluetoothUpdateFailed =
    bleResults?.outcome === "failed_or_partial";
  const bluetoothUpdateAwaitingCase =
    bleResults?.outcome === "awaiting_case_verification";
  const usbRecoveryVisible =
    !directBleSupported ||
    bluetoothUpdateFailed ||
    bluetoothUpdateAwaitingCase ||
    usbRecoveryRequested;
  const caseUpdateNeeded = Boolean(
    report?.console?.caseVersion &&
      latestCaseFirmwareRelease?.caseVersion &&
      report.console.caseVersion !== latestCaseFirmwareRelease.caseVersion,
  );
  const directWebUsbSupported = webUsbSupported();
  // Direct WebUSB bypasses the host serial driver, which on macOS
  // truncates CH340 reads badly enough to need per-block retries. Hardware
  // comparison on one Case: a full 512 KiB backup took ~2 minutes with zero
  // retries over WebUSB against 6m20s and 39 retries over Web Serial, and
  // both produced the identical flash SHA-256.
  const directWebUsbVisible = directWebUsbSupported;
  const directWebSerialSupported = webSerialSupported();
  const serialSupported =
    directWebSerialSupported || directWebUsbVisible;
  const selectedTransport = portRef.current
    ? g2CaseTransportLabel(portRef.current)
    : directWebUsbVisible
      ? "WebUSB (recommended)"
      : directWebSerialSupported
        ? "Web Serial"
        : "Unavailable";
  const deviceAnalytics = useMemo(
    () =>
      report
        ? buildG2DeviceAnalytics({
            report,
            pogoResults,
            recoveryConfig,
            templeFlashAudit,
            bluetoothFlashAudit: bleResults,
          })
        : null,
    [bleResults, report, pogoResults, recoveryConfig, templeFlashAudit],
  );
  const fullGlassesAnalysisComplete = Boolean(
    pogoResults.left?.version &&
    pogoResults.left?.status &&
    pogoResults.right?.version &&
    pogoResults.right?.status,
  );
  const glassesVersionAnalysisComplete = Boolean(
    pogoResults.left?.version?.decoded?.kind === "version" &&
    pogoResults.left.version.decoded.firmwareVersion &&
    pogoResults.right?.version?.decoded?.kind === "version" &&
    pogoResults.right.version.decoded.firmwareVersion,
  );
  const clearConsole = useCallback(() => {
    setLogs([]);
    transcriptRef.current = [];
    if (transcriptPersistTimerRef.current) {
      clearTimeout(transcriptPersistTimerRef.current);
      transcriptPersistTimerRef.current = null;
    }
    try {
      window.localStorage.removeItem(CONSOLE_TRANSCRIPT_STORAGE_KEY);
    } catch {
      // Storage may be unavailable; nothing to clear in that case.
    }
  }, []);

  const downloadConsoleTranscript = useCallback(() => {
    const text = formatConsoleTranscriptDownload(transcriptRef.current, {
      analytics: deviceAnalytics,
    });
    downloadBlob(
      new Blob([text], { type: "text/plain" }),
      `g2-recovery-${new Date().toISOString().replaceAll(":", "-")}.log`,
    );
  }, [deviceAnalytics]);

  return (
    <div className={cx("app-shell", `is-${interfaceMode}`)}>
      <aside className="sidebar">
        <a
          className="brand"
          href={interfaceMode === "easy" ? "#easy" : "#connect"}
          aria-label="Even Realities WebFlasher home"
        >
          <EvenRealitiesLogo />
          <small>WebFlasher</small>
        </a>
        <div className="sidebar-intro">
          <span className="hardware-label">
            SMART GLASSES · BLUETOOTH PRIMARY · USB RECOVERY
          </span>
          <h1>Recover with precision.<br />Protect every byte.</h1>
          <p>
            A guided, local-only console for the Even Realities G2 Charging Case
            and Smart Glasses.
          </p>
        </div>
        {interfaceMode === "advanced" ? (
          <StepRail
            complete={complete}
            active={activeSection}
          />
        ) : (
          <div className="easy-sidebar-guide" aria-label="Easy Mode workflow">
            <div className={cx(selectedRelease && "is-complete")}>
              <span>01</span>
              <strong>Choose firmware</strong>
            </div>
            <div
              className={cx(
                bleDevices.left && bleDevices.right && "is-complete",
              )}
            >
              <span>02</span>
              <strong>Pair Left + Right</strong>
            </div>
            <div className={cx(bluetoothUpdateComplete && "is-complete")}>
              <span>03</span>
              <strong>Update over Bluetooth</strong>
            </div>
          </div>
        )}
        <div className="sidebar-foot">
          <span
            className={cx(
              "support-dot",
              (interfaceMode === "easy" ? directBleSupported : serialSupported) &&
                "is-supported",
            )}
          />
          <span>
            {interfaceMode === "easy"
              ? directBleSupported
                ? "Chrome Bluetooth ready"
                : "USB recovery available"
              : serialSupported
                ? `${selectedTransport} ready`
                : "Chromium USB access required"}
          </span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-status">
            <span
              className={cx(
                "connection-dot",
                (interfaceMode === "easy"
                  ? bleDevices.left && bleDevices.right
                  : report) && "is-connected",
              )}
            />
            <span>
              {interfaceMode === "easy"
                ? bleDevices.left && bleDevices.right
                  ? "Left + Right paired"
                  : "Bluetooth temples not paired"
                : report
                  ? "Case analyzed"
                  : "No Case connected"}
            </span>
            {operation ? <strong>{progress.detail}</strong> : null}
          </div>
          <div className="topbar-actions">
            <div className="interface-mode-switch" aria-label="Interface mode">
              <button
                type="button"
                className={cx(interfaceMode === "easy" && "is-active")}
                aria-pressed={interfaceMode === "easy"}
                onClick={() => {
                  setInterfaceMode("easy");
                  window.history.replaceState(null, "", "#easy");
                }}
                disabled={Boolean(operation)}
              >
                Easy Mode
              </button>
              <button
                type="button"
                className={cx(interfaceMode === "advanced" && "is-active")}
                aria-pressed={interfaceMode === "advanced"}
                onClick={() => {
                  setInterfaceMode("advanced");
                  window.history.replaceState(null, "", `#${activeSection}`);
                }}
                disabled={Boolean(operation)}
              >
                Advanced Mode
              </button>
            </div>
            <button className="console-trigger" onClick={() => setConsoleOpen(true)}>
              <Icon name="terminal" />
              Console Log
              <span>{transcriptRef.current.length}</span>
            </button>
          </div>
        </header>

        <div className="pane-viewport">
          <OperationError error={error} onDismiss={() => setError("")} />

        <section
          className={cx("easy-mode-pane pane", interfaceMode === "easy" && "is-active")}
          id="easy"
          data-pane="easy"
        >
          <div className="easy-mode-toolbar">
            <div className="eyebrow">Bluetooth Smart Glasses update</div>
            <StatusPill
              tone={
                !directBleSupported
                  ? "warm"
                  : bluetoothUpdateAwaitingCase
                    ? "warm"
                    : bluetoothUpdateComplete ||
                        (bleDevices.left && bleDevices.right)
                      ? "success"
                      : "quiet"
              }
            >
              {!directBleSupported
                ? "Bluetooth unavailable · use USB recovery"
                : bluetoothUpdateAwaitingCase
                  ? "Case verification required"
                : bluetoothUpdateComplete
                  ? "Bluetooth update complete"
                  : bleDevices.left && bleDevices.right
                    ? "Left + Right paired"
                    : "Pair both temples"}
            </StatusPill>
          </div>

          <div className="easy-mode-grid is-bluetooth-primary">
            <article className="easy-action-card easy-firmware-card">
              <div className="easy-step-heading">
                <span>01</span>
                <div>
                  <strong>Choose firmware</strong>
                  <small>Every library image is size- and SHA-256-pinned.</small>
                </div>
              </div>
              <label className="select-label" htmlFor="easy-firmware-version">
                Firmware to install
              </label>
              <select
                id="easy-firmware-version"
                value={selectedReleaseId}
                onChange={(event) => setSelectedReleaseId(event.target.value)}
                disabled={catalogState !== "ready" || Boolean(operation)}
              >
                {catalog.map((release) => (
                  <option value={release.id} key={release.id}>
                    {firmwareReleaseDisplayName(release)}
                  </option>
                ))}
              </select>
              {selectedRelease ? (
                <div className="easy-release-summary">
                  <strong>Official Stock firmware</strong>
                  <span>{formatBytes(selectedRelease.size)}</span>
                  <code>{selectedRelease.sha256.slice(0, 16)}…</code>
                </div>
              ) : null}
            </article>

            <BluetoothRecoveryCard
              variant="primary"
              directBleSupported={directBleSupported}
              operation={operation}
              bleDevices={bleDevices}
              onSelectTemple={selectBleTemple}
              bleReady={bleReady}
              onReadyChange={setBleReady}
              bleFlashReady={bleFlashReady}
              onFlash={flashBleTempleFirmware}
              selectedRelease={selectedRelease}
              bleResults={bleResults}
              bleStatus={bleStatus}
            />

            {usbRecoveryVisible ? (
              <article className="easy-action-card easy-usb-card easy-case-card">
                <div className="easy-step-heading">
                  <span>USB · 01</span>
                  <div>
                    <strong>Select your G2 Case for recovery</strong>
                    <small>
                      Use only when Bluetooth failed, is unavailable, or a
                      temple cannot be reached wirelessly. WebUSB is preferred
                      over the host CH340 serial driver.
                    </small>
                  </div>
                </div>
                <div className="case-transport-actions">
                  <Button
                    onClick={connectAndAnalyze}
                    busy={operation === "analyze"}
                    disabled={!serialSupported || Boolean(operation)}
                  >
                    <Icon name="usb" />
                    {report ? "Choose another Case" : "Select Case"}
                  </Button>
                  {directWebUsbVisible && directWebSerialSupported ? (
                    <Button
                      tone="secondary"
                      onClick={() => connectAndAnalyze("serial")}
                      disabled={Boolean(operation)}
                    >
                      Use Web Serial fallback
                    </Button>
                  ) : null}
                </div>
                <div className={cx("easy-case-result", report && "is-ready")}>
                  <span>{report ? caseDisplayIdentity : "No Case selected"}</span>
                  <strong>
                    {report
                      ? glassesVersionAnalysisComplete
                        ? `L ${pogoResults.left.version.decoded?.firmwareVersion ?? "captured"} · R ${pogoResults.right.version.decoded?.firmwareVersion ?? "captured"}`
                        : `${telemetry?.leftPresent ? "L ready" : "L absent"} · ${telemetry?.rightPresent ? "R ready" : "R absent"}`
                      : "Both temples must be seated"}
                  </strong>
                </div>
              </article>
            ) : null}

            {usbRecoveryVisible ? (
              <article className="easy-action-card easy-apply-card easy-usb-card">
              <div className="easy-step-heading">
                <span>USB · 02</span>
                <div>
                  <strong>Recover automatically over USB</strong>
                  <small>
                    Backup path for inaccessible or non-working Bluetooth
                    devices. No mid-process prompts.
                  </small>
                </div>
              </div>
              <div className="automatic-no-flash">
                <Button
                  tone="secondary"
                  onClick={automaticRecoverWithoutFlash}
                  busy={operation === "automatic-recovery"}
                  disabled={
                    !report ||
                    !telemetry?.leftPresent ||
                    !telemetry?.rightPresent ||
                    Boolean(operation)
                  }
                >
                  Diagnose & recover without flashing
                </Button>
                <small>
                  First checks each running application. If either side is silent,
                  it performs only the bounded bilateral reboot and proves both
                  Application-mode version replies before any firmware is considered.
                </small>
              </div>
              {automaticRecoveryDiagnosis ? (
                <div className="automatic-task-list" aria-live="polite">
                  {["left", "right"].map((side) => {
                    const temple =
                      automaticRecoveryDiagnosis.recoveredTemples?.[side] ??
                      automaticRecoveryDiagnosis.temples?.[side];
                    return (
                      <span key={side}>
                        <Icon name={temple?.state === "application" ? "check" : "scan"} />
                        {side}: {temple?.state ?? "unknown"}
                        {temple?.firmwareVersion
                          ? ` · ${temple.firmwareVersion}/hardware ${temple.hardwareRevision}`
                          : ""}
                      </span>
                    );
                  })}
                  <span>
                    <Icon name="check" /> Firmware bytes sent: {automaticRecoveryDiagnosis.firmwareBytesTransmitted ?? 0}
                  </span>
                  {automaticRecoveryDiagnosis.bluetooth ? (
                    <span>
                      <Icon name={automaticRecoveryDiagnosis.bluetooth.bothApplicationsReachable ? "check" : "scan"} />
                      Bluetooth Application service: {automaticRecoveryDiagnosis.bluetooth.bothApplicationsReachable
                        ? "left + right reachable"
                        : automaticRecoveryDiagnosis.bluetooth.chooserRequired
                          ? "local pairing required"
                          : `${automaticRecoveryDiagnosis.bluetooth.reachableSides.join(" + ") || "not reachable"}`}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <hr className="automatic-divider" />
              <InstallModeSelector
                idPrefix="easy"
                value={automaticInstallMode}
                onChange={setAutomaticInstallMode}
                disabled={Boolean(operation)}
              />
              <AutomaticCaseUpdateOption
                idPrefix="easy"
                checked={automaticCaseUpdate}
                onChange={setAutomaticCaseUpdate}
                disabled={Boolean(operation)}
                currentVersion={report?.console?.caseVersion}
                targetVersion={latestCaseFirmwareRelease?.caseVersion}
              />
              <div className="automatic-task-list">
                <span>
                  <Icon name="check" />
                  {automaticCaseUpdate
                    ? "Update + verify the Case first when needed"
                    : "Require the latest Case + fresh contact preflight"}
                </span>
                <span><Icon name="check" /> Hash and component validation</span>
                <span><Icon name="check" /> Version check → clean DEB0 reset</span>
                <span>
                  <Icon name="check" />
                  {automaticInstallMode === "update"
                    ? "Skip target-matching temples → component-level delta when eligible"
                    : "Complete right + left restore"}
                </span>
                <span><Icon name="check" /> Boot + bilateral liveness proof</span>
              </div>
              <Button
                tone="secondary"
                onClick={previewAutomaticUsbTransfer}
                busy={operation === "automatic-plan"}
                disabled={
                  !report ||
                  !selectedRelease ||
                  !glassesVersionAnalysisComplete ||
                  Boolean(operation)
                }
              >
                Preview USB transfer · no firmware write
              </Button>
              {automaticTransferPreview ? (
                <div className="automatic-task-list automatic-transfer-preview" aria-live="polite">
                  <span>
                    <Icon name="scan" /> Routes: {automaticTransferPreview.routes.join(" + ") || "none"}
                    {automaticTransferPreview.skippedRoutes.length
                      ? ` · skipped ${automaticTransferPreview.skippedRoutes.join(" + ")}`
                      : ""}
                  </span>
                  <span>
                    <Icon name="check" /> Planned firmware bytes on USB: {formatBytes(automaticTransferPreview.firmwareBytes)}
                  </span>
                  {automaticTransferPreview.semanticChangedBytes != null ? (
                    <span>
                      <Icon name="scan" /> Known source-byte differences: {formatBytes(automaticTransferPreview.semanticChangedBytes)}
                    </span>
                  ) : null}
                  <small>{automaticTransferPreview.protocolBoundary}</small>
                </div>
              ) : null}
              <Button
                className="automatic-apply-button"
                onClick={automaticApply}
                busy={operation === "automatic-apply"}
                disabled={
                  !report ||
                  !selectedRelease ||
                  !telemetry?.leftPresent ||
                  !telemetry?.rightPresent ||
                  Boolean(operation)
                }
              >
                Recover{" "}
                {automaticInstallMode === "update" ? "with update" : "fully"}{" "}
                over USB
              </Button>
              <div className="automatic-status" role="status">
                <span
                  className={cx(
                    "tiny-dot",
                    templeFlashAudit?.outcome === "success"
                      ? "tiny-dot-success"
                      : "",
                  )}
                />
                <span>{automaticStatus}</span>
              </div>
              {automaticInstallMode === "update" ? (
                <small className="automatic-boundary">
                  Update writes the complete pinned target main for cross-version or
                  unknown-source installs, but now skips any temple already returning
                  the selected target version in a fresh hardware-5 Application reply.
                  The running-temple protocol requires the complete Apollo main because
                  DATA has no destination offset. If that transfer reaches
                  FINISH but target boot/liveness fails,
                  Update resets both temples and starts the complete image only when
                  Case cleanup and bilateral application reachability are proven.
                </small>
              ) : null}
              </article>
            ) : null}
          </div>
          <article className="ring-update-panel" id="ring-update">
            <div className="ring-update-copy">
              <div className="eyebrow">R1 Ring firmware update</div>
              <h3>Update the R1 with its signed Nordic package</h3>
              <p>
                Keep the ring charged and close to this computer. The archive,
                signed init packet, and application image are SHA-256 verified
                before the ring receives firmware bytes.
              </p>
              <label className="select-label" htmlFor="ring-firmware-version">
                Firmware to install
              </label>
              <select
                id="ring-firmware-version"
                value={selectedRingReleaseId}
                onChange={(event) => setSelectedRingReleaseId(event.target.value)}
                disabled={catalogState !== "ready" || Boolean(operation)}
              >
                {ringCatalog.map((release) => (
                  <option value={release.id} key={release.id}>
                    {release.displayName ?? `Official R1 ${release.version}`}
                  </option>
                ))}
              </select>
              {selectedRingRelease ? (
                <div className="easy-release-summary">
                  <strong>{selectedRingRelease.displayName}</strong>
                  <span>{formatBytes(selectedRingRelease.size)}</span>
                  <code>{selectedRingRelease.sha256.slice(0, 16)}…</code>
                </div>
              ) : (
                <div className="automatic-status">R1 catalog unavailable.</div>
              )}
            </div>
            <div className="ring-update-steps">
              <div className="ring-device-actions">
                <Button
                  tone="secondary"
                  onClick={selectRingApplication}
                  disabled={!navigator.bluetooth || Boolean(operation)}
                >
                  {ringApplicationDevice
                    ? `R1 · ${ringApplicationDevice.name ?? "selected"}`
                    : "1. Select connected R1"}
                </Button>
                <Button
                  tone="secondary"
                  onClick={restartRingForDfu}
                  busy={operation === "ring-dfu-enter"}
                  disabled={!ringApplicationDevice || !selectedRingRelease || Boolean(operation)}
                >
                  2. Restart in update mode
                </Button>
                <Button
                  tone="secondary"
                  onClick={selectRingBootloader}
                  disabled={!navigator.bluetooth || Boolean(operation)}
                >
                  {ringDfuDevice
                    ? `DFU · ${ringDfuDevice.name ?? "selected"}`
                    : "3. Select R1 DFU device"}
                </Button>
              </div>
              <label className="ble-ready-confirm">
                <input
                  type="checkbox"
                  checked={ringReady}
                  onChange={(event) => setRingReady(event.target.checked)}
                  disabled={!ringDfuDevice || Boolean(operation)}
                />
                <span>
                  The ring is charged, will stay nearby, and this tab will stay
                  open and visible until the update finishes.
                </span>
              </label>
              <Button
                className="ring-update-start"
                onClick={flashRingFirmware}
                busy={operation === "ring-dfu"}
                disabled={!ringFlashReady}
              >
                Update R1 to {selectedRingRelease?.version ?? "reviewed firmware"}
              </Button>
              <div className="automatic-status" role="status" aria-live="polite">
                <span className={cx("tiny-dot", ringDfuDevice && "tiny-dot-success")} />
                <span>{ringStatus}</span>
              </div>
            </div>
          </article>
          <div className={cx("usb-recovery-toggle", usbRecoveryVisible && "is-open")}>
            <div>
              <strong>
                {usbRecoveryVisible
                  ? "USB backup / recovery"
                  : "Can’t reach one or both temples over Bluetooth?"}
              </strong>
              <span>
                {usbRecoveryVisible
                  ? "These Case-based tools are the fallback for a failed or unavailable Bluetooth update, or for devices that are generally non-working or inaccessible over Bluetooth."
                  : "Reveal the Case-based USB workflow only as a backup or recovery mechanism."}
              </span>
            </div>
            {!usbRecoveryVisible ? (
              <Button
                tone="secondary"
                onClick={() => setUsbRecoveryRequested(true)}
                disabled={Boolean(operation)}
              >
                Open USB recovery
              </Button>
            ) : directBleSupported && !bluetoothUpdateFailed ? (
              <Button
                tone="ghost"
                onClick={() => setUsbRecoveryRequested(false)}
                disabled={Boolean(operation)}
              >
                Hide USB recovery
              </Button>
            ) : null}
          </div>
        </section>

        <section
          className={cx(
            "hero pane",
            interfaceMode === "advanced" &&
              activeSection === "connect" &&
              "is-active",
          )}
          id="connect"
          data-pane="connect"
        >
          <div className="hero-copy">
            <div className="eyebrow">
              01 · Connect · G2 Charging Case &amp; Smart Glasses
            </div>
            <h2>
              Restore with precision.
              <br />
              Zero compromise.
            </h2>
            <p>
              Inspect the factory console and both STM32 banks, capture a complete
              device-specific Case backup, snapshot both Smart Glasses temples,
              then stage and verify a recovery image before changing the active bank.
            </p>
            <div className="hero-actions">
              <Button
                onClick={connectAndAnalyze}
                busy={operation === "analyze"}
                disabled={!serialSupported || Boolean(operation)}
              >
                <Icon name="usb" />
                {report ? "Choose another Case" : "Connect & analyze Case"}
              </Button>
              {directWebUsbVisible && directWebSerialSupported ? (
                <Button
                  tone="secondary"
                  onClick={() => connectAndAnalyze("serial")}
                  disabled={Boolean(operation)}
                >
                  Use Web Serial fallback
                </Button>
              ) : null}
              {report ? (
                <Button
                  tone="secondary"
                  onClick={reanalyze}
                  disabled={Boolean(operation)}
                >
                  Refresh analysis
                </Button>
              ) : null}
            </div>
            {!serialSupported ? (
              <p className="browser-note">
                This browser exposes neither Web Serial nor WebUSB. Open this page
                in a current Chromium-based browser.
              </p>
            ) : null}
          </div>
          <div className="hero-visual">
            <img
              className="hero-product-image"
              src={webflasherAssetUrl("even-g2-case-grey.png")}
              alt="Even Realities G2 Smart Glasses in their Charging Case"
              width="1501"
              height="1501"
              fetchPriority="high"
              draggable="false"
            />
            <div className="visual-callout callout-port">
              <span>USB-C</span>
              <strong>1A86:7523</strong>
            </div>
            <div className="visual-callout callout-mcu">
              <span>CASE MCU</span>
              <strong>STM32 · DUAL BANK</strong>
            </div>
          </div>
        </section>

        <section
          className={cx(
            "content-section pane",
            interfaceMode === "advanced" &&
              activeSection === "analyze" &&
              "is-active",
          )}
          id="analyze"
          data-pane="analyze"
        >
          <SectionHeading
            eyebrow="02 · Analyze"
            title="Analyze the Case and Smart Glasses"
            copy="Separate the Case factory shell, STM32 banks, and option bytes from left/right temple data captured through the Case pogo routes."
            action={
              report ? (
                <StatusPill tone="success">
                  <Icon name="check" /> Case pass complete
                </StatusPill>
              ) : (
                <StatusPill>Waiting for Case</StatusPill>
              )
            }
          />
          <div className="analysis-scope-tabs" role="tablist" aria-label="Analyze device scope">
            {[
              ["case", "Charging Case", "Factory shell + STM32"],
              ["glasses", "Smart Glasses", "Left + right temples"],
              ["evidence", "Shell & evidence", "Frames + recovery record"],
            ].map(([key, label, detail]) => (
              <button
                type="button"
                role="tab"
                aria-selected={analysisView === key}
                className={cx(analysisView === key && "is-active")}
                onClick={() => setAnalysisView(key)}
                key={key}
              >
                <Icon name={key === "case" ? "case" : key === "glasses" ? "glasses" : "terminal"} />
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
              </button>
            ))}
          </div>
          {report ? (
            <>
              {analysisView === "case" ? (
                <>
              <div className="status-grid">
                <article className="status-card status-card-primary">
                  <div className="card-topline">
                    <Icon name="case" />
                    <span>Case</span>
                    <StatusPill tone={telemetry?.open ? "warm" : "success"}>
                      {telemetry ? (telemetry.open ? "Lid open" : "Lid closed") : "Unknown"}
                    </StatusPill>
                  </div>
                  <div className="metric-large">
                    {telemetry?.percent ?? "—"}<span>%</span>
                  </div>
                  <div className="metric-caption">
                    {telemetry?.voltage ? `${telemetry.voltage} mV · ` : ""}
                    Firmware {report.console.caseVersion ?? report.banks.active.version}
                  </div>
                </article>
                <article className="status-card">
                  <div className="card-topline">
                    <Icon name="glasses" />
                    <span>Glasses present</span>
                  </div>
                  <div className="temple-pair">
                    <div className={cx(telemetry?.leftPresent && "is-present")}>
                      <span>L</span>
                      <strong>{telemetry?.leftPresent ? "Detected" : "Absent"}</strong>
                    </div>
                    <div className={cx(telemetry?.rightPresent && "is-present")}>
                      <span>R</span>
                      <strong>{telemetry?.rightPresent ? "Detected" : "Absent"}</strong>
                    </div>
                  </div>
                  <div className="metric-caption">
                    Live Case-link telemetry, not simple switches
                  </div>
                </article>
                <article className="status-card">
                  <div className="card-topline">
                    <Icon name="usb" />
                    <span>Power + USB</span>
                  </div>
                  <div className="compact-metrics">
                    <div><span>USB</span><strong>{telemetry?.usbPresent ? "Present" : "Not reported"}</strong></div>
                    <div><span>Current</span><strong>{telemetry?.current ?? "—"}</strong></div>
                    <div><span>Temperature</span><strong>{telemetry?.temperature ?? "—"}</strong></div>
                  </div>
                </article>
              </div>

              <div className="analysis-columns">
                <article className="panel">
                  <div className="panel-header">
                    <div>
                      <div className="eyebrow">Identity</div>
                      <h3>Identifiers</h3>
                    </div>
                    <StatusPill tone="quiet">Stays in browser</StatusPill>
                  </div>
                  <div className="field-grid">
                    <Field
                      label="Case MCU device ID"
                      value={report.console.serialNumber}
                      detail={
                        connectedDevice.case.uidDecoded
                          ? `STM32 96-bit ID · lot ${connectedDevice.case.uidDecoded.lotAscii} · wafer ${connectedDevice.case.uidDecoded.waferNumber}. Identifies this unit, not its hardware revision.`
                          : "Silicon identifier, not an Even Realities product serial"
                      }
                    />
                    <Field label="Factory identifier" value={report.console.identifier} />
                    <Field
                      label="USB bridge revision"
                      value={connectedDevice.transport.usbBridgeRevision}
                      detail={
                        connectedDevice.transport.usbBridgeRevision
                          ? "CH340 silicon revision, read over WebUSB"
                          : "Only readable over direct WebUSB"
                      }
                    />
                    <Field
                      label="Frame-fit variant"
                      value="Not reported by device"
                      detail="Frame A/B is not inferred from the factory identifier"
                    />
                  </div>
                  <div className="device-label-block">
                    <label className="device-label-field">
                      <span>This unit</span>
                      <input
                        type="text"
                        value={deviceLabelDraft}
                        placeholder="e.g. Brown case · Frame B · daily pair"
                        maxLength={120}
                        onChange={(event) =>
                          setDeviceLabelDraft(event.target.value)
                        }
                        onBlur={() => {
                          writeDeviceLabel(
                            connectedDevice.deviceKey,
                            deviceLabelDraft,
                          );
                        }}
                      />
                    </label>
                    <small>
                      Case colour and frame fit are not readable from the
                      device. Recording them here attaches them to this Case in
                      every later audit and history entry.
                    </small>
                    {templeFirmwareRegressions.length ? (
                      <small
                        className="device-history-regression"
                        role="status"
                      >
                        {templeFirmwareRegressions.map((finding) => (
                          <span key={finding.route}>
                            The {finding.route} temple now reports{" "}
                            {finding.observedFirmware}, older than the{" "}
                            {finding.previousFirmware} this browser last
                            recorded on this Case
                            {finding.previousRecordedAt
                              ? ` on ${new Date(finding.previousRecordedAt).toLocaleString()}`
                              : ""}
                            . Confirm whether these are the same temples before
                            treating it as an image that did not stay installed.
                          </span>
                        ))}
                      </small>
                    ) : null}
                    {connectedDeviceHistory.operations > 0 ? (
                      <small className="device-history-summary">
                        {connectedDeviceHistory.operations} recorded operation
                        {connectedDeviceHistory.operations === 1 ? "" : "s"} on
                        this Case
                        {Object.entries(connectedDeviceHistory.routes).map(
                          ([route, stats]) => (
                            <span key={route}>
                              {" · "}
                              {route}: {stats.successes}/{stats.attempts}{" "}
                              clean
                              {stats.dataRejections
                                ? `, ${stats.dataRejections} rejection${stats.dataRejections === 1 ? "" : "s"}`
                                : ""}
                              {stats.activationResets
                                ? `, ${stats.activationResets} activation reset${stats.activationResets === 1 ? "" : "s"}`
                                : ""}
                              {Number.isInteger(stats.typicalPacingLevel)
                                ? `, pacing L${stats.typicalPacingLevel}`
                                : ""}
                            </span>
                          ),
                        )}
                      </small>
                    ) : null}
                    <Field
                      label="Electronic profile"
                      value={
                        deviceAnalytics.chargingCase.variantAssessment
                          .matchesReviewedElectronicProfile
                          ? "Reviewed profile"
                          : "Unrecognized"
                      }
                      detail="USB, STM32 ROM, and dual-bank signature"
                    />
                    <Field
                      label="USB bridge"
                      value={`${hex(report.usb.vendorId ?? 0, 4)}:${hex(report.usb.productId ?? 0, 4).slice(2)}`}
                      detail="WCH CH340/CH341 family"
                    />
                    <Field
                      label="STM32 product ID"
                      value={hex(report.rom.productId, 4)}
                      detail={`ROM protocol ${(report.rom.protocolVersion >> 4)}.${report.rom.protocolVersion & 0xf}`}
                    />
                  </div>
                </article>

                <article className="panel bank-panel">
                  <div className="panel-header">
                    <div>
                      <div className="eyebrow">Dual bank</div>
                      <h3>Case firmware map</h3>
                    </div>
                    <StatusPill tone="success">
                      RDP {hex(report.options.rdp, 2)}
                    </StatusPill>
                  </div>
                  <div className="bank-map">
                    <div className="bank-row is-active">
                      <div className="bank-index">A</div>
                      <div>
                        <span>ACTIVE · PHYSICAL BANK {report.banks.active.physicalBank}</span>
                        <strong>{report.banks.active.version}</strong>
                      </div>
                      <code>{hex(report.banks.active.aliasAddress)}</code>
                    </div>
                    <div className="bank-connector"><span /></div>
                    <div className="bank-row">
                      <div className="bank-index">B</div>
                      <div>
                        <span>FALLBACK · PHYSICAL BANK {report.banks.inactive.physicalBank}</span>
                        <strong>{report.banks.inactive.version}</strong>
                      </div>
                      <code>{hex(report.banks.inactive.aliasAddress)}</code>
                    </div>
                  </div>
                  <div className="option-summary">
                    <span>DUAL_BANK {report.options.dualBank ? "ON" : "OFF"}</span>
                    <span>nSWAP_BANK {report.options.swapBank ? "1" : "0"}</span>
                    <span>USER {hex(report.options.userWord)}</span>
                  </div>
                </article>
              </div>
                </>
              ) : null}
              {analysisView === "glasses" ? (
                <div className="glasses-analysis">
                  <div className="analysis-action-panel">
                    <div>
                      <div className="eyebrow">Read-only paired analysis</div>
                      <h3>Query both running temples</h3>
                      <p>
                        Captures version, hardware revision, battery, voltage, raw
                        frames, and exact route-restoration proof for left and right.
                        Presence alone comes from the Case; every other value requires
                        a checksum-valid reply from the Glasses application.
                      </p>
                    </div>
                    <label className="confirm-check">
                      <input
                        type="checkbox"
                        checked={glassesAnalyzeConfirm}
                        onChange={(event) =>
                          setGlassesAnalyzeConfirm(event.target.checked)
                        }
                        disabled={
                          !telemetry?.leftPresent ||
                          !telemetry?.rightPresent ||
                          Boolean(operation)
                        }
                      />
                      <span>
                        Both temples are seated; keep the Case and USB cable still.
                      </span>
                    </label>
                    <Button
                      onClick={analyzeSmartGlasses}
                      busy={operation === "glasses-analyze"}
                      disabled={
                        !telemetry?.leftPresent ||
                        !telemetry?.rightPresent ||
                        !glassesAnalyzeConfirm ||
                        Boolean(operation)
                      }
                    >
                      <Icon name="scan" />
                      {fullGlassesAnalysisComplete
                        ? "Refresh both Glasses"
                        : "Analyze both Smart Glasses"}
                    </Button>
                    {!telemetry?.leftPresent || !telemetry?.rightPresent ? (
                      <small>
                        Seat both temples, then refresh the Charging Case analysis.
                      </small>
                    ) : null}
                  </div>
                  <div className="glasses-analysis-grid">
                    <SmartGlassesAnalyticsCard
                      label="Left"
                      analytics={deviceAnalytics.smartGlasses.left}
                      probeFailure={pogoResults.left?.lastProbeFailure ?? null}
                    />
                    <SmartGlassesAnalyticsCard
                      label="Right"
                      analytics={deviceAnalytics.smartGlasses.right}
                      probeFailure={pogoResults.right?.lastProbeFailure ?? null}
                    />
                  </div>
                  <div className={cx(
                    "glasses-recovery-readiness",
                    deviceAnalytics.smartGlasses.recoveryAssessment.bothRoutesReady &&
                      "is-ready",
                  )}>
                    <Icon
                      name={
                        deviceAnalytics.smartGlasses.recoveryAssessment.bothRoutesReady
                          ? "check"
                          : "warning"
                      }
                    />
                    <div>
                      <strong>
                        {deviceAnalytics.smartGlasses.recoveryAssessment.bothRoutesReady
                          ? "Both routes match the validated recovery envelope"
                          : "Recovery readiness is not yet proven for both routes"}
                      </strong>
                      <span>
                        Requires Case 1.2.57, a checksum-valid running
                        hardware-5 application on each temple, and both
                        contacts responsive. The Apollo bootloader is never transferred.
                      </span>
                    </div>
                    <a href="#smart-glasses-recovery">Open Smart Glasses recovery</a>
                  </div>
                </div>
              ) : null}
              {analysisView === "evidence" ? (
                <ShellEvidenceView
                  analytics={deviceAnalytics}
                  onDownload={() =>
                    downloadBlob(
                      new Blob([`${JSON.stringify(deviceAnalytics, null, 2)}\n`], {
                        type: "application/json",
                      }),
                      `g2-case-glasses-analytics-${new Date()
                        .toISOString()
                        .replaceAll(":", "-")}.json`,
                    )
                  }
                />
              ) : null}
            </>
          ) : (
            <div className="empty-panel">
              <Icon name="scan" />
              <strong>Connect the Case to populate this analysis.</strong>
              <span>The first pass does not erase, write, or change option bytes.</span>
            </div>
          )}
        </section>

        <section
          className={cx(
            "content-section pane",
            interfaceMode === "advanced" &&
              activeSection === "backup" &&
              "is-active",
          )}
          id="backup"
          data-pane="backup"
        >
          <SectionHeading
            eyebrow="03 · Preserve"
            title="Back up the Case and Smart Glasses"
            copy="Captures the full Case memory, verifies both seated temples, and embeds the matching digest-pinned official Glasses recovery bundle into one local file."
            action={
              backup ? (
                <StatusPill tone="success"><Icon name="check" /> Downloaded</StatusPill>
              ) : null
            }
          />
          <div className="preserve-layout">
            <article className="backup-card">
              <div className="backup-graphic" aria-hidden="true">
                <div><span>ACTIVE</span><b>256 KiB</b></div>
                <div><span>FALLBACK</span><b>256 KiB</b></div>
                <div className="glasses-block">
                  <span>SMART GLASSES</span>
                  <b>LEFT + RIGHT · MATCHED RECOVERY BUNDLE</b>
                </div>
                <i>+</i>
                <div className="option-block"><span>OPTIONS</span><b>128 B</b></div>
              </div>
              <div>
                <h3>Complete G2 recovery set</h3>
                <p>
                  The Case is preserved byte-for-byte. Each running temple contributes
                  a checksum-validated version snapshot, and the matching official
                  Glasses firmware is embedded for recovery. Installed Apollo memory
                  cannot be read through the Case, so the Glasses portion is not an
                  MRAM, key, pairing, or calibration dump.
                </p>
                <Button
                  onClick={createBackup}
                  busy={operation === "backup"}
                  disabled={
                    !report ||
                    catalogState !== "ready" ||
                    Boolean(operation)
                  }
                >
                  <Icon name="backup" />
                  {backup
                    ? "Download a fresh recovery set"
                    : "Back up Case + Smart Glasses"}
                </Button>
              </div>
            </article>
            <div className="backup-checklist">
              <div><Icon name="check" /><span><strong>Exact Case acquisition</strong>512 KiB flash + 128-byte options</span></div>
              <div><Icon name="check" /><span><strong>Both temples captured</strong>Version, hardware, raw frame + route proof</span></div>
              <div><Icon name="check" /><span><strong>Glasses recovery image</strong>Matching official bundle, size + SHA-256 validated</span></div>
              <div><Icon name="check" /><span><strong>Application restored</strong>Normal Case console after every read</span></div>
              {backup ? (
                <div className="backup-digest">
                  <span>CASE FLASH SHA-256</span>
                  <code>{backup.flashSha256}</code>
                  <span>SMART GLASSES BUNDLE SHA-256</span>
                  <code>{backup.recoveryRelease.sha256}</code>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section
          className={cx(
            "content-section pane",
            interfaceMode === "advanced" &&
              activeSection === "firmware" &&
              "is-active",
          )}
          id="firmware"
          data-pane="firmware"
        >
          <SectionHeading
            eyebrow="04 · Choose image"
            title="The repository's verified library, or your own file"
            copy="Every entry in the library is an official, hash-pinned image that is re-validated locally before any write is enabled. You can also supply your own file for structural inspection."
            action={
              catalogState === "ready" ? (
                <StatusPill tone="quiet">
                  {catalog.length} verified {catalog.length === 1 ? "build" : "builds"}
                </StatusPill>
              ) : (
                <StatusPill tone="warm">Library {catalogState}</StatusPill>
              )
            }
          />
          <div className="firmware-layout">
            <article className="panel firmware-picker">
              <div className="source-tabs">
                <span className="is-active">Verified firmware library</span>
              </div>
              <label className="select-label" htmlFor="firmware-version">
                G2 firmware artifact
              </label>
              <div className="select-row">
                <select
                  id="firmware-version"
                  value={selectedReleaseId}
                  onChange={(event) => setSelectedReleaseId(event.target.value)}
                  disabled={catalogState !== "ready" || Boolean(operation)}
                >
                  {catalog.map((release) => (
                    <option value={release.id} key={release.id}>
                      {release.caseRecoveryEligible
                        ? `Charging Case ${release.caseVersion} · G2 ${release.version}`
                        : firmwareReleaseDisplayName(release)}
                    </option>
                  ))}
                </select>
                <Button
                  onClick={loadMirroredFirmware}
                  busy={operation === "firmware"}
                  disabled={!selectedRelease || Boolean(operation)}
                >
                  Load & validate
                </Button>
              </div>
              {selectedRelease ? (
                <div className="release-meta">
                  <span>
                    {selectedRelease === latestCaseRelease
                        ? "Latest official Stock · default Easy Mode target"
                        : "Earlier Case image"}
                  </span>
                  <span>{formatBytes(selectedRelease.size)}</span>
                  <code>{selectedRelease.sha256.slice(0, 20)}…</code>
                  <a href={webflasherAssetUrl(selectedRelease.url)} download>
                    Source bundle
                  </a>
                  {selectedRelease.patchUrl ? (
                    <a href={webflasherAssetUrl(selectedRelease.patchUrl)} download>
                      Reviewed patch recipe
                    </a>
                  ) : null}
                  {selectedRelease.manifestUrl ? (
                    <a href={webflasherAssetUrl(selectedRelease.manifestUrl)} download>
                      Flash manifest
                    </a>
                  ) : null}
                </div>
              ) : null}
              {usbRecoveryVisible ? (
              <div className="advanced-automatic-apply">
                <div className="advanced-usb-recovery-heading">
                  <div>
                    <div className="eyebrow">USB backup / recovery</div>
                    <strong>Case-based Smart Glasses recovery</strong>
                  </div>
                  {directBleSupported && !bluetoothUpdateFailed ? (
                    <Button
                      tone="ghost"
                      onClick={() => setUsbRecoveryRequested(false)}
                      disabled={Boolean(operation)}
                    >
                      Hide
                    </Button>
                  ) : null}
                </div>
                <InstallModeSelector
                  idPrefix="advanced"
                  value={automaticInstallMode}
                  onChange={setAutomaticInstallMode}
                  disabled={Boolean(operation)}
                />
                <AutomaticCaseUpdateOption
                  idPrefix="advanced"
                  checked={automaticCaseUpdate}
                  onChange={setAutomaticCaseUpdate}
                  disabled={Boolean(operation)}
                  currentVersion={report?.console?.caseVersion}
                  targetVersion={latestCaseFirmwareRelease?.caseVersion}
                />
                <Button
                  tone="secondary"
                  onClick={previewAutomaticUsbTransfer}
                  busy={operation === "automatic-plan"}
                  disabled={
                    !report ||
                    !selectedRelease ||
                    !glassesVersionAnalysisComplete ||
                    Boolean(operation)
                  }
                >
                  Preview USB transfer · no firmware write
                </Button>
                {automaticTransferPreview ? (
                  <div className="automatic-task-list automatic-transfer-preview">
                    <span>
                      Routes: {automaticTransferPreview.routes.join(" + ") || "none"}
                      {automaticTransferPreview.skippedRoutes.length
                        ? ` · skipped ${automaticTransferPreview.skippedRoutes.join(" + ")}`
                        : ""}
                    </span>
                    <span>USB payload: {formatBytes(automaticTransferPreview.firmwareBytes)}</span>
                    {automaticTransferPreview.semanticChangedBytes != null ? (
                      <span>Known source-byte differences: {formatBytes(automaticTransferPreview.semanticChangedBytes)}</span>
                    ) : null}
                    <small>{automaticTransferPreview.protocolBoundary}</small>
                  </div>
                ) : null}
                <Button
                  onClick={automaticApply}
                  busy={operation === "automatic-apply"}
                  disabled={
                    !report ||
                    !selectedRelease ||
                    !telemetry?.leftPresent ||
                    !telemetry?.rightPresent ||
                    Boolean(operation)
                  }
                >
                  Recover{" "}
                  {automaticInstallMode === "update" ? "with update" : "fully"}{" "}
                  over USB
                </Button>
                <small>
                  Backup path for a failed or unavailable Bluetooth update, or
                  for temples that cannot be reached wirelessly. It applies to
                  both temples, right then left, and ends with route cleanup, a
                  bilateral DEB0 reset, contact checks, and application-liveness
                  verification.
                </small>
                <div className="automatic-status" role="status">
                  {automaticStatus}
                </div>
              </div>
              ) : (
                <div className="advanced-usb-recovery-toggle">
                  <div>
                    <strong>Need the Case-based USB recovery path?</strong>
                    <small>
                      Reveal it only if Bluetooth failed or the temples are
                      non-working or inaccessible over Bluetooth.
                    </small>
                  </div>
                  <Button
                    tone="secondary"
                    onClick={() => setUsbRecoveryRequested(true)}
                    disabled={Boolean(operation)}
                  >
                    Open USB recovery
                  </Button>
                </div>
              )}
              <div className="or-divider"><span>or</span></div>
              <label className="upload-zone">
                <input
                  type="file"
                  accept=".bin,.evenota,application/octet-stream"
                  onChange={loadLocalFirmware}
                  disabled={Boolean(operation)}
                />
                <Icon name="file" />
                <span>
                  <strong>Choose a local firmware file</strong>
                  EVENOTA bundle, firmware_box.bin, or validated raw Case image
                </span>
              </label>
            </article>

            <article className={cx("panel selected-firmware", firmware && "has-firmware")}>
              {firmware ? (
                <>
                  <div className="selected-check"><Icon name="check" /></div>
                  <div className="eyebrow">Validated locally</div>
                  <h3>
                    {`Charging Case ${firmware.caseVersion}`}
                  </h3>
                  <p>
                    {firmware.kind === "bundle"
                      ? `${firmware.provenance.label}. The ${firmware.components.length}-component bundle passed outer CRC-32C, Apollo preamble/CRC/vector, Case wrapper, and Case vector checks.`
                      : "Validated standalone Charging-Case image."}
                  </p>
                  <div className="firmware-facts">
                    <Field
                      label="Trust"
                      value={firmware.provenance.label}
                      status={
                        firmware.provenance.trust === "unrecognized"
                          ? null
                          : "success"
                      }
                    />
                    <Field label="Source" value={firmware.fileName} />
                    <Field label="Bundle size" value={formatBytes(firmware.fileSize)} />
                    <Field label="Case payload" value={formatBytes(firmware.caseImage.length)} />
                    {firmware.mainFirmware ? (
                      <>
                        <Field
                          label="Apollo target"
                          value={hex(firmware.mainFirmware.runBase)}
                          detail="Single in-place main application"
                        />
                        <Field
                          label="Apollo image end"
                          value={hex(firmware.mainFirmware.installedImageEnd)}
                          detail={`Below update flag ${hex(0x007fe000)}`}
                        />
                      </>
                    ) : null}
                    <Field label="SHA-256" value={`${firmware.fileSha256.slice(0, 24)}…`} />
                  </div>
                  {firmware.provenance.trust === "unrecognized" &&
                    firmware.kind === "bundle" ? (
                    <div className="firmware-boundary">
                      <strong>Integrity is valid; publisher provenance is unknown.</strong>
                      <span>
                        A self-consistent local bundle is not proof that Even Realities
                        published it. Only its extracted Case image is eligible here.
                      </span>
                    </div>
                  ) : null}
                  {firmware.kind === "bundle" ? (
                    <details>
                      <summary>
                        Show all {firmware.components.length} G2 components
                      </summary>
                      <div className="component-list">
                        {firmware.components.map((component) => (
                          <div
                            className={
                              component.pogoOta.disposition === "omit"
                                ? "is-pogo-omit"
                                : ""
                            }
                            key={component.name}
                          >
                            <span>
                              {component.name} · type {component.typeId}
                              <small>
                                {component.pogoOta.dataRecordCount.toLocaleString()} ×
                                {" "}0x54 · final seq {component.pogoOta.finalSequence}
                              </small>
                              <small className="component-disposition">
                                {component.pogoOta.safetyLabel}
                              </small>
                            </span>
                            <code>{formatBytes(component.payloadSize)}</code>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </>
              ) : (
                <div className="selected-empty">
                  <Icon name="firmware" />
                  <strong>No recovery image selected</strong>
                  <span>Files remain in this browser and are validated before a write is enabled.</span>
                </div>
              )}
            </article>
          </div>
        </section>

        <section
          className={cx(
            "content-section recovery-section pane",
            interfaceMode === "advanced" &&
              activeSection === "recover" &&
              "is-active",
          )}
          id="recover"
          data-pane="recover"
        >
          <SectionHeading
            eyebrow="05 · Recovery Console"
            title="Update Smart Glasses over Bluetooth, with USB recovery when needed"
            copy="Direct Bluetooth is the primary Smart Glasses path and transfers the complete six-component package. Use the Charging Case and Case-to-pogo USB tools below only to recover a failed, inaccessible, or generally non-working device. Read-only probes and recorded transfer evidence sit below."
          />
          <BluetoothRecoveryCard
            variant="advanced"
            directBleSupported={directBleSupported}
            operation={operation}
            bleDevices={bleDevices}
            onSelectTemple={selectBleTemple}
            bleReady={bleReady}
            onReadyChange={setBleReady}
            bleFlashReady={bleFlashReady}
            onFlash={flashBleTempleFirmware}
            selectedRelease={selectedRelease}
            bleResults={bleResults}
            bleStatus={bleStatus}
          />
          <div className="recovery-target-heading">
            <div>
              <div className="eyebrow">USB backup / recovery · Charging Case</div>
              <h3>Dual-bank Case recovery over USB</h3>
              <p>
                The active bank remains untouched while the selected Case image is
                written and byte-for-byte verified in the fallback bank.
              </p>
            </div>
            <StatusPill tone={staged ? "success" : "quiet"}>
              {staged ? "Inactive bank verified" : "Case path"}
            </StatusPill>
          </div>
          <div className="recovery-flow">
            <article
              className={cx(
                "recovery-step",
                report && backup && firmware?.caseRecoveryEligible && "is-ready",
              )}
            >
              <div className="recovery-number">1</div>
              <div>
                <h3>Preflight</h3>
                <ul>
                  <li className={report ? "done" : ""}>Fresh Case analysis</li>
                  <li className={backup ? "done" : ""}>
                    Case + Smart Glasses recovery set downloaded
                  </li>
                  <li className={firmware?.caseRecoveryEligible ? "done" : ""}>
                    Case-recovery image validated
                  </li>
                </ul>
                {firmware && !firmware.caseRecoveryEligible ? (
                  <p className="preflight-blocked">
                    This image is not compatible with Charging Case bank staging.
                  </p>
                ) : null}
              </div>
            </article>
            <article className={cx("recovery-step", staged && "is-complete")}>
              <div className="recovery-number">{staged ? <Icon name="check" /> : "2"}</div>
              <div>
                <h3>Stage inactive bank</h3>
                <p>
                  Erases only the bounded image pages, leaving the active bank and
                  end-of-bank device data untouched.
                </p>
                <Button
                  onClick={stageFirmware}
                  busy={operation === "stage"}
                  disabled={!canStage}
                >
                  <Icon name="bank" />
                  {staged ? "Stage again" : "Stage & verify inactive bank"}
                </Button>
                {staged ? (
                  <div className="stage-proof">
                    <span>READBACK SHA-256</span>
                    <code>{staged.readbackSha256}</code>
                  </div>
                ) : null}
              </div>
            </article>
            <article className={cx("recovery-step recovery-step-danger", staged && "is-ready")}>
              <div className="recovery-number">3</div>
              <div>
                <h3>Activate staged bank</h3>
                <p>
                  This rewrites the full option block with only nSWAP_BANK changed,
                  then resets the Case. The write path is research-derived and has not
                  yet been physically exercised on a sacrificial G2 Case.
                </p>
                <label className="confirm-check">
                  <input
                    type="checkbox"
                    checked={confirmBackup}
                    onChange={(event) => setConfirmBackup(event.target.checked)}
                    disabled={!staged || Boolean(operation)}
                  />
                  <span>I have stored the downloaded G2 recovery set privately.</span>
                </label>
                <label className="confirm-label" htmlFor="activate-confirmation">
                  Type <strong>ACTIVATE CASE BANK</strong>
                </label>
                <input
                  id="activate-confirmation"
                  className="confirm-input"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder="ACTIVATE CASE BANK"
                  autoComplete="off"
                  disabled={!staged || Boolean(operation)}
                />
                <Button
                  tone="danger"
                  onClick={activateFirmware}
                  busy={operation === "activate"}
                  disabled={!activationReady || Boolean(operation)}
                >
                  Activate staged bank & restart
                </Button>
              </div>
            </article>
          </div>
          <div className="smart-glasses-recovery" id="smart-glasses-recovery">
            <div className="smart-glasses-recovery-heading">
              <div>
                <div className="eyebrow">
                  USB backup / recovery · Smart Glasses
                </div>
                <h3>Running-temple recovery through the Case</h3>
                <p>
                  This backup path reinstalls the Apollo main when Bluetooth
                  failed or a temple is not reachable wirelessly. The writer
                  pins the Case SRAM bridge, re-hashes the selected main against
                  its compiled-in allowlist, requires finish and post-reboot
                  replies, restores all ten YHM route registers, confirms Case
                  firmware 1.2.57 returns, and finishes with a dual-temple reset
                  plus contact and version-liveness checks. If START reaches the
                  terminal no-frame boundary, the audit stops wired retries
                  instead of cycling a device whose state is uncertain.
                </p>
              </div>
              <StatusPill tone={firmware?.templeFlashEligible ? "success" : "quiet"}>
                {firmware?.templeFlashTarget
                  ? firmware.templeFlashTarget.label
                  : "Load a library image"}
              </StatusPill>
            </div>
            <div className="smart-glasses-recovery-gate">
              <div className={report?.console?.caseVersion === "1.2.57" ? "done" : ""}>
                <Icon name="check" />
                <span>Case 1.2.57 analyzed</span>
              </div>
              <div className={flashRoutesPresent ? "done" : ""}>
                <Icon name="check" />
                <span>Selected temple route seated</span>
              </div>
              <div className={firmware?.templeFlashEligible ? "done" : ""}>
                <Icon name="check" />
                <span>Pinned Glasses image loaded</span>
              </div>
              <div className={fullGlassesAnalysisComplete ? "done" : ""}>
                <Icon name="check" />
                <span>Version + status evidence captured</span>
              </div>
            </div>
            <div className="smart-glasses-recovery-grid">
              <div className="smart-glasses-recovery-controls">
                <label className="flash-select-label">
                  Temple recovery target
                  <select
                    value={templeFlashRoute}
                    onChange={(event) => {
                      setTempleFlashRoute(event.target.value);
                      setTempleFlashSeated(false);
                      setTempleFlashText("");
                    }}
                    disabled={Boolean(operation)}
                  >
                    <option value="both">Both temples · right then left</option>
                    <option value="right">Right temple only</option>
                    <option value="left">Left temple only</option>
                  </select>
                </label>
                <p className="flash-mode-fixed">
                  Transfer mode · Complete pinned official Apollo main
                </p>
                <label className="pogo-confirm">
                  <input
                    type="checkbox"
                    checked={templeFlashSeated}
                    onChange={(event) => setTempleFlashSeated(event.target.checked)}
                    disabled={!report || !flashRoutesPresent || Boolean(operation)}
                  />
                  <span>
                    The selected route{templeFlashRoute === "both" ? "s are" : " is"}
                    {" "}seated; I will not move the Glasses, Case, or USB cable.
                  </span>
                </label>
                <label className="pogo-confirm">
                  <input
                    type="checkbox"
                    checked={templeFlashRisk}
                    onChange={(event) => setTempleFlashRisk(event.target.checked)}
                    disabled={!firmware?.templeFlashEligible || Boolean(operation)}
                  />
                  <span>
                    I understand this single-slot reinstall cannot recover a temple
                    whose Apollo application or pogo UART task is already dead.
                  </span>
                </label>
                <label
                  className="confirm-label"
                  htmlFor="recover-temple-flash-confirmation"
                >
                  Type <strong>FLASH GLASSES FIRMWARE</strong>
                </label>
                <input
                  id="recover-temple-flash-confirmation"
                  className="confirm-input"
                  value={templeFlashText}
                  onChange={(event) => setTempleFlashText(event.target.value)}
                  placeholder="FLASH GLASSES FIRMWARE"
                  autoComplete="off"
                  disabled={!firmware?.templeFlashEligible || Boolean(operation)}
                />
                <Button
                  tone="danger"
                  onClick={flashTempleFirmware}
                  busy={operation === "temple-flash"}
                  disabled={!templeFlashReady}
                >
                  Recover selected Smart Glasses
                </Button>
                {!firmware?.templeFlashEligible ? (
                  <small className="pogo-presence-warning">
                    Load an official pinned image from the verified library in Choose image.
                  </small>
                ) : !firmware.templeFlashTarget?.hardwareValidated ? (
                  <small className="pogo-presence-warning">
                    {firmware.templeFlashTarget.label} is hash-pinned, but its
                    temple transfer has not completed on Case USB hardware.
                  </small>
                ) : report && !flashRoutesPresent ? (
                  <small className="pogo-presence-warning">
                    Refresh analysis after seating every selected route.
                  </small>
                ) : null}
              </div>
              <div className="smart-glasses-recovery-proof">
                <div>
                  <span>ALLOWLIST</span>
                  <strong>{POGO_TRANSFER_RESEARCH.directTempleHost.component}</strong>
                </div>
                <div>
                  <span>SELECTED PINNED MAIN</span>
                  <strong>
                    {(firmware?.templeFlashTarget?.mainBytes ??
                      POGO_TRANSFER_RESEARCH.caseUsbBridge.successfulTransfers.right
                        .payloadBytes
                    ).toLocaleString()}
                    {" B · "}
                    {Math.ceil(
                      (firmware?.templeFlashTarget?.mainBytes ??
                        POGO_TRANSFER_RESEARCH.caseUsbBridge.successfulTransfers.right
                          .payloadBytes) / 1000,
                    ).toLocaleString()}
                    {" records"}
                  </strong>
                </div>
                <div>
                  <span>RECOVERY ENVELOPE</span>
                  <strong>Case 1.2.57 · G2 2.2.6.10 · HW 5</strong>
                </div>
                <div>
                  <span>FINAL RECOVERY PHASE</span>
                  <strong>DEB0 reset · contacts · version liveness</strong>
                </div>
                <div>
                  <span>PROVEN FALLBACK FROM WIRED</span>
                  <strong>Fresh BLE · all 6 stock components · 1,053 ACKs</strong>
                </div>
                <div>
                  <span>EXCLUDED</span>
                  <strong>Apollo bootloader + all peripheral components</strong>
                </div>
                <div className="smart-glasses-recovery-boundary">
                  <Icon name="warning" />
                  <span>
                    An application-dead temple remains outside this WebFlasher’s
                    proven recovery boundary. INFOC/INFO0 analysis can identify an
                    SBL candidate, but does not authorize or perform that write.
                  </span>
                </div>
              </div>
            </div>
            {templeFlashAudit ? (
              <div className={cx(
                "temple-flash-audit",
                templeFlashAudit.outcome === "success" && "is-success",
              )}>
                <div>
                  <strong>
                    {templeFlashAudit.outcome === "success"
                      ? "Transfer, final reset, and liveness verified"
                      : "Stopped · state failed or uncertain"}
                  </strong>
                  <span>
                    {templeFlashAudit.routeResults
                      .map((item) => `${item.route}: ${item.outcome}`)
                      .join(" · ")}
                    {templeFlashAudit.finalResetAndLiveness?.resetConfirmed
                      ? " · B0 reset: confirmed"
                      : ""}
                  </span>
                  {templeFlashAudit.verification ? (
                    <span>
                      Target SHA/byte count + finish acknowledgement:{" "}
                      {templeFlashAudit.verification
                        .everyRouteAcceptedExactTargetBytes
                        ? "verified"
                        : "incomplete"}
                      {" · "}postflight:{" "}
                      {templeFlashAudit.verification
                        .everyRoutePostflightVersionValid
                        ? "verified"
                        : "incomplete"}
                      {" · "}final reset/liveness:{" "}
                      {templeFlashAudit.verification
                        .finalDualTempleResetVerified &&
                      templeFlashAudit.verification.postResetLivenessVerified
                        ? "verified"
                        : "incomplete"}
                    </span>
                  ) : null}
                  {templeFlashAudit.routeResults
                    .find((item) => item.recoveryBoundary)
                    ?.recoveryBoundary?.recoveryRecommendation ? (
                      <span>
                        {
                          templeFlashAudit.routeResults.find(
                            (item) => item.recoveryBoundary,
                          ).recoveryBoundary.recoveryRecommendation
                        }
                      </span>
                    ) : null}
                </div>
                <Button
                  tone="ghost"
                  onClick={() =>
                    downloadBlob(
                      new Blob([`${JSON.stringify(templeFlashAudit, null, 2)}\n`], {
                        type: "application/json",
                      }),
                      `g2-temple-restore-${new Date().toISOString().replaceAll(":", "-")}.json`,
                    )
                  }
                >
                  Download recovery audit
                </Button>
              </div>
            ) : null}
          </div>
          <div className="recovery-target-heading">
            <div>
              <div className="eyebrow">Recovery boundary</div>
              <h3>
                The Case can recover a running temple. Dead-temple recovery is
                not proven.
              </h3>
              <p>
                The traced B0 command can hardware-reset both seated temples, and
                the Case reports when each application link returns. This console
                can also load the exact reviewed read-only SRAM bridge for
                checksum-valid status or version replies from either pogo route.
                Its hash-gated writer can install only an official Apollo main from its
                compiled-in allowlist on a running
                temple, with finish acknowledgement, post-reboot version,
                byte-for-byte route restoration, normal Case-app return, a final
                B0 reset, renewed contact presence, and post-reset version
                liveness required on every selected route. The recovery-session
                reset revived a nonresponsive left application/display without
                sending firmware bytes. Stock is proven by a complete
                wired right-main restore and a complete fresh-BLE six-component
                left restore. Case-USB remains a main-only writer; the direct
                Bluetooth panel transfers the complete pinned package.
              </p>
            </div>
            <Button
              tone="secondary"
              onClick={restartAndRecheck}
              busy={operation === "recheck"}
              disabled={!report || Boolean(operation)}
            >
              Reset both temples & recheck
            </Button>
          </div>
          {recheckReport ? (
            <div className="recheck-result">
              <Icon name="check" />
              B0 reset confirmed · L {recheckReport.telemetry?.leftPresent ? "present" : "absent"} · R{" "}
              {recheckReport.telemetry?.rightPresent ? "present" : "absent"} ·{" "}
              {recheckReport.applicationLivenessVerified
                ? "both applications verified"
                : "application liveness pending"}
            </div>
          ) : null}
          <div className="boundary-evidence">
            <div className="is-confirmed">
              <span>CASE MCU</span>
              <strong>USB ROM loader verified</strong>
            </div>
            <div className="is-confirmed">
              <span>RUNNING TEMPLE</span>
              <strong>Reviewed read-only pogo bridge available</strong>
            </div>
            <div className="is-confirmed">
              <span>POGO OTA</span>
              <strong>Pinned main writer enabled</strong>
            </div>
            <div className="is-blocked">
              <span>APPLICATION-DEAD TEMPLE</span>
              <strong>SBL requires matching INFOC + active INFO0</strong>
            </div>
          </div>
          <div className="pogo-tool">
            <div className="pogo-tool-heading">
              <div>
                <div className="eyebrow">Volatile read-only bridge</div>
                <h3>Query a running temple through the Case</h3>
              </div>
              <StatusPill tone="success">Pinned SHA-256 · SRAM only</StatusPill>
            </div>
            <p>
              Loads the physically reviewed 1,720-byte bridge into high Case SRAM,
              emits one embedded status or version request, verifies exact YHM route
              restoration, clears the retained proof/result, and returns to stock Case
              firmware. Arbitrary bytes and OTA commands are absent from the payload.
            </p>
            <div className="pogo-controls">
              <label>
                Temple route
                <select
                  value={pogoRoute}
                  onChange={(event) => {
                    setPogoRoute(event.target.value);
                    setPogoConfirm(false);
                  }}
                  disabled={Boolean(operation)}
                >
                  <option value="left">Left temple</option>
                  <option value="right">Right temple</option>
                </select>
              </label>
              <label>
                Read-only request
                <select
                  value={pogoOperation}
                  onChange={(event) => {
                    setPogoOperation(event.target.value);
                    setPogoConfirm(false);
                  }}
                  disabled={Boolean(operation)}
                >
                  <option value="version">Firmware + hardware version</option>
                  <option value="status">Battery + voltage status</option>
                </select>
              </label>
              <Button
                tone="secondary"
                onClick={probeRunningTemple}
                busy={operation === "pogo"}
                disabled={
                  !report ||
                  !selectedTemplePresent ||
                  !pogoConfirm ||
                  Boolean(operation)
                }
              >
                Run read-only probe
              </Button>
              <label className="pogo-confirm">
                <input
                  type="checkbox"
                  checked={pogoConfirm}
                  onChange={(event) => setPogoConfirm(event.target.checked)}
                  disabled={!report || !selectedTemplePresent || Boolean(operation)}
                />
                <span>
                  I confirm the {pogoRoute} temple is seated and will leave the Case
                  connected while the reviewed bridge runs.
                </span>
              </label>
              {report && !selectedTemplePresent ? (
                <small className="pogo-presence-warning">
                  The latest Case telemetry does not report this temple as present.
                  Refresh analysis after seating it.
                </small>
              ) : null}
            </div>
            <div className="pogo-results">
              <TempleProbeResult side="Left" results={pogoResults.left} />
              <TempleProbeResult side="Right" results={pogoResults.right} />
            </div>
            <small className="pogo-safety-note">
              A non-idle charging route is rejected before temple transmission. Wait
              for stock charging activity to settle, then retry if status 3 is reported.
              The payload and protocol are physically verified; this Case-USB
              pogo route remains experimental until exercised on G2 hardware.
            </small>
          </div>
          <div className="transfer-research">
            <div className="pogo-tool-heading">
              <div>
                <div className="eyebrow">Validated recovery evidence</div>
                <h3>Successful Case-to-Glasses transfer record</h3>
              </div>
              <StatusPill tone={firmware?.templeFlashEligible ? "success" : "quiet"}>
                {firmware?.templeFlashEligible
                  ? firmware.templeFlashTarget?.hardwareValidated
                    ? "Transfer validated"
                    : "Hash pinned"
                  : "Load a pinned image"}
              </StatusPill>
            </div>
            <p>
              The physically validated Case-USB bridge uses the running
              application’s 0x52–0x55 path. This evidence sits below the recovery
              controls so the writer’s allowlist, hardware results, and known
              failure boundary stay visible alongside the diagnostic tools.
            </p>
            <div className="transfer-facts">
              <div>
                <span>DIRECT UART HOST</span>
                <strong>
                  {POGO_TRANSFER_RESEARCH.directTempleHost.offlineTestsPassed}/
                  {POGO_TRANSFER_RESEARCH.directTempleHost.offlineTestsPassed} offline
                  tests pass
                </strong>
              </div>
              <div>
                <span>TRANSFER ALLOWLIST</span>
                <strong>{POGO_TRANSFER_RESEARCH.directTempleHost.component}</strong>
              </div>
              <div>
                <span>CASE-USB ATTEMPTS</span>
                <strong>
                  {POGO_TRANSFER_RESEARCH.caseUsbBridge.attempts}
                  {" · "}
                  {POGO_TRANSFER_RESEARCH.caseUsbBridge.completeWiredTransfers}
                  {" complete wired"}
                </strong>
              </div>
              <div>
                <span>VERIFIED EACH ROUTE</span>
                <strong>
                  {POGO_TRANSFER_RESEARCH.caseUsbBridge.successfulTransfers.right.payloadBytes.toLocaleString()}
                  {" B · "}
                  {POGO_TRANSFER_RESEARCH.caseUsbBridge.successfulTransfers.right.recordsSent.toLocaleString()}
                  {" records each"}
                </strong>
              </div>
              <div>
                <span>CURRENT BRIDGE GATE</span>
                <strong>
                  {POGO_TRANSFER_RESEARCH.caseUsbBridge.hardwareAttemptsWithCurrentSource}
                  {" hardware runs · "}
                  {POGO_TRANSFER_RESEARCH.caseUsbBridge.observedBytes.toLocaleString()} B
                </strong>
              </div>
              <div>
                <span>OFFICIAL LEFT FALLBACK</span>
                <strong>
                  {POGO_TRANSFER_RESEARCH.caseUsbBridge.officialRestore.left.blockAcks.toLocaleString()}
                  {" BLE ACKs · "}
                  {POGO_TRANSFER_RESEARCH.caseUsbBridge.officialRestore.left.fullPackageComponents}
                  {" components"}
                </strong>
              </div>
            </div>
            <a
              className="button button-secondary transfer-recovery-link"
              href="#smart-glasses-recovery"
            >
              Open Smart Glasses recovery
            </a>
            <small className="transfer-warning">
              The running-temple writer remains limited to official pinned Apollo-main
              payloads. Retain every downloaded audit and treat any interrupted result
              as failed or uncertain.
            </small>
          </div>
          <div className="sbl-audit">
            <div className="pogo-tool-heading">
              <div>
                <div className="eyebrow">Offline dead-temple candidate</div>
                <h3>Decode Apollo510 recovery provisioning</h3>
              </div>
              <StatusPill tone="quiet">Local files · read-only</StatusPill>
            </div>
            <p>
              Inspect debugger dumps without contacting or writing a temple. INFOC must
              begin at 0x400C2000; active INFO0 begins at offset zero. The decoder checks
              the exact UART enable/module, 1-Mbaud 8N1 framing, GPIO44/RX,
              GPIO42/TX, pin functions, receive window, override, and MRAM-recovery
              controls documented by this project.
            </p>
            <div className="sbl-upload-grid">
              <label>
                <span>INFOC · at least 0x400 bytes</span>
                <input
                  type="file"
                  accept=".bin,.dump,application/octet-stream"
                  onChange={(event) => loadRecoveryDump("infoc", event)}
                />
                <strong>{recoveryDumps.infoc?.name ?? "Choose debugger dump"}</strong>
              </label>
              <label>
                <span>Active INFO0 · at least 0x6C bytes</span>
                <input
                  type="file"
                  accept=".bin,.dump,application/octet-stream"
                  onChange={(event) => loadRecoveryDump("info0", event)}
                />
                <strong>{recoveryDumps.info0?.name ?? "Choose debugger dump"}</strong>
              </label>
              {recoveryConfig ? (
                <Button tone="ghost" onClick={clearRecoveryDumps}>
                  Clear dumps
                </Button>
              ) : null}
            </div>
            {recoveryConfigError ? (
              <small className="sbl-error">{recoveryConfigError}</small>
            ) : null}
            <RecoveryConfigResult report={recoveryConfig} />
            <small className="pogo-safety-note">
              A positive match makes the protected Ambiq SBL a restoration candidate;
              it does not prove retail image authorization, provide a backup, or enable
              any write control in this webflasher.
            </small>
          </div>
        </section>


        </div>
        <footer className={cx("footer", progress.visible && "has-task")}>
          <div className="footer-meta">
            <span>
              Even Realities WebFlasher · build {WEBFLASHER_BUILD_LABEL} ·{" "}
              {selectedTransport}
            </span>
            <span>Device data stays local in this browser.</span>
          </div>
          <TaskProgress
            progress={progress}
            wakeLockStatus={wakeLockStatus}
            bleRouteProgress={bleRouteProgress}
          />
        </footer>
      </main>

      <Console
        open={consoleOpen}
        entries={logs}
        fullTranscript={consoleOpen ? transcriptRef.current : null}
        onClose={() => setConsoleOpen(false)}
        onClear={clearConsole}
        onDownload={downloadConsoleTranscript}
      />
    </div>
  );
}

export default App;

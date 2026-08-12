// A small local history of what each physical Case has been through.
//
// Individual audits already prove a single operation. What they cannot show is
// a pattern: that one temple needs more settle than the other, that a committed
// image routinely takes an extra reset to activate on a particular unit, or
// that a behaviour tracks a silicon lot. Those questions only become answerable
// once results are filed per device and compared.
//
// This is a diagnostic aid, never a gate. Nothing here may influence whether a
// write is permitted; the audits and their pinned hashes remain the authority.

import { caseDeviceKey } from "./deviceIdentity.js";

const HISTORY_STORAGE_KEY = "g2wf.device-history.v1";
const LABEL_STORAGE_KEY = "g2wf.device-labels.v1";
export const DEVICE_HISTORY_ENTRY_LIMIT = 200;

function readJson(key, fallback) {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null");
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // History is an optimization; losing it must never fail an operation.
    return false;
  }
}

export function readDeviceLabels() {
  return readJson(LABEL_STORAGE_KEY, {});
}

// The operator label is the only place case colour, frame fit, or "which unit
// is this" can live: none of it is machine-readable from the device.
export function readDeviceLabel(deviceKey) {
  if (!deviceKey) return "";
  const labels = readDeviceLabels();
  return typeof labels[deviceKey] === "string" ? labels[deviceKey] : "";
}

export function writeDeviceLabel(deviceKey, label) {
  if (!deviceKey) return false;
  const labels = readDeviceLabels();
  const trimmed = String(label ?? "").trim().slice(0, 120);
  if (trimmed) labels[deviceKey] = trimmed;
  else delete labels[deviceKey];
  return writeJson(LABEL_STORAGE_KEY, labels);
}

export function readDeviceHistory() {
  const history = readJson(HISTORY_STORAGE_KEY, {});
  return history && typeof history === "object" ? history : {};
}

// Reduce a finished route result to the few fields worth comparing across runs.
export function summarizeRouteResult(routeResult) {
  const pacing = routeResult?.dataPacingPolicy ?? {};
  const activation = routeResult?.deferredActivation ?? null;
  return {
    route: routeResult?.route ?? null,
    outcome: routeResult?.outcome ?? null,
    failureStage: routeResult?.failureStage ?? null,
    acceptedBytes: routeResult?.acceptedFirmwareBytes ?? null,
    preflightFirmware: routeResult?.preflightVersion?.firmware ?? null,
    postflightFirmware: routeResult?.postflightVersion?.firmware ?? null,
    pacing: {
      startLevel: pacing.startLevel ?? null,
      finalLevel: pacing.finalLevel ?? null,
      escalations: pacing.escalations ?? null,
      ackMeanMs: pacing.ackMeanMs ?? null,
      ackMaxMs: pacing.ackMaxMs ?? null,
      settleTotalMs: pacing.settleTotalMs ?? null,
    },
    // How many resets a committed image needed before it actually ran. A value
    // that clusters on one side, or one unit, is a real hardware characteristic
    // rather than a transfer problem.
    activationResets: activation ? activation.attempts?.length ?? 0 : 0,
    activationResolvedOnAttempt: activation?.resolvedOnAttempt ?? null,
    // The temple's own OTA state as retained by the bridge. Correlating this
    // with explicit 0x54 rejections is the most direct lead available on them.
    templeOtaState: routeResult?.retainedResult?.otaState ?? null,
    dataRejection: routeResult?.dataRejection
      ? {
          status: routeResult.dataRejection.status ?? null,
          record: routeResult.dataRejection.record ?? null,
        }
      : null,
  };
}

export function buildDeviceHistoryEntry({
  operation,
  audit = null,
  fingerprint = null,
  outcome = null,
  recordedAt,
}) {
  return {
    recordedAt,
    operation: operation ?? null,
    outcome: outcome ?? audit?.outcome ?? null,
    transport: fingerprint?.transport?.kind ?? null,
    usbBridgeRevision: fingerprint?.transport?.usbBridgeRevision ?? null,
    caseFirmware: fingerprint?.case?.firmware ?? null,
    // What each temple actually reported at the time, so a later session can
    // ask whether an image it verified as installed is still there.
    templeFirmware: {
      left: fingerprint?.temples?.left?.firmware ?? null,
      right: fingerprint?.temples?.right?.firmware ?? null,
    },
    operatorLabel: fingerprint?.operatorLabel ?? null,
    imageSha256: audit?.imageSha256 ?? null,
    imageLabel: audit?.imageLabel ?? null,
    flashMode: audit?.flashMode ?? null,
    routes: Array.isArray(audit?.routeResults)
      ? audit.routeResults.map(summarizeRouteResult)
      : [],
  };
}

export function appendDeviceHistory(deviceKey, entry) {
  if (!deviceKey) return null;
  const history = readDeviceHistory();
  const entries = Array.isArray(history[deviceKey]) ? history[deviceKey] : [];
  const next = [...entries, entry].slice(-DEVICE_HISTORY_ENTRY_LIMIT);
  history[deviceKey] = next;
  writeJson(HISTORY_STORAGE_KEY, history);
  return next;
}

export function recordDeviceOperation({
  report,
  operation,
  audit = null,
  fingerprint = null,
  outcome = null,
  recordedAt = new Date().toISOString(),
}) {
  const deviceKey = fingerprint?.deviceKey ?? caseDeviceKey(report);
  const entry = buildDeviceHistoryEntry({
    operation,
    audit,
    fingerprint,
    outcome,
    recordedAt,
  });
  return { deviceKey, entry, entries: appendDeviceHistory(deviceKey, entry) };
}

// Roll a device's history into the questions actually worth asking of it:
// which route fails, how often an image needed an extra reset, and what pacing
// each side settled at.
export function summarizeDeviceHistory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const perRoute = {};
  for (const entry of list) {
    for (const route of entry.routes ?? []) {
      if (!route.route) continue;
      const bucket = (perRoute[route.route] ??= {
        attempts: 0,
        successes: 0,
        dataRejections: 0,
        activationResets: 0,
        pacingLevels: [],
        ackMeans: [],
      });
      bucket.attempts += 1;
      if (route.outcome === "success") bucket.successes += 1;
      if (route.dataRejection) bucket.dataRejections += 1;
      bucket.activationResets += route.activationResets ?? 0;
      if (Number.isInteger(route.pacing?.finalLevel)) {
        bucket.pacingLevels.push(route.pacing.finalLevel);
      }
      if (Number.isInteger(route.pacing?.ackMeanMs)) {
        bucket.ackMeans.push(route.pacing.ackMeanMs);
      }
    }
  }
  const mean = (values) =>
    values.length
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : null;
  return {
    operations: list.length,
    firstSeen: list[0]?.recordedAt ?? null,
    lastSeen: list[list.length - 1]?.recordedAt ?? null,
    transports: [...new Set(list.map((entry) => entry.transport).filter(Boolean))],
    routes: Object.fromEntries(
      Object.entries(perRoute).map(([route, bucket]) => [
        route,
        {
          attempts: bucket.attempts,
          successes: bucket.successes,
          dataRejections: bucket.dataRejections,
          activationResets: bucket.activationResets,
          typicalPacingLevel: mean(bucket.pacingLevels),
          meanAckMs: mean(bucket.ackMeans),
        },
      ]),
    ),
    lastTempleFirmware: lastRecordedTempleFirmware(list),
  };
}

function compareFirmwareVersions(left, right) {
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

// The newest version each temple was last seen running, preferring what a
// route result proved after a write over what was merely observed on arrival.
export function lastRecordedTempleFirmware(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const latest = { left: null, right: null };
  for (const entry of list) {
    for (const route of ["left", "right"]) {
      const fromRoute = (entry.routes ?? []).find(
        (result) => result.route === route,
      )?.postflightFirmware;
      const observed = fromRoute ?? entry.templeFirmware?.[route] ?? null;
      if (!observed) continue;
      latest[route] = { firmware: observed, recordedAt: entry.recordedAt ?? null };
    }
  }
  return latest;
}

// Did a temple come back running an OLDER image than this browser last saw on
// it? Nothing in a single session can answer that, and the answer changes the
// diagnosis completely: a temple that silently reverts is not the same problem
// as a temple that refuses a write.
//
// Diagnostic only - like everything else in this file it must never gate a
// write. An unknown or unparsable version yields no finding rather than a
// guess, and a swapped-in different pair of temples looks identical to a
// revert from here, so the finding says what was observed and leaves the
// conclusion to the operator.
export function detectTempleFirmwareRegression(entries, observed) {
  const previous = lastRecordedTempleFirmware(entries);
  const findings = [];
  for (const route of ["left", "right"]) {
    const before = previous[route]?.firmware ?? null;
    const now = observed?.[route] ?? null;
    if (!before || !now) continue;
    if (compareFirmwareVersions(now, before) !== -1) continue;
    findings.push({
      route,
      previousFirmware: before,
      previousRecordedAt: previous[route]?.recordedAt ?? null,
      observedFirmware: now,
    });
  }
  return findings;
}

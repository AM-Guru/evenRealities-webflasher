// Per-tab storage for the crash-safe recovery console transcript.
//
// The transcript outlives the console's display cap so a crash or tab close
// during a recovery cannot destroy the evidence of what was written to the
// device. It used to live under one origin-wide key, which is correct for a
// single tab and wrong for two: each tab's debounced save replaced the whole
// stored array, so a second tab interleaved its lines into the first tab's
// history and could truncate a transfer's transcript mid-flight. Observed
// 2026-07-28, where a local Web Serial analysis in one tab wrote its failures
// into a remote support session's transcript and made a healthy flash read as
// a failing one.
//
// Each tab therefore owns a key derived from an id held in sessionStorage,
// which survives that tab's own reload and crash-restore but is never shared
// with another tab. Older single-key transcripts are adopted once so an
// upgrade does not lose a transfer already in progress.
export const CONSOLE_TRANSCRIPT_STORAGE_PREFIX = "g2wf.console-transcript.v2";
export const LEGACY_CONSOLE_TRANSCRIPT_STORAGE_KEY =
  "g2wf.console-transcript.v1";
export const CONSOLE_TRANSCRIPT_TAB_ID_KEY = "g2wf.console-transcript-tab";
export const CONSOLE_TRANSCRIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CONSOLE_TRANSCRIPT_MAX_STORED = 8;
export const SHELL_EVIDENCE_RECORD_KIND =
  "g2-webflasher-shell-and-evidence-snapshot";
export const BLUETOOTH_RECOVERY_RECORD_KIND =
  "g2-webflasher-bluetooth-recovery-audit";

// A tab that cannot reach sessionStorage still gets a working transcript; it
// simply shares the fallback key, which is the old behavior and no worse.
const SHARED_FALLBACK_TAB_ID = "shared";

export function formatShellEvidenceTranscript(
  analytics,
  {
    phase = "analysis",
    capturedAt = new Date().toISOString(),
  } = {},
) {
  if (!analytics || typeof analytics !== "object") {
    throw new TypeError(
      "Complete device analytics are required for a Shell & Evidence snapshot.",
    );
  }
  const record = {
    recordKind: SHELL_EVIDENCE_RECORD_KIND,
    phase,
    capturedAt,
    analytics,
  };
  return [
    `Shell & Evidence snapshot · ${phase}`,
    "----- BEGIN SHELL & EVIDENCE JSON -----",
    JSON.stringify(record, null, 2),
    "----- END SHELL & EVIDENCE JSON -----",
  ].join("\n");
}

export function formatConsoleTranscriptDownload(
  entries,
  {
    analytics = null,
    downloadedAt = new Date().toISOString(),
  } = {},
) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const lines = [
    "G2 WEBFLASHER COMPLETE CONSOLE TRANSCRIPT",
    `Downloaded at: ${downloadedAt}`,
    `Transcript entries: ${safeEntries.length}`,
    "View: full transcript (the recent-only view is disabled)",
    "",
    ...safeEntries.map(
      (entry) =>
        `${entry?.time ?? "--:--:--"}  [${entry?.tone ?? "info"}] ${
          entry?.message ?? ""
        }`,
    ),
  ];
  if (analytics) {
    lines.push(
      "",
      formatShellEvidenceTranscript(analytics, {
        phase: "download-final",
        capturedAt: downloadedAt,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatBluetoothRecoveryTranscript(
  audit,
  {
    phase = "bluetooth-smart-glasses-recovery",
    capturedAt = new Date().toISOString(),
    buildLabel = null,
  } = {},
) {
  if (!audit || typeof audit !== "object") {
    throw new TypeError(
      "A Bluetooth recovery audit is required for transcript evidence.",
    );
  }
  const record = {
    recordKind: BLUETOOTH_RECOVERY_RECORD_KIND,
    phase,
    capturedAt,
    webFlasherBuild: buildLabel,
    audit,
  };
  return [
    `Bluetooth recovery audit · ${audit.outcome ?? phase}`,
    "----- BEGIN BLUETOOTH RECOVERY JSON -----",
    JSON.stringify(record, null, 2),
    "----- END BLUETOOTH RECOVERY JSON -----",
  ].join("\n");
}

export function resolveConsoleTranscriptTabId(
  sessionStorage,
  makeId = () =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
) {
  try {
    const existing = sessionStorage?.getItem(CONSOLE_TRANSCRIPT_TAB_ID_KEY);
    if (typeof existing === "string" && existing) return existing;
    const id = makeId();
    sessionStorage.setItem(CONSOLE_TRANSCRIPT_TAB_ID_KEY, id);
    return id;
  } catch {
    return SHARED_FALLBACK_TAB_ID;
  }
}

export function consoleTranscriptStorageKey(tabId) {
  return `${CONSOLE_TRANSCRIPT_STORAGE_PREFIX}.${tabId}`;
}

function parseTranscript(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.entries)) return null;
  const entries = parsed.entries.filter(
    (entry) =>
      typeof entry?.time === "string" && typeof entry?.message === "string",
  );
  if (!entries.length) return null;
  return {
    savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : null,
    entries,
  };
}

// Reads this tab's transcript, adopting a legacy single-key transcript exactly
// once so an in-progress transfer survives the upgrade.
export function readConsoleTranscript(localStorage, key) {
  try {
    const own = parseTranscript(localStorage.getItem(key));
    if (own) return own;
    const legacy = parseTranscript(
      localStorage.getItem(LEGACY_CONSOLE_TRANSCRIPT_STORAGE_KEY),
    );
    if (!legacy) return null;
    localStorage.setItem(
      key,
      JSON.stringify({ savedAt: legacy.savedAt, entries: legacy.entries }),
    );
    localStorage.removeItem(LEGACY_CONSOLE_TRANSCRIPT_STORAGE_KEY);
    return legacy;
  } catch {
    return null;
  }
}

export function writeConsoleTranscript(localStorage, key, entries, savedAt) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt, entries }));
    return true;
  } catch {
    // Storage may be full or unavailable; the in-memory transcript still
    // serves this session's download.
    return false;
  }
}

// Drops transcripts left by tabs that are gone, so per-tab keys cannot grow
// without bound. The current tab's key is never touched, and neither are
// transcripts newer than the retention window — another tab may be mid-flash.
export function pruneConsoleTranscripts(
  localStorage,
  currentKey,
  {
    now = Date.now(),
    retentionMs = CONSOLE_TRANSCRIPT_RETENTION_MS,
    maxStored = CONSOLE_TRANSCRIPT_MAX_STORED,
  } = {},
) {
  const removed = [];
  try {
    const candidates = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (
        typeof key !== "string" ||
        !key.startsWith(`${CONSOLE_TRANSCRIPT_STORAGE_PREFIX}.`) ||
        key === currentKey
      ) {
        continue;
      }
      const savedAt = Date.parse(
        parseTranscript(localStorage.getItem(key))?.savedAt ?? "",
      );
      candidates.push({ key, savedAt: Number.isNaN(savedAt) ? 0 : savedAt });
    }
    const survivors = [];
    for (const candidate of candidates) {
      if (now - candidate.savedAt > retentionMs) removed.push(candidate.key);
      else survivors.push(candidate);
    }
    survivors.sort((a, b) => a.savedAt - b.savedAt);
    // maxStored counts this tab's transcript alongside the retained ones.
    while (survivors.length > Math.max(0, maxStored - 1)) {
      removed.push(survivors.shift().key);
    }
    for (const key of removed) localStorage.removeItem(key);
  } catch {
    // Pruning is housekeeping, never a gate on recovery.
  }
  return removed;
}

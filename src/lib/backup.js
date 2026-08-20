import {
  FLASH_BASE,
  OPTION_BASE,
  base64ToBytes,
  bytesToBase64,
  hex,
  hexBytes,
  parseFirmwareInput,
  sha256Hex,
} from "./firmware.js";

export const SYSTEM_BACKUP_SCHEMA_VERSION = 3;

function officialChannel(release) {
  return (release?.channel ?? "official") === "official";
}

function templeVersion(probe, side) {
  const version = probe?.decoded?.firmwareVersion;
  if (!version) {
    throw new Error(
      `The ${side} temple did not provide a firmware version for the backup.`,
    );
  }
  return version;
}

// A split pair is exactly the state an interrupted cross-version update can
// leave behind and exactly when a technician most wants a backup. Resolution
// is therefore per route against this fork's official-only archive. A version
// with no official bundle degrades to an explicit recorded omission — the case
// bytes and live temple snapshots are the irreplaceable parts of the backup;
// bundles are re-downloadable.
export function resolveGlassesRecoveryReleases(catalog, templeProbes) {
  const routes = {};
  for (const side of ["left", "right"]) {
    const version = templeVersion(templeProbes?.[side], side);
    const release =
      catalog.find(
        (candidate) =>
          officialChannel(candidate) && candidate.version === version,
      ) ?? null;
    routes[side] = {
      side,
      version,
      release,
      omissionReason: release
        ? null
        : `The archive does not contain an official G2 ${version} recovery bundle.`,
    };
  }
  const releases = [];
  for (const side of ["left", "right"]) {
    const release = routes[side].release;
    if (release && !releases.some((seen) => seen.sha256 === release.sha256)) {
      releases.push(release);
    }
  }
  return {
    pairMatched: routes.left.version === routes.right.version,
    left: routes.left,
    right: routes.right,
    releases,
  };
}

export async function validateGlassesRecoveryBundle(input, release) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length !== release.size) {
    throw new Error(
      "The Smart Glasses recovery bundle size does not match its catalog entry.",
    );
  }
  const parsed = await parseFirmwareInput(bytes, release.fileName);
  if (parsed.fileSha256 !== release.sha256) {
    throw new Error(
      "The Smart Glasses recovery bundle SHA-256 does not match its catalog entry.",
    );
  }
  if (parsed.kind !== "bundle" || parsed.g2Version !== release.version) {
    throw new Error(
      "The Smart Glasses recovery bundle does not match the versions reported by the temples.",
    );
  }
  return parsed;
}

function serializeTempleProbe(probe, side) {
  const proof = probe?.transportProof;
  return {
    side,
    firmwareVersion: templeVersion(probe, side),
    hardwareRevision: probe.decoded.hardwareRevision,
    capturedFrameBase64: bytesToBase64(probe.captured),
    capturedFrameHex: hexBytes(probe.captured),
    transportProof: proof
      ? {
          baselineMask: hex(proof.baselineMask),
          selectedMask: hex(proof.selectedMask),
          restoredMask: hex(proof.restoredMask),
          writeMask: hex(proof.writeMask),
          transmittedBytes: proof.transmitted,
          capturedBytes: proof.stored,
          uartErrorMask: hex(proof.errors),
          baselineYhmRegistersHex: hexBytes(proof.baseline),
        }
      : null,
  };
}

function serializeRecoveryBundle(release, bytes, coveredSides) {
  const bundleBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return {
    coveredSides,
    version: release.version,
    channel: release.channel ?? "official",
    trust: release.trust ?? null,
    fileName: release.fileName,
    size: bundleBytes.length,
    sha256: release.sha256,
    archivedFrom: release.archivedFrom ?? null,
    components: (release.components ?? [])
      .filter((component) => component.typeId !== 6)
      .map(({ name, typeId, size, crc32c, sha256 }) => ({
        name,
        typeId,
        size,
        crc32c,
        sha256,
      })),
    bytesBase64: bytesToBase64(bundleBytes),
  };
}

export function buildG2SystemBackupArtifact({
  caseBackup,
  report,
  templeProbes,
  recoveryResolution,
  recoveryBundles,
  createdAt = new Date().toISOString(),
}) {
  const left = serializeTempleProbe(templeProbes?.left, "left");
  const right = serializeTempleProbe(templeProbes?.right, "right");
  // A split pair is backed up, not refused: both live snapshots are captured
  // and each route's matching archived bundle (or an explicit omission) is
  // recorded per side.
  const resolution =
    recoveryResolution ??
    (() => {
      throw new Error("A combined backup requires a recovery resolution.");
    })();
  const bundlesBySha = new Map(
    (recoveryBundles ?? []).map(({ release, bytes }) => [release.sha256, { release, bytes }]),
  );
  const serializedBundles = [];
  const omissions = [];
  for (const side of ["left", "right"]) {
    const route = resolution[side];
    if (!route.release) {
      omissions.push({ side, version: route.version, reason: route.omissionReason });
      continue;
    }
    const fetched = bundlesBySha.get(route.release.sha256);
    if (!fetched) {
      throw new Error(
        `The validated ${route.version} recovery bundle bytes for the ${side} temple were not provided.`,
      );
    }
    const existing = serializedBundles.find(
      (bundle) => bundle.sha256 === route.release.sha256,
    );
    if (existing) {
      if (!existing.coveredSides.includes(side)) existing.coveredSides.push(side);
      continue;
    }
    serializedBundles.push(
      serializeRecoveryBundle(fetched.release, fetched.bytes, [side]),
    );
  }

  return {
    schemaVersion: SYSTEM_BACKUP_SCHEMA_VERSION,
    backupKind: "even-realities-g2-system-recovery",
    device: "Even Realities G2 Charging Case and Smart Glasses",
    createdAt,
    scope: {
      chargingCase: "byte-for-byte installed flash and option bytes",
      smartGlasses:
        "live left/right identity snapshots plus matching official recovery firmware",
      smartGlassesInstalledMemoryReadback: false,
    },
    chargingCase: {
      flashBase: hex(FLASH_BASE),
      flashSize: caseBackup.flash.length,
      flashSha256: caseBackup.flashSha256,
      flashBase64: bytesToBase64(caseBackup.flash),
      optionBase: hex(OPTION_BASE),
      optionSize: caseBackup.optionBytes.length,
      optionSha256: caseBackup.optionSha256,
      optionBytesBase64: bytesToBase64(caseBackup.optionBytes),
      firmwareVersion:
        report?.console?.caseVersion ?? report?.banks?.active?.version ?? null,
      serialNumber: report?.console?.serialNumber ?? null,
      factoryIdentifier: report?.console?.identifier ?? null,
      activePhysicalBank: report?.options?.activePhysicalBank ?? null,
    },
    smartGlasses: {
      backupType: "per-route-recovery-bundles-with-live-temple-snapshots",
      installedMemoryReadback: false,
      limitation:
        "The G2 wired protocol cannot read installed Apollo MRAM, bootloader, pairing keys, calibration, or INFO0/INFOC. Each embedded bundle is a validated archived recovery image matching that route's reported firmware version, not a dump of installed temple memory.",
      pairMatched: resolution.pairMatched,
      left,
      right,
      telemetryAtAnalysis: report?.console?.telemetry
        ? {
            leftPresent: report.console.telemetry.leftPresent,
            rightPresent: report.console.telemetry.rightPresent,
          }
        : null,
      recoveryBundles: serializedBundles,
      recoveryBundleOmissions: omissions,
    },
  };
}

// Validates a previously saved case-only backup for reuse, so a retry in a
// new process does not pay the multi-minute 512 KiB flash re-read to satisfy
// the flash gate. Fail-closed: the recorded digests are recomputed from the
// embedded bytes, and the backup must name the same case the fresh analysis
// selected — a hash-valid backup of a different unit is still refused.
export async function validateSavedCaseBackup(artifact, { expectedSerial }) {
  if (!artifact || typeof artifact !== "object") {
    throw new Error("The saved backup is not a JSON object.");
  }
  const flash = base64ToBytes(artifact.flashBase64 ?? "");
  const optionBytes = base64ToBytes(artifact.optionBytesBase64 ?? "");
  if (flash.length !== 512 * 1024 || optionBytes.length !== 128) {
    throw new Error(
      "The saved backup does not contain a complete 512 KiB flash image and 128-byte option block.",
    );
  }
  const flashSha256 = await sha256Hex(flash);
  const optionSha256 = await sha256Hex(optionBytes);
  if (
    flashSha256 !== artifact.flashSha256 ||
    optionSha256 !== artifact.optionSha256
  ) {
    throw new Error(
      "The saved backup's recorded digests do not match its embedded bytes.",
    );
  }
  const serial = artifact.serialNumber ?? null;
  if (!expectedSerial || !serial || serial !== expectedSerial) {
    throw new Error(
      `The saved backup names case serial ${serial ?? "unknown"}, but the selected case is ${expectedSerial ?? "unknown"}. Save a fresh backup for this case.`,
    );
  }
  return { flashSha256, optionSha256, serialNumber: serial };
}

import {
  FLASH_BASE,
  OPTION_BASE,
  bytesToBase64,
  hex,
  hexBytes,
  parseFirmwareInput,
} from "./firmware.js";

export const SYSTEM_BACKUP_SCHEMA_VERSION = 2;

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

export function findMatchingGlassesRecoveryRelease(catalog, templeProbes) {
  const leftVersion = templeVersion(templeProbes?.left, "left");
  const rightVersion = templeVersion(templeProbes?.right, "right");
  if (leftVersion !== rightVersion) {
    throw new Error(
      `The seated temples report different firmware versions (${leftVersion} and ${rightVersion}).`,
    );
  }

  const release = catalog.find(
    (candidate) =>
      officialChannel(candidate) && candidate.version === leftVersion,
  );
  if (!release) {
    throw new Error(
      `The archive does not contain an official G2 ${leftVersion} recovery bundle.`,
    );
  }
  return release;
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

export function buildG2SystemBackupArtifact({
  caseBackup,
  report,
  templeProbes,
  recoveryRelease,
  recoveryBundleBytes,
  createdAt = new Date().toISOString(),
}) {
  const left = serializeTempleProbe(templeProbes?.left, "left");
  const right = serializeTempleProbe(templeProbes?.right, "right");
  if (left.firmwareVersion !== right.firmwareVersion) {
    throw new Error("A combined backup requires matching left and right firmware.");
  }

  const recoveryBytes =
    recoveryBundleBytes instanceof Uint8Array
      ? recoveryBundleBytes
      : new Uint8Array(recoveryBundleBytes);

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
      backupType: "official-recovery-bundle-with-live-temple-snapshots",
      installedMemoryReadback: false,
      limitation:
        "The G2 wired protocol cannot read installed Apollo MRAM, bootloader, pairing keys, calibration, or INFO0/INFOC. The embedded bundle is a validated official recovery image matching the reported firmware version, not a dump of installed temple memory.",
      left,
      right,
      telemetryAtAnalysis: report?.console?.telemetry
        ? {
            leftPresent: report.console.telemetry.leftPresent,
            rightPresent: report.console.telemetry.rightPresent,
          }
        : null,
      recoveryBundle: {
        version: recoveryRelease.version,
        fileName: recoveryRelease.fileName,
        size: recoveryBytes.length,
        sha256: recoveryRelease.sha256,
        archivedFrom: recoveryRelease.archivedFrom ?? null,
        components: (recoveryRelease.components ?? [])
          .filter((component) => component.typeId !== 6)
          .map(({ name, typeId, size, crc32c, sha256 }) => ({
            name,
            typeId,
            size,
            crc32c,
            sha256,
          })),
        bytesBase64: bytesToBase64(recoveryBytes),
      },
    },
  };
}

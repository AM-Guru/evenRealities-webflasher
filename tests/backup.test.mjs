import assert from "node:assert/strict";
import test from "node:test";
import {
  SYSTEM_BACKUP_SCHEMA_VERSION,
  buildG2SystemBackupArtifact,
  findMatchingGlassesRecoveryRelease,
  validateGlassesRecoveryBundle,
} from "../src/lib/backup.js";

function makeProbe(side, version = "2.2.6.10") {
  return {
    operation: "version",
    route: side,
    decoded: {
      kind: "version",
      firmwareVersion: version,
      hardwareRevision: 5,
    },
    captured: Uint8Array.from([0x5a, 0xa5, side === "left" ? 0x4c : 0x52]),
    transportProof: {
      baselineMask: 0x3ff,
      selectedMask: 0x3ff,
      restoredMask: 0x3ff,
      writeMask: 0x1ff,
      transmitted: 5,
      stored: 3,
      errors: 0,
      baseline: Uint8Array.from([
        0x81, 0x10, 0x04, 0xa6, 0xa6, 0x03, 0x03, 0x00, 0x22, 0xff,
      ]),
    },
  };
}

const release = {
  channel: "official",
  version: "2.2.6.10",
  fileName: "official.bin",
  size: 4,
  sha256: "a".repeat(64),
  archivedFrom: "Even Realities CDN",
  components: [
    {
      name: "ota/s200_firmware_ota.bin",
      typeId: 0,
      size: 123,
      crc32c: "11223344",
      sha256: "b".repeat(64),
    },
    {
      name: "firmware/box.bin",
      typeId: 6,
      size: 45,
      crc32c: "55667788",
      sha256: "c".repeat(64),
    },
  ],
};

test("selects the official recovery bundle matching both temples", () => {
  const probes = {
    left: makeProbe("left"),
    right: makeProbe("right"),
  };
  assert.equal(
    findMatchingGlassesRecoveryRelease(
      [
        { ...release, channel: "custom", fileName: "custom.bin" },
        release,
      ],
      probes,
    ),
    release,
  );
});

test("rejects mismatched temple versions and absent archived firmware", () => {
  assert.throws(
    () =>
      findMatchingGlassesRecoveryRelease(
        [release],
        {
          left: makeProbe("left", "2.2.6.10"),
          right: makeProbe("right", "2.2.4.34"),
        },
      ),
    /different firmware versions/,
  );
  assert.throws(
    () =>
      findMatchingGlassesRecoveryRelease(
        [],
        {
          left: makeProbe("left"),
          right: makeProbe("right"),
        },
      ),
    /does not contain/,
  );
});

test("builds one recovery artifact with case bytes and both glasses", () => {
  const artifact = buildG2SystemBackupArtifact({
    caseBackup: {
      flash: Uint8Array.from([1, 2, 3, 4]),
      optionBytes: Uint8Array.from([5, 6, 7, 8]),
      flashSha256: "d".repeat(64),
      optionSha256: "e".repeat(64),
    },
    report: {
      console: {
        caseVersion: "1.2.57",
        serialNumber: "ABC123",
        identifier: "AA BB CC DD EE FF 00 11",
        telemetry: { leftPresent: true, rightPresent: true },
      },
      options: { activePhysicalBank: 1 },
    },
    templeProbes: {
      left: makeProbe("left"),
      right: makeProbe("right"),
    },
    recoveryRelease: release,
    recoveryBundleBytes: Uint8Array.from([9, 10, 11, 12]),
    createdAt: "2026-07-25T00:00:00.000Z",
  });

  assert.equal(artifact.schemaVersion, SYSTEM_BACKUP_SCHEMA_VERSION);
  assert.equal(artifact.chargingCase.flashBase64, "AQIDBA==");
  assert.equal(artifact.smartGlasses.left.firmwareVersion, "2.2.6.10");
  assert.equal(artifact.smartGlasses.right.hardwareRevision, 5);
  assert.equal(artifact.smartGlasses.installedMemoryReadback, false);
  assert.equal(artifact.smartGlasses.recoveryBundle.bytesBase64, "CQoLDA==");
  assert.deepEqual(
    artifact.smartGlasses.recoveryBundle.components.map(({ typeId }) => typeId),
    [0],
  );
});

test("rejects a recovery download whose size differs from the catalog", async () => {
  await assert.rejects(
    validateGlassesRecoveryBundle(Uint8Array.from([1, 2, 3]), release),
    /size does not match/,
  );
});

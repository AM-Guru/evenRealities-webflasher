import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  SYSTEM_BACKUP_SCHEMA_VERSION,
  buildG2SystemBackupArtifact,
  resolveGlassesRecoveryReleases,
  validateGlassesRecoveryBundle,
  validateSavedCaseBackup,
} from "../src/lib/backup.js";

if (!globalThis.crypto?.subtle) {
  globalThis.crypto = webcrypto;
}

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

const olderOfficialRelease = {
  channel: "official",
  trust: "official-pinned",
  version: "2.2.8.4",
  fileName: "official-2.2.8.4.bin",
  size: 4,
  sha256: "f".repeat(64),
  components: [
    {
      name: "ota/s200_firmware_ota.bin",
      typeId: 0,
      size: 321,
      crc32c: "99aabbcc",
      sha256: "9".repeat(64),
    },
  ],
};

test("resolves the official recovery bundle matching a same-version pair", () => {
  const resolution = resolveGlassesRecoveryReleases(
    [{ ...release, channel: "custom", fileName: "custom.bin" }, release],
    { left: makeProbe("left"), right: makeProbe("right") },
  );
  assert.equal(resolution.pairMatched, true);
  assert.equal(resolution.left.release, release);
  assert.equal(resolution.right.release, release);
  // One deduplicated bundle covers both routes.
  assert.deepEqual(resolution.releases, [release]);
  assert.equal(resolution.left.omissionReason, null);
});

test("a split-version pair resolves per-route official bundles instead of refusing", () => {
  const resolution = resolveGlassesRecoveryReleases([release, olderOfficialRelease], {
    left: makeProbe("left", "2.2.6.10"),
    right: makeProbe("right", "2.2.8.4"),
  });
  assert.equal(resolution.pairMatched, false);
  assert.equal(resolution.left.release, release);
  assert.equal(resolution.right.release, olderOfficialRelease);
  assert.deepEqual(resolution.releases, [release, olderOfficialRelease]);
});

test("the official-only fork records a custom-only version as an omission", () => {
  const customRelease = {
    ...olderOfficialRelease,
    channel: "custom",
    version: "2.2.8.11",
  };
  const resolution = resolveGlassesRecoveryReleases([release, customRelease], {
    left: makeProbe("left", "2.2.8.11"),
    right: makeProbe("right", "2.2.8.11"),
  });
  assert.equal(resolution.pairMatched, true);
  assert.equal(resolution.left.release, null);
  assert.match(resolution.left.omissionReason, /official G2 2\.2\.8\.11/);
  assert.deepEqual(resolution.releases, []);
});

test("an unarchived version becomes an explicit omission, not a failure", () => {
  const resolution = resolveGlassesRecoveryReleases([release], {
    left: makeProbe("left", "2.2.6.10"),
    right: makeProbe("right", "9.9.9.9"),
  });
  assert.equal(resolution.pairMatched, false);
  assert.equal(resolution.right.release, null);
  assert.match(resolution.right.omissionReason, /does not contain/);
  assert.deepEqual(resolution.releases, [release]);
});

const caseBackup = {
  flash: Uint8Array.from([1, 2, 3, 4]),
  optionBytes: Uint8Array.from([5, 6, 7, 8]),
  flashSha256: "d".repeat(64),
  optionSha256: "e".repeat(64),
};

const caseReport = {
  console: {
    caseVersion: "1.2.57",
    serialNumber: "ABC123",
    identifier: "AA BB CC DD EE FF 00 11",
    telemetry: { leftPresent: true, rightPresent: true },
  },
  options: { activePhysicalBank: 1 },
};

test("builds one recovery artifact with case bytes and both glasses", () => {
  const templeProbes = { left: makeProbe("left"), right: makeProbe("right") };
  const resolution = resolveGlassesRecoveryReleases([release], templeProbes);
  const artifact = buildG2SystemBackupArtifact({
    caseBackup,
    report: caseReport,
    templeProbes,
    recoveryResolution: resolution,
    recoveryBundles: [
      { release, bytes: Uint8Array.from([9, 10, 11, 12]) },
    ],
    createdAt: "2026-07-25T00:00:00.000Z",
  });

  assert.equal(artifact.schemaVersion, SYSTEM_BACKUP_SCHEMA_VERSION);
  assert.equal(artifact.chargingCase.flashBase64, "AQIDBA==");
  assert.equal(artifact.smartGlasses.left.firmwareVersion, "2.2.6.10");
  assert.equal(artifact.smartGlasses.right.hardwareRevision, 5);
  assert.equal(artifact.smartGlasses.installedMemoryReadback, false);
  assert.equal(artifact.smartGlasses.pairMatched, true);
  assert.equal(artifact.smartGlasses.recoveryBundles.length, 1);
  const [bundle] = artifact.smartGlasses.recoveryBundles;
  assert.deepEqual(bundle.coveredSides, ["left", "right"]);
  assert.equal(bundle.bytesBase64, "CQoLDA==");
  assert.deepEqual(
    bundle.components.map(({ typeId }) => typeId),
    [0],
  );
  assert.deepEqual(artifact.smartGlasses.recoveryBundleOmissions, []);
});

test("a split-pair artifact records per-route bundles and omissions", () => {
  const templeProbes = {
    left: makeProbe("left", "2.2.6.10"),
    right: makeProbe("right", "9.9.9.9"),
  };
  const resolution = resolveGlassesRecoveryReleases([release], templeProbes);
  const artifact = buildG2SystemBackupArtifact({
    caseBackup,
    report: caseReport,
    templeProbes,
    recoveryResolution: resolution,
    recoveryBundles: [
      { release, bytes: Uint8Array.from([9, 10, 11, 12]) },
    ],
    createdAt: "2026-07-25T00:00:00.000Z",
  });
  assert.equal(artifact.smartGlasses.pairMatched, false);
  assert.equal(artifact.smartGlasses.recoveryBundles.length, 1);
  assert.deepEqual(artifact.smartGlasses.recoveryBundles[0].coveredSides, [
    "left",
  ]);
  assert.deepEqual(
    artifact.smartGlasses.recoveryBundleOmissions.map(({ side }) => side),
    ["right"],
  );
});

test("a resolved bundle without its validated bytes still fails closed", () => {
  const templeProbes = { left: makeProbe("left"), right: makeProbe("right") };
  const resolution = resolveGlassesRecoveryReleases([release], templeProbes);
  assert.throws(
    () =>
      buildG2SystemBackupArtifact({
        caseBackup,
        report: caseReport,
        templeProbes,
        recoveryResolution: resolution,
        recoveryBundles: [],
      }),
    /were not provided/,
  );
});

test("rejects a recovery download whose size differs from the catalog", async () => {
  await assert.rejects(
    validateGlassesRecoveryBundle(Uint8Array.from([1, 2, 3]), release),
    /size does not match/,
  );
});

async function makeSavedCaseBackup() {
  const flash = new Uint8Array(512 * 1024).fill(0xa5);
  const optionBytes = new Uint8Array(128).fill(0x5a);
  const digest = async (bytes) =>
    Array.from(
      new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
  return {
    schemaVersion: 2,
    serialNumber: "ABC123",
    caseVersion: "1.2.57",
    flashSha256: await digest(flash),
    optionSha256: await digest(optionBytes),
    flashBase64: Buffer.from(flash).toString("base64"),
    optionBytesBase64: Buffer.from(optionBytes).toString("base64"),
  };
}

test("a saved case backup revalidates by recomputed digest and serial", async () => {
  const artifact = await makeSavedCaseBackup();
  const verified = await validateSavedCaseBackup(artifact, {
    expectedSerial: "ABC123",
  });
  assert.equal(verified.serialNumber, "ABC123");
  assert.equal(verified.flashSha256, artifact.flashSha256);
});

test("a saved case backup for another unit or with altered bytes is refused", async () => {
  const artifact = await makeSavedCaseBackup();
  await assert.rejects(
    validateSavedCaseBackup(artifact, { expectedSerial: "OTHER999" }),
    /Save a fresh backup/,
  );
  const tampered = {
    ...artifact,
    flashBase64: Buffer.from(new Uint8Array(512 * 1024).fill(0xa6)).toString(
      "base64",
    ),
  };
  await assert.rejects(
    validateSavedCaseBackup(tampered, { expectedSerial: "ABC123" }),
    /do not match its embedded bytes/,
  );
  await assert.rejects(
    validateSavedCaseBackup(
      { ...artifact, flashBase64: "AQID" },
      { expectedSerial: "ABC123" },
    ),
    /complete 512 KiB/,
  );
});

#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { parseEvenOTA } from "../src/lib/firmware.js";

const CDN_BASE = "https://cdn.evenreal.co/firmware";
function r1Release({
  version,
  minAppVersion,
  notes,
  size,
  md5,
  sha256,
  binSize,
  binSha256,
  datSha256,
  fallbacks,
}) {
  return {
    id: `r1-official-${version}`,
    displayName: `Official R1 ${version}`,
    version,
    channel: "official",
    trust: "official-pinned",
    format: "nordic-secure-dfu",
    fileName: `r1-${version}-${md5}.zip`,
    size,
    md5,
    sha256,
    sourceUrl: `${CDN_BASE}/${md5}.zip`,
    fallbacks: [
      [
        "repository",
        `public/firmware-updates/r1/${version}/r1-${version}-${md5}.zip`,
      ],
      ...(fallbacks ?? []),
    ],
    minAppVersion,
    notes,
    application: {
      binFile: "application.bin",
      binSize,
      binSha256,
      datFile: "application.dat",
      datSize: 141,
      datSha256,
    },
    initPacket: {
      applicationVersion: 3,
      hardwareVersion: 52,
      softDeviceFirmwareIds: [0x0100],
      signed: true,
    },
  };
}

const R1_RELEASES = [
  r1Release({
    version: "2.2.8.0002",
    minAppVersion: "2.2.8",
    notes: "Bug fixes.",
    size: 650915,
    md5: "ce5aa289bf6c95a293d41bd48c123e40",
    sha256: "662ca213e628f6bd82b8cd930bd63d6c1efe00b6f470fd6ed21e6367712bfdb7",
    binSize: 650284,
    binSha256: "41ea4fdcf1b2d1d3702c41669983b4ef0817ee4eb789f8eebc7dd6102609e274",
    datSha256: "1b9ede75c2d95b6d97e5b51dc396e0433d2575c4e04f63cc77e26218ccf13ea8",
  }),
  r1Release({
    version: "2.2.7.0005",
    minAppVersion: "2.2.7",
    notes:
      "Enhanced Bluetooth connection stability and fixed health data collection failures in specific scenarios.",
    size: 650007,
    md5: "be359b28954f8fe4a94ec21a58415d59",
    sha256: "6222e4bb334b531c3d2cfedfae2a26f609f0ffd99bd60a50bc8cced645c9eba5",
    binSize: 649376,
    binSha256: "2d38253e00b887ced3f1e2c049db21254b0974091bc954a82c13e21c48b064c2",
    datSha256: "68447d4dfc0ad7d77270797fe0dbf4311faef7eb5e275342033e5b373be93be9",
  }),
  r1Release({
    version: "2.2.6.0009",
    minAppVersion: "2.2.6",
    notes: "Updated the sleep algorithm to improve measurement accuracy; bug fixes.",
    size: 647039,
    md5: "9eca8ae9d5117abda4f72f39bdb44ad2",
    sha256: "492baf487734720732f82f404624e0c3b3af3b01d30727366238e154164ad0dd",
    fallbacks: [[
      "current",
      "firmware/ota/2026-07-22/r1-2.2.6.0009-9eca8ae9d5117abda4f72f39bdb44ad2.zip",
    ]],
    binSize: 646408,
    binSha256: "0e788d433ea50fd36edb8f21a9c18b6062211e4a36dbc5bd7695ea5827f3aa1a",
    datSha256: "305da36784e527b3e434f2cf45019a290bf5c14cbceb2e57c9e61dcdfdb1f253",
  }),
  r1Release({
    version: "2.2.5.0005",
    minAppVersion: "2.2.5",
    notes:
      "Updated Calorie goals to Active Calories in Health and optimized R1 health data syncing in specific scenarios.",
    size: 644583,
    md5: "83038dad13c339f9e5f2e5fc828a00b3",
    sha256: "46102dd54d86fb24fb5f1a2c8ba9f9d54e6a603659240dd59fc43b1ee564e778",
    binSize: 643952,
    binSha256: "221fb44aa6ff954dc73978d3848ed466913e2bebcfada4aaa8984610d7e2a6e2",
    datSha256: "e4518bc50ee225024cca96dd581d955f9650dc8b0450060fa7b22b9ccf4c0847",
  }),
  r1Release({
    version: "2.2.4.0003",
    minAppVersion: "2.2.4",
    notes:
      "Update both Even G2 and R1 to 2.2.4 to prevent Bluetooth issues. Adds hand preference settings, improves Bluetooth stability, and adds the R1 battery level to Dashboard.",
    size: 638259,
    md5: "248978eb758a342a0254d6dae45bfdb2",
    sha256: "549d60061c1cc9cde94da5c3c0efc0e7220272aca6c872c49bde0ec30ae16dcc",
    binSize: 637628,
    binSha256: "a347128b46bfb01e6c02bc2a93768bc0838ae73c1e7ad401dd29841cc930647f",
    datSha256: "56f017384d7bbc73f47f018b601dd13bceda3f27f4b09f2f89586981c1429e0e",
  }),
  r1Release({
    version: "2.2.0.0014",
    minAppVersion: "2.2.0",
    notes: "Charging, Bluetooth, and touch sensor bug fixes.",
    size: 633367,
    md5: "9ae5429275afdcb2ff86c53152bef1cb",
    sha256: "9ce535518d1321a27186394355e05aff7b4ba76be58c8de1a0dfcf3b01395d00",
    binSize: 632736,
    binSha256: "590584f3d56dc4b495d6454823fe177f042225b55c7d098abab479041f641d36",
    datSha256: "e77d2fdf34eb94e3d955e0b23e0913b4622d46c9f9aa5b5ff0b8cc29f23a85c1",
  }),
  r1Release({
    version: "2.0.8.0012",
    minAppVersion: "2.0.8",
    notes: "Fixed potential system crashes and abnormal power consumption in certain scenarios.",
    size: 626207,
    md5: "90a6479e4d736365192f30556cba44a5",
    sha256: "6bc6567f656d3905683000278af529ad516f45d8e9516618ffad2cb4ea7adf2b",
    binSize: 625576,
    binSha256: "8a3db3c56bf4cddd0a02eebc4090857f6e8907ae2108ce9487f8b8bdee7c96df",
    datSha256: "fb80c99d3eba14e8ae80ca7908bdb3bb928e5829968f37f247a8b7e3041f7c63",
  }),
  r1Release({
    version: "2.0.7.0004",
    minAppVersion: "2.0.7",
    notes:
      "Added the ability to restart R1 from the app and fixed Touch Sensor unresponsiveness in certain scenarios.",
    size: 628831,
    md5: "692af8c7baed67e20c5920d350dd466e",
    sha256: "ba499025ab86cf3679eb5f19e6322422c1ef7f3304ce386f7e1e1dddf7ef5e08",
    binSize: 628200,
    binSha256: "1045569b5ca10cdb6c3991304f8b7273c18cd302b28d65f2647ed947984c8f2a",
    datSha256: "3b9fc345ca31f709732debfa5cc81b00dfb78ed56f90e592ca82287249fd4dcc",
  }),
  r1Release({
    version: "2.0.6.0005",
    minAppVersion: "2.0.6",
    notes:
      "Optimized R1 power efficiency for longer battery life and fixed abnormal collection for certain health metrics.",
    size: 622931,
    md5: "37c8d118670c97f3e218c4a5f2f30951",
    sha256: "5ef38db1e80a40859dd14e2914732193d8e3162ef118e37173e3fa45125d1d85",
    binSize: 622300,
    binSha256: "5ef4eb77076c1054bf95c7781787963607a6a61af4b338cb98c39ca7fa7831b6",
    datSha256: "376d60acc327068dd7c1fe4d3133c32a512b762bde19ef00866432f71e2aba4d",
  }),
  r1Release({
    version: "2.0.5.0004",
    minAppVersion: "2.0.5",
    notes:
      "Optimized the SpO2 measurement algorithm and fixed Bluetooth connection and crash issues.",
    size: 618755,
    md5: "3f7990f1d725be5c544103dc03e1ae54",
    sha256: "893e9c72e5ad1ef2950309c4ed48a81af8bbedd920240d8bf6ebf4be122b5763",
    binSize: 618124,
    binSha256: "5fb80f2f4f1cc37299bdfc9695d08c13d5d5052dfd64d485852aba098d66dcec",
    datSha256: "afa75e575683db8a219c4b01ac9a0b32c76c6dcea2ea71f7db5ccf7bdd632eba",
  }),
  r1Release({
    version: "2.0.3.0013",
    minAppVersion: "2.0.4",
    notes: "Improves Bluetooth stability and optimizes battery life.",
    size: 619023,
    md5: "da3c754078c1e9dd0b2fe282e4614783",
    sha256: "a24ddd6c580a2706f98c06b6504bb34af7159024ad8bb066eca6ae684e533c6f",
    binSize: 618392,
    binSha256: "c74c61beb5c30f671d2094a3f9a9310dbb556e7cf01d73c77dfca66d31a2b590",
    datSha256: "816e350b7d36240b7e33252141680baf39da06f7619bb1e51d80df83d73068b5",
  }),
];
// Stock 2.2.6.10 remains hardware-validated recovery evidence.
const HARDWARE_VALIDATED_TEMPLE_IMAGES = new Set([
  "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa",
]);
const RELEASES = [
  {
    version: "2.0.1.14",
    hash: "09fe9c0df7b14385c023bc35a364b3a9",
    size: 3232068,
    fallbacks: [["v2", "firmware/versions/v2.0.1.14/09fe9c0df7b14385c023bc35a364b3a9.bin"]],
  },
  {
    version: "2.0.3.20",
    hash: "57201a6e7cd6dadeee1bdb8f6ed98606",
    size: 3832044,
    fallbacks: [["v2", "firmware/versions/v2.0.3.20/57201a6e7cd6dadeee1bdb8f6ed98606.bin"]],
  },
  {
    version: "2.0.5.12",
    hash: "53486f03b825cb22d13e769187b46656",
    size: 3921853,
    fallbacks: [["v2", "firmware/versions/v2.0.5.12/53486f03b825cb22d13e769187b46656.bin"]],
  },
  {
    version: "2.0.6.14",
    hash: "0c9f9ca58785547278a5103bc6ae7a09",
    size: 3954281,
    fallbacks: [["v2", "firmware/versions/v2.0.6.14/0c9f9ca58785547278a5103bc6ae7a09.bin"]],
  },
  {
    version: "2.0.7.16",
    hash: "650176717d1f30ef684e5f812500903c",
    size: 3958551,
    fallbacks: [["v2", "firmware/versions/v2.0.7.16/650176717d1f30ef684e5f812500903c.bin"]],
  },
  {
    version: "2.0.8.20",
    hash: "d2d778f1b3fd8dad8e12dfc000109657",
    size: 4051861,
    fallbacks: [["v2", "firmware/versions/v2.0.8.20/d2d778f1b3fd8dad8e12dfc000109657.bin"]],
  },
  {
    version: "2.0.9.20",
    hash: "77de41924c3a7e0402921017140c7456",
    size: 4068333,
    fallbacks: [["v2", "firmware/versions/v2.0.9.20/77de41924c3a7e0402921017140c7456.bin"]],
  },
  {
    version: "2.1.1.8",
    hash: "51f4af4b287af7b4572b4b3e59cecb89",
    size: 4076732,
    fallbacks: [["v2", "firmware/versions/v2.1.1.8/51f4af4b287af7b4572b4b3e59cecb89.bin"]],
  },
  {
    version: "2.1.1.12",
    hash: "55c8b82d3d12a82f22453c7e9c8d8e05",
    size: 4082768,
    fallbacks: [[
      "v2",
      "captures/terminal/20260427-225543/sdcard_Android_data_com.even.sg/files/evenTemp/55c8b82d3d12a82f22453c7e9c8d8e05.bin",
    ]],
  },
  {
    version: "2.2.0.24",
    hash: "a0a293189243b71ca581bda1493da1da",
    size: 3997044,
    fallbacks: [[
      "v2",
      "captures/terminal/20260427-225543/sdcard_Android_data_com.even.sg/files/evenTemp/a0a293189243b71ca581bda1493da1da.bin",
    ]],
  },
  {
    version: "2.2.4.34",
    hash: "a6966d807634cc97aec641a0dcca358b",
    size: 4131592,
  },
  {
    version: "2.2.6.10",
    hash: "e28738432d7b612d625331b00383149b",
    size: 4301227,
    fallbacks: [[
      "current",
      "firmware/ota/2026-07-22/g2-2.2.6.10-e28738432d7b612d625331b00383149b.bin",
    ]],
  },
  {
    version: "2.2.7.14",
    hash: "ededa3729ef16cb2948fa54c44e1dd09",
    sha256: "0fced0aebcc6c88db6f76dba34f91b805d842a5fc297bfd7fa6d6a34ec83cecb",
    size: 4335715,
    notes:
      "Enhanced Bluetooth connection stability and Teleprompt AI noise reduction; fixed Teleprompt Remote Control and earlier-version firmware update failures in specific scenarios.",
  },
  {
    version: "2.2.8.4",
    hash: "d495a1dffb919795e95135e144345f04",
    sha256: "df7b8bd18727765eba73be5ab836e0ee4cfd17b5e680046003b8d608d2fbfda7",
    size: 4342507,
    notes: "Added Korean system language support.",
  },
];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function digest(algorithm, data) {
  return createHash(algorithm).update(data).digest("hex");
}

function archiveKeyFor(release) {
  if (release.channel === "custom") {
    if (!/^[a-f0-9]{64}$/.test(release.sha256 ?? "")) {
      throw new Error(
        `Reviewed CFW ${release.version} needs a pinned SHA-256 before it can be archived`,
      );
    }
    const contentAddressedKey = `${release.version}-${release.sha256.slice(0, 12)}`;
    if (release.archiveKey && release.archiveKey !== contentAddressedKey) {
      throw new Error(
        `Reviewed CFW ${release.version} archive key must match its pinned SHA-256`,
      );
    }
    return contentAddressedKey;
  }
  return release.archiveKey ?? release.version;
}

function applyReviewedPatchSet(stock, patchSet) {
  let result = Buffer.from(stock);
  for (const [index, operation] of patchSet.patches.entries()) {
    const oldBytes = Buffer.from(operation.old, "hex");
    const newBytes = Buffer.from(operation.new, "hex");
    if (
      operation.old.length !== oldBytes.length * 2 ||
      operation.new.length !== newBytes.length * 2
    ) {
      throw new Error(`CFW patch operation ${index + 1} contains malformed hex`);
    }
    if (oldBytes.length === 0) {
      if (operation.offset !== result.length) {
        throw new Error(
          `CFW append operation ${index + 1} targets ${operation.offset}, expected ${result.length}`,
        );
      }
      result = Buffer.concat([result, newBytes]);
      continue;
    }
    if (oldBytes.length !== newBytes.length) {
      throw new Error(`CFW patch operation ${index + 1} changes an in-place length`);
    }
    const found = result.subarray(
      operation.offset,
      operation.offset + oldBytes.length,
    );
    if (!found.equals(oldBytes)) {
      throw new Error(`CFW patch operation ${index + 1} did not match the stock bytes`);
    }
    newBytes.copy(result, operation.offset);
  }
  return result;
}

async function download(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "evenRealities-webflasher-Firmware-Archive/1.0" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function acquireRelease(release, sourceUrl, fallbackRoots) {
  async function acquireFallback() {
    for (const [rootName, relativePath] of release.fallbacks ?? []) {
      const fallbackRoot = fallbackRoots[rootName];
      if (!fallbackRoot) continue;
      const fallbackPath = path.join(fallbackRoot, relativePath);
      try {
        return {
          bytes: await readFile(fallbackPath),
          archivedFrom: "Repository firmware archive",
        };
      } catch {
        // Continue through every known local preservation path.
      }
    }
    return null;
  }

  if (release.preferLocalEvidence) {
    const local = await acquireFallback();
    if (local) return local;
  }
  try {
    return {
      bytes: await download(sourceUrl),
      archivedFrom:
        release.channel === "custom"
          ? "Repository firmware mirror"
          : "Even Realities CDN",
    };
  } catch (downloadError) {
    const local = await acquireFallback();
    if (local) return local;
    throw new Error(
      `Could not acquire G2 ${release.version} from the CDN or local evidence: ${downloadError.message}`,
    );
  }
}

async function saveRelease(root, release, fallbackRoots) {
  // Reviewed firmware can legitimately be rebuilt without changing the version
  // reported by the glasses. Content-addressing it keeps every published URL
  // immutable and prevents a later deployment from colliding with older bytes.
  const archiveKey = archiveKeyFor(release);
  if (!/^2\.[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/.test(archiveKey)) {
    throw new Error(`G2 ${release.version} has an invalid archive key`);
  }
  const directory = path.join(root, archiveKey);
  await mkdir(directory, { recursive: true });
  const sourceFile = release.fileName ?? `${release.hash}.bin`;
  const customSourceRoot =
    `https://am-guru.github.io/evenRealities-webflasher/firmware-updates/g2/${archiveKey}`;
  const sourceUrl = release.sourceUrl ?? (
    release.channel === "custom"
      ? `${customSourceRoot}/${sourceFile}`
      : `${CDN_BASE}/${sourceFile}`
  );
  const acquisitionRelease = {
    ...release,
    preferLocalEvidence: true,
    fallbacks: [
      [
        "repository",
        `public/firmware-updates/g2/${archiveKey}/${sourceFile}`,
      ],
      ...(release.fallbacks ?? []),
    ],
  };
  process.stdout.write(
    `Downloading ${release.channel === "custom" ? "reviewed CFW" : "official G2"} ${release.version}… `,
  );
  const { bytes, archivedFrom } = await acquireRelease(
    acquisitionRelease,
    sourceUrl,
    fallbackRoots,
  );
  const md5 = digest("md5", bytes);
  const sha256 = digest("sha256", bytes);
  if (bytes.length !== release.size) {
    throw new Error(
      `G2 ${release.version} size ${bytes.length} does not match ${release.size}`,
    );
  }
  if (md5 !== release.hash) {
    throw new Error(`G2 ${release.version} MD5 ${md5} does not match its pinned digest`);
  }
  if (release.sha256 && sha256 !== release.sha256) {
    throw new Error(
      `G2 ${release.version} SHA-256 ${sha256} does not match its pinned digest`,
    );
  }

  const parsed = parseEvenOTA(bytes);
  if (parsed.version !== (release.internalVersion ?? release.version)) {
    throw new Error(
      `G2 ${release.version} bundle reports internal version ${parsed.version}`,
    );
  }

  const files = [];
  async function put(name, data) {
    const target = path.join(directory, name);
    await writeFile(target, data);
    files.push({
      name,
      size: data.length,
      sha256: digest("sha256", data),
    });
  }

  await put(sourceFile, bytes);
  let patchFile = null;
  let patchSha256 = null;
  let patchSet = null;
  const patchSourceUrl = release.patchUrl ?? (
    release.channel === "custom" && release.patchFileName
      ? `${customSourceRoot}/${release.patchFileName}`
      : null
  );
  const patchFallback = release.patchFallback ?? (
    release.channel === "custom" && release.patchFileName
      ? `public/firmware-updates/g2/${archiveKey}/${release.patchFileName}`
      : null
  );
  const patchFallbackRoot = release.patchFallbackRoot ?? "webflasher";
  if (patchSourceUrl) {
    let patchBytes;
    if (release.preferLocalEvidence && patchFallback) {
      patchBytes = await readFile(
        path.join(fallbackRoots[patchFallbackRoot], patchFallback),
      );
    } else try {
      patchBytes = await download(patchSourceUrl);
    } catch (downloadError) {
      if (!patchFallback) throw downloadError;
      patchBytes = await readFile(
        path.join(fallbackRoots[patchFallbackRoot], patchFallback),
      );
    }
    patchSet = JSON.parse(patchBytes.toString("utf8"));
    const patchVersion = patchSet.release_version ?? patchSet.version;
    const patchBaseVersion =
      patchSet.vendor_base_version ?? patchSet.base_version;
    const baseRelease = RELEASES.find(
      (candidate) =>
        candidate.version === release.baseVersion &&
        (candidate.channel ?? "official") === "official",
    );
    if (!baseRelease) throw new Error("The reviewed CFW stock base is not in the archive");
    if (
      patchSet.base_sha256 !== release.baseSha256 ||
      patchSet.output_sha256 !== release.sha256 ||
      patchVersion !== release.version ||
      patchBaseVersion !== release.baseVersion ||
      !Array.isArray(patchSet.patches) ||
      patchSet.patches.length !== release.patchCount ||
      (release.capabilityMarker &&
        patchSet.capability_marker !== release.capabilityMarker) ||
      (release.g2flashCommit &&
        patchSet.source_provenance?.g2flash_upstream_commit !==
          release.g2flashCommit) ||
      (release.g2flashPatchSha256 &&
        (patchSet.g2flash_patch_sha256 !== release.g2flashPatchSha256 ||
          patchSet.source_provenance?.g2flash_patch_sha256 !==
            release.g2flashPatchSha256)) ||
      (release.g2flashOutputSha256 &&
        (patchSet.g2flash_output_sha256 !== release.g2flashOutputSha256 ||
          patchSet.source_provenance?.g2flash_output_sha256 !==
            release.g2flashOutputSha256)) ||
      (release.g2flashRebasePatchSha256 &&
        (patchSet.g2flash_rebase_patch_sha256 !==
          release.g2flashRebasePatchSha256 ||
          patchSet.source_provenance?.g2flash_rebase_patch_sha256 !==
            release.g2flashRebasePatchSha256)) ||
      (release.bleAdvertisingPatchSha256 &&
        (patchSet.ble_advertising_patch_sha256 !==
          release.bleAdvertisingPatchSha256 ||
          patchSet.source_provenance?.ble_advertising_patch_sha256 !==
            release.bleAdvertisingPatchSha256)) ||
      (release.bleAdvertisingSources &&
        (JSON.stringify(patchSet.ble_advertising_sources) !==
          JSON.stringify(release.bleAdvertisingSources) ||
          JSON.stringify(patchSet.source_provenance?.ble_advertising_sources) !==
            JSON.stringify(release.bleAdvertisingSources))) ||
      (release.excludedFeature &&
        (JSON.stringify(patchSet.excluded_feature) !==
          JSON.stringify(release.excludedFeature) ||
          JSON.stringify(patchSet.source_provenance?.excluded_feature) !==
            JSON.stringify(release.excludedFeature))) ||
      (release.directFramebufferCommits &&
        JSON.stringify(patchSet.source_provenance?.direct_framebuffer_commits) !==
          JSON.stringify(release.directFramebufferCommits))
    ) {
      throw new Error("The reviewed CFW patch recipe does not match its pinned trust boundary");
    }
    const baseFile = baseRelease.fileName ?? `${baseRelease.hash}.bin`;
    const stockBytes = await readFile(
      path.join(root, release.baseVersion, baseFile),
    );
    if (digest("sha256", stockBytes) !== release.baseSha256) {
      throw new Error("The archived CFW stock base does not match its pinned SHA-256");
    }
    const rebuiltCFW = applyReviewedPatchSet(stockBytes, patchSet);
    if (
      digest("sha256", rebuiltCFW) !== release.sha256 ||
      !rebuiltCFW.equals(bytes)
    ) {
      throw new Error(
        "The reviewed patch recipe does not reproduce the archived CFW byte-for-byte",
      );
    }
    patchFile = release.patchFileName;
    patchSha256 = digest("sha256", patchBytes);
    await put(patchFile, patchBytes);
  }
  for (const component of parsed.components) {
    await put(component.name.replaceAll("/", "_"), component.payload);
    if (component.typeId === 6) {
      await put("firmware_box.raw.bin", parsed.chargingCase.rawImage);
    }
  }

  let manifestFile = null;
  let manifestSha256 = null;
  if (release.manifestFileName) {
    manifestFile = release.manifestFileName;
    const firmwareFiles = parsed.components.map((component) => ({
      componentName: component.name,
      archiveFile: component.name.replaceAll("/", "_"),
      typeId: component.typeId,
      size: component.payloadSize,
      crc32c: component.crc32c.toString(16).padStart(8, "0"),
      sha256: digest("sha256", component.payload),
      role:
        component.typeId === 0
          ? "glasses-application"
          : component.typeId === 1
            ? "glasses-bootloader"
            : component.typeId === 6
              ? "charging-case"
              : "device-component",
    }));
    const manifest = {
      schemaVersion: 1,
      format: "evenota-hardware-flash-manifest-v1",
      device: "Even Realities G2",
      release: {
        version: release.version,
        ...(archiveKey !== release.version ? { archiveKey } : {}),
        internalVersion: parsed.version,
        reportedVersion: release.reportedVersion ?? parsed.version,
        channel: release.channel ?? "official",
        trust: release.trust ?? "official-pinned",
        baseVersion: release.baseVersion ?? null,
        hardwareValidated: HARDWARE_VALIDATED_TEMPLE_IMAGES.has(sha256),
      },
      package: {
        file: sourceFile,
        size: bytes.length,
        md5,
        sha256,
        componentCount: parsed.components.length,
      },
      patchRecipe: patchFile
        ? {
            file: patchFile,
            sha256: patchSha256,
            baseVersion: release.baseVersion,
            baseSha256: release.baseSha256,
            operationCount: patchSet.patches.length,
          }
        : null,
      capabilityMarker: patchSet?.capability_marker ?? null,
      sourceProvenance: patchSet?.source_provenance ?? null,
      excludedFeature: patchSet?.source_provenance?.excluded_feature ?? null,
      firmwareFiles,
      chargingCaseRawImage: {
        file: "firmware_box.raw.bin",
        size: parsed.chargingCase.rawImage.length,
        sha256: digest("sha256", parsed.chargingCase.rawImage),
      },
      flashTargets: {
        completeBundle: sourceFile,
        glassesApplication: "ota_s200_firmware_ota.bin",
        glassesBootloader: "ota_s200_bootloader.bin",
        chargingCaseWrapped: "firmware_box.bin",
        chargingCaseRaw: "firmware_box.raw.bin",
      },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    manifestSha256 = digest("sha256", manifestBytes);
    await put(manifestFile, manifestBytes);
  }

  const metadata = {
    schemaVersion: 2,
    device: "Even Realities G2",
    version: release.version,
    ...(archiveKey !== release.version ? { archiveKey } : {}),
    internalVersion: parsed.version,
    reportedVersion: release.reportedVersion ?? parsed.version,
    channel: release.channel ?? "official",
    trust: release.trust ?? "official-pinned",
    hardwareValidated: HARDWARE_VALIDATED_TEMPLE_IMAGES.has(sha256),
    baseVersion: release.baseVersion ?? null,
    notes: release.notes ?? null,
    capabilities: release.capabilities ?? [],
    caseVersion: parsed.chargingCase.version,
    sourceUrl,
    archivedFrom,
    sourceFile,
    sourceMd5: md5,
    sourceSha256: sha256,
    sourceSize: bytes.length,
    patchUrl: patchSourceUrl,
    patchFile,
    patchSha256,
    manifestFile,
    manifestSha256,
    archivedAt: new Date().toISOString(),
    mainFirmware: parsed.mainFirmware
      ? {
          runBase: `0x${parsed.mainFirmware.runBase.toString(16).padStart(8, "0")}`,
          installedImageSize: parsed.mainFirmware.installedImageSize,
          installedImageEnd: `0x${parsed.mainFirmware.installedImageEnd
            .toString(16)
            .padStart(8, "0")}`,
          crc32: parsed.mainFirmware.crc32
            .toString(16)
            .padStart(8, "0"),
        }
      : null,
    components: parsed.components.map((component) => ({
      name: component.name,
      typeId: component.typeId,
      size: component.payloadSize,
      crc32c: component.crc32c
        .toString(16)
        .padStart(8, "0"),
      sha256: digest("sha256", component.payload),
    })),
    files,
  };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(path.join(directory, "metadata.json"), metadataBytes);
  files.push({
    name: "metadata.json",
    size: metadataBytes.length,
    sha256: digest("sha256", metadataBytes),
  });
  const sums = files
    .map((file) => `${file.sha256}  ${file.name}`)
    .sort()
    .join("\n");
  await writeFile(path.join(directory, "SHA256SUMS"), `${sums}\n`);
  process.stdout.write(`verified (${parsed.chargingCase.version} case)\n`);

  return {
    id: release.id ?? `g2-official-${release.version}`,
    ...(release.displayName ? { displayName: release.displayName } : {}),
    channel: release.channel ?? "official",
    trust: release.trust ?? "official-pinned",
    hardwareValidated: HARDWARE_VALIDATED_TEMPLE_IMAGES.has(sha256),
    version: release.version,
    ...(archiveKey !== release.version ? { archiveKey } : {}),
    internalVersion: parsed.version,
    reportedVersion: release.reportedVersion ?? parsed.version,
    baseVersion: release.baseVersion ?? null,
    notes: release.notes ?? null,
    capabilities: release.capabilities ?? [],
    recoveryTarget: release.channel === "custom" ? "glasses" : "case-and-glasses-bundle",
    caseRecoveryEligible: release.channel !== "custom",
    caseVersion: parsed.chargingCase.version,
    url: `/firmware-updates/g2/${archiveKey}/${sourceFile}`,
    sourceUrl,
    fileName: sourceFile,
    size: bytes.length,
    md5,
    sha256,
    patchUrl: patchSourceUrl
      ? `/firmware-updates/g2/${archiveKey}/${patchFile}`
      : null,
    patchSha256,
    ...(manifestFile
      ? {
          manifestUrl: `/firmware-updates/g2/${archiveKey}/${manifestFile}`,
          manifestSha256,
        }
      : {}),
    archivedFrom,
    mainFirmware: metadata.mainFirmware,
    components: metadata.components,
  };
}

async function saveRingRelease(root, release, fallbackRoots) {
  const directory = path.join(root, "r1", release.version);
  await mkdir(directory, { recursive: true });
  process.stdout.write(`Acquiring official R1 ${release.version}… `);
  const acquisitionRelease = {
    ...release,
    preferLocalEvidence: true,
    fallbacks: [
      [
        "repository",
        `public/firmware-updates/r1/${release.version}/${release.fileName}`,
      ],
      ...(release.fallbacks ?? []),
    ],
  };
  const { bytes, archivedFrom } = await acquireRelease(
    acquisitionRelease,
    release.sourceUrl,
    fallbackRoots,
  );
  if (
    bytes.length !== release.size ||
    digest("md5", bytes) !== release.md5 ||
    digest("sha256", bytes) !== release.sha256
  ) {
    throw new Error(`R1 ${release.version} ZIP does not match its pinned size and digests`);
  }

  const files = unzipSync(bytes);
  const fileNames = Object.keys(files).sort();
  if (
    JSON.stringify(fileNames) !==
    JSON.stringify(["application.bin", "application.dat", "manifest.json"])
  ) {
    throw new Error(`R1 ${release.version} ZIP contains an unexpected file set`);
  }
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
  const normalizedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const declared = manifest?.manifest?.application;
  if (
    declared?.bin_file !== release.application.binFile ||
    declared?.dat_file !== release.application.datFile
  ) {
    throw new Error(`R1 ${release.version} manifest does not select the pinned application`);
  }
  const application = Buffer.from(files[release.application.binFile]);
  const initPacket = Buffer.from(files[release.application.datFile]);
  if (
    application.length !== release.application.binSize ||
    digest("sha256", application) !== release.application.binSha256 ||
    initPacket.length !== release.application.datSize ||
    digest("sha256", initPacket) !== release.application.datSha256
  ) {
    throw new Error(`R1 ${release.version} application components failed verification`);
  }

  await writeFile(path.join(directory, release.fileName), bytes);
  await writeFile(path.join(directory, release.application.binFile), application);
  await writeFile(path.join(directory, release.application.datFile), initPacket);
  await writeFile(path.join(directory, "manifest.json"), normalizedManifest);
  const metadata = {
    schemaVersion: 2,
    device: "Even Realities R1",
    version: release.version,
    channel: release.channel,
    trust: release.trust,
    format: release.format,
    sourceUrl: release.sourceUrl,
    archivedFrom,
    archivedAt: new Date().toISOString(),
    sourceFile: release.fileName,
    sourceMd5: release.md5,
    sourceSha256: release.sha256,
    sourceSize: release.size,
    minAppVersion: release.minAppVersion ?? null,
    notes: release.notes ?? null,
    application: release.application,
    initPacket: release.initPacket,
  };
  await writeFile(
    path.join(directory, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, "SHA256SUMS"),
    [
      `${release.application.binSha256}  ${release.application.binFile}`,
      `${release.application.datSha256}  ${release.application.datFile}`,
      `${digest("sha256", normalizedManifest)}  manifest.json`,
      `${release.sha256}  ${release.fileName}`,
    ].join("\n") + "\n",
  );
  process.stdout.write("verified (signed Nordic Secure DFU)\n");
  return {
    id: release.id,
    displayName: release.displayName,
    channel: release.channel,
    trust: release.trust,
    version: release.version,
    format: release.format,
    url: `/firmware-updates/r1/${release.version}/${release.fileName}`,
    sourceUrl: release.sourceUrl,
    fileName: release.fileName,
    size: release.size,
    md5: release.md5,
    sha256: release.sha256,
    archivedFrom,
    minAppVersion: release.minAppVersion ?? null,
    notes: release.notes ?? null,
    application: release.application,
    initPacket: release.initPacket,
  };
}

// Emits the temple writer's compiled-in allowlist. It is deliberately a source
// file rather than something read from index.json at runtime: the writer's final
// trust gate must not be widenable by a tampered catalog.
async function writeTempleFlashTargets(releases) {
  const targets = [];
  for (const release of releases) {
    const main = (release.components ?? []).find(
      (component) =>
        component.name === "ota/s200_firmware_ota.bin" && component.typeId === 0,
    );
    if (!main?.sha256) continue;
    const custom = release.channel === "custom";
    targets.push({
      imageSha256: release.sha256,
      mainSha256: main.sha256,
      mainBytes: main.size,
      version: release.internalVersion ?? release.version,
      reportedVersion:
        release.reportedVersion ?? release.internalVersion ?? release.version,
      label: custom
        ? release.displayName ?? `Community firmware (${release.version})`
        : `Stock Even Realities G2 ${release.version}`,
      // Only images with a recorded successful hardware transfer may claim this.
      hardwareValidated: HARDWARE_VALIDATED_TEMPLE_IMAGES.has(release.sha256),
    });
  }
  const entries = targets
    .map(
      (target) =>
        `  Object.freeze({\n` +
        `    imageSha256: ${JSON.stringify(target.imageSha256)},\n` +
        `    mainSha256: ${JSON.stringify(target.mainSha256)},\n` +
        `    mainBytes: ${target.mainBytes},\n` +
        `    version: ${JSON.stringify(target.version)},\n` +
        `    reportedVersion: ${JSON.stringify(target.reportedVersion)},\n` +
        `    label: ${JSON.stringify(target.label)},\n` +
        `    hardwareValidated: ${target.hardwareValidated},\n` +
        `  })`,
    )
    .join(",\n");
  const source = `// GENERATED FILE — do not edit by hand.
// Rebuild with: npm run archive:firmware
//
// Every Apollo-main payload that the temple writer is permitted to install.
// This table is the writer's own trust root: it is compiled into the bundle and
// is deliberately independent of the fetched firmware catalog, so a tampered
// index.json cannot widen what may be written to a temple.
//
// hardwareValidated marks images whose case-USB temple transfer has actually
// been exercised on hardware. Pinned-but-unvalidated images are still gated on
// exact hashes; they simply have no transfer evidence behind them yet.

export const TEMPLE_FLASH_TARGETS = Object.freeze([
${entries},
]);

export function findTempleFlashTarget(imageSha256) {
  if (typeof imageSha256 !== "string") return null;
  const digest = imageSha256.toLowerCase();
  return TEMPLE_FLASH_TARGETS.find((t) => t.imageSha256 === digest) ?? null;
}
`;
  const here = path.dirname(fileURLToPath(import.meta.url));
  await writeFile(path.join(here, "..", "src", "lib", "templeFlashTargets.js"), source);
  return targets.length;
}

async function main() {
  const defaultOutput = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../firmware-archive",
  );
  const output = path.resolve(argument("--output", defaultOutput));
  const r1Only = process.argv.includes("--r1-only");
  const requestedG2Release = argument("--release", null);
  if (r1Only && requestedG2Release) {
    throw new Error("--r1-only and --release cannot be combined");
  }
  const fallbackRoots = {
    repository: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    ),
  };
  await mkdir(output, { recursive: true });
  let existingIndex = {};
  if (r1Only || requestedG2Release) {
    try {
      existingIndex = JSON.parse(await readFile(path.join(output, "index.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const selectedG2Releases = requestedG2Release
    ? RELEASES.filter(
        (release) =>
          release.id === requestedG2Release || release.version === requestedG2Release,
      )
    : RELEASES;
  if (requestedG2Release && selectedG2Releases.length !== 1) {
    throw new Error(`Unknown or ambiguous G2 release: ${requestedG2Release}`);
  }
  const catalog = [];
  if (!r1Only) {
    for (const release of selectedG2Releases) {
      catalog.push(
        await saveRelease(path.join(output, "g2"), release, fallbackRoots),
      );
    }
  }
  const ringCatalog = [];
  if (requestedG2Release) {
    ringCatalog.push(...(existingIndex.ringReleases ?? []));
  } else {
    for (const release of R1_RELEASES) {
      ringCatalog.push(await saveRingRelease(output, release, fallbackRoots));
    }
  }
  const mergedCatalog = requestedG2Release
    ? [
        ...(existingIndex.releases ?? []).filter(
          (existing) =>
            !catalog.some(
              (updated) =>
                updated.id === existing.id ||
                (updated.version === existing.version &&
                  updated.channel === existing.channel),
            ),
        ),
        ...catalog,
      ]
    : catalog;
  const index = {
    ...existingIndex,
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source: "Even Realities CDN and release evidence included in this repository",
    releases: r1Only
      ? existingIndex.releases ?? []
      : mergedCatalog.sort((left, right) => {
          const versionOrder = right.version.localeCompare(left.version, undefined, {
            numeric: true,
          });
          if (versionOrder !== 0) return versionOrder;
          return left.channel === "custom" ? -1 : 1;
        }),
    ringReleases: ringCatalog.sort((left, right) =>
      right.version.localeCompare(left.version, undefined, { numeric: true }),
    ),
  };
  await writeFile(
    path.join(output, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  const targets = r1Only ? null : await writeTempleFlashTargets(index.releases);
  if (!r1Only) {
    process.stdout.write(`Archived ${catalog.length} verified G2 releases in ${output}\n`);
  }
  process.stdout.write(`Archived ${ringCatalog.length} verified R1 release(s)\n`);
  if (targets !== null) {
    process.stdout.write(
      `Pinned ${targets} temple-flash Apollo-main target(s) in src/lib/templeFlashTargets.js\n`,
    );
  }
}

await main();

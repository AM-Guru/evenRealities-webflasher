// Does the served firmware library still cover what this build can install?
//
// The compiled-in TEMPLE_FLASH_TARGETS allowlist is the writer's trust root.
// The fetched catalog is only the menu offered on top of it. The two are
// published by different paths, so they can drift — and on 2026-07-28 they did:
// production served a catalog whose newest CFW was the legacy 2.2.6.10 build
// while the running bundle already trusted reviewed CFW 2.2.6.11. Nothing on
// screen said so, and selecting "the CFW" silently meant the older image.
//
// The signal that matters is one-directional. A pinned image missing because it
// is *older* than everything on offer has simply been retired from the library
// on purpose, and warning about it forever would train operators to ignore the
// warning. A pinned image missing because it is *newer* than everything on
// offer means the library is behind the bundle, which is the condition that
// puts an unintended build on a temple.

// Leading dotted-numeric portion of a version, so catalog values that carry a
// channel suffix ("2.2.6.10-cfw") still compare against plain ones.
export function parseFirmwareVersion(value) {
  const match = /^(\d+(?:\.\d+)*)/.exec(String(value ?? "").trim());
  if (!match) return null;
  return match[1].split(".").map((part) => Number.parseInt(part, 10));
}

export function compareFirmwareVersions(left, right) {
  const leftParts = parseFirmwareVersion(left);
  const rightParts = parseFirmwareVersion(right);
  if (!leftParts || !rightParts) return null;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

// Pinned images the catalog does not serve *and* that are newer than anything
// it does serve. Returns [] when the library is merely missing retired builds,
// when the catalog has not loaded, or when versions cannot be compared — this
// is a diagnostic, and a guess is worse than silence.
export function findUnservedPinnedImages({ catalog, targets } = {}) {
  if (!Array.isArray(catalog) || catalog.length === 0) return [];
  if (!Array.isArray(targets) || targets.length === 0) return [];

  const servedHashes = new Set(
    catalog
      .map((release) => String(release?.sha256 ?? "").toLowerCase())
      .filter(Boolean),
  );

  let newestServed = null;
  for (const release of catalog) {
    const candidate = release?.internalVersion ?? release?.version;
    if (!parseFirmwareVersion(candidate)) continue;
    if (
      newestServed === null ||
      compareFirmwareVersions(candidate, newestServed) > 0
    ) {
      newestServed = candidate;
    }
  }
  if (newestServed === null) return [];

  return targets.filter((target) => {
    const hash = String(target?.imageSha256 ?? "").toLowerCase();
    if (!hash || servedHashes.has(hash)) return false;
    return compareFirmwareVersions(target?.version, newestServed) > 0;
  });
}

export class FirmwareCatalogCoverageError extends Error {
  constructor(missing) {
    const labels = missing
      .map(
        (target) =>
          `${target.label} (${String(target.imageSha256).slice(0, 12)}…)`,
      )
      .join(", ");
    super(
      `The deployed firmware library is older than this WebFlasher build and is missing ${labels}. Reload after the firmware archive is republished. No device mutation was started.`,
    );
    this.name = "FirmwareCatalogCoverageError";
    this.missingPinnedImages = missing;
  }
}

export function assertFirmwareCatalogCoversPinnedImages(options = {}) {
  const missing = findUnservedPinnedImages(options);
  if (missing.length > 0) {
    throw new FirmwareCatalogCoverageError(missing);
  }
  return { verified: true, missingPinnedImages: [] };
}

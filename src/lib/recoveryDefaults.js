export const DEFAULT_TEMPLE_FLASH_ROUTE = "both";
export const DEFAULT_TEMPLE_FLASH_MODE = "complete";

function versionParts(version) {
  return String(version ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : -1));
}

function compareVersionsDescending(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? -1) - (leftParts[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

export function findLatestOfficialStockRelease(releases) {
  return [...(Array.isArray(releases) ? releases : [])]
    .filter(
      (release) =>
        release?.channel === "official" &&
        release?.caseRecoveryEligible !== false,
    )
    .sort((left, right) =>
      compareVersionsDescending(left?.version, right?.version),
    )[0] ?? null;
}

export function findDefaultFirmwareRelease(releases) {
  return (
    findLatestOfficialStockRelease(releases) ??
    null
  );
}

export function firmwareReleaseDisplayName(release) {
  if (!release) return "";
  return `Stock · G2 ${release.version ?? "unknown version"}`;
}

export function findLatestCaseFirmwareRelease(releases) {
  return [...(Array.isArray(releases) ? releases : [])]
    .filter(
      (release) =>
        release?.channel === "official" &&
        release?.caseRecoveryEligible !== false &&
        release?.caseVersion,
    )
    .sort(
      (left, right) =>
        compareVersionsDescending(left?.caseVersion, right?.caseVersion) ||
        compareVersionsDescending(left?.version, right?.version),
    )[0] ?? null;
}

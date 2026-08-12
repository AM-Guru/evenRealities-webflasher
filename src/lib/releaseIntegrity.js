const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export const WEBFLASHER_BUILD_SHA =
  typeof __WEBFLASHER_BUILD_SHA__ === "string"
    ? __WEBFLASHER_BUILD_SHA__.toLowerCase()
    : "development";

export const WEBFLASHER_BUILD_LABEL = BUILD_SHA_PATTERN.test(
  WEBFLASHER_BUILD_SHA,
)
  ? WEBFLASHER_BUILD_SHA.slice(0, 7)
  : WEBFLASHER_BUILD_SHA;

const WEBFLASHER_BASE_URL = import.meta.env?.BASE_URL ?? "/";

export function webflasherAssetUrl(relativePath) {
  const value = String(relativePath ?? "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
    return value;
  }
  const base = WEBFLASHER_BASE_URL.endsWith("/")
    ? WEBFLASHER_BASE_URL
    : `${WEBFLASHER_BASE_URL}/`;
  return `${base}${value.replace(/^\/+/, "")}`;
}

// The catalog, release manifest, application, and firmware archive are emitted
// into one GitHub Pages artifact. Resolving through Vite's base URL keeps every
// integrity request inside this repository's project-site path.
export const WEBFLASHER_FIRMWARE_CATALOG_URL =
  webflasherAssetUrl("firmware-catalog.json");
export const WEBFLASHER_RELEASE_URL = webflasherAssetUrl("release.json");

export class WebFlasherReleaseIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WebFlasherReleaseIntegrityError";
    this.releaseIntegrity = details;
  }
}

export function assertStableMutationRuntime({
  hotReloadEnabled = Boolean(import.meta.hot),
} = {}) {
  if (!hotReloadEnabled) return true;
  throw new WebFlasherReleaseIntegrityError(
    "Firmware mutation is disabled in the hot-reloading development server. Run `npm run hardware` and reopen the static local build before changing device firmware. No device mutation was started.",
    { hotReloadEnabled: true },
  );
}

function requireBuildSha(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!BUILD_SHA_PATTERN.test(normalized)) {
    throw new WebFlasherReleaseIntegrityError(
      `${label} did not provide a valid 40-character Git commit identity. No device mutation was started.`,
      { observed: normalized || null },
    );
  }
  return normalized;
}

function requireSha256(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new WebFlasherReleaseIntegrityError(
      `${label} did not provide a valid SHA-256 digest. No device mutation was started.`,
      { observed: normalized || null },
    );
  }
  return normalized;
}

async function sha256Hex(bytes, cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.subtle?.digest !== "function") {
    throw new WebFlasherReleaseIntegrityError(
      "This browser cannot verify the deployed firmware catalog. No device mutation was started.",
    );
  }
  const digest = new Uint8Array(
    await cryptoImpl.subtle.digest("SHA-256", bytes),
  );
  return [...digest]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function assertCurrentWebFlasherRelease({
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  currentBuildSha = WEBFLASHER_BUILD_SHA,
  releaseUrl = WEBFLASHER_RELEASE_URL,
  firmwareCatalogUrl = WEBFLASHER_FIRMWARE_CATALOG_URL,
  cacheToken = Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new WebFlasherReleaseIntegrityError(
      "This browser cannot verify the deployed WebFlasher release. No device mutation was started.",
    );
  }
  const runningSha = requireBuildSha(
    currentBuildSha,
    "The running WebFlasher",
  );
  const separator = releaseUrl.includes("?") ? "&" : "?";
  const url =
    `${releaseUrl}${separator}running=${encodeURIComponent(runningSha)}` +
    `&fresh=${encodeURIComponent(String(cacheToken))}`;
  let response;
  try {
    response = await fetchImpl(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new WebFlasherReleaseIntegrityError(
      `The deployed WebFlasher release could not be verified: ${error instanceof Error ? error.message : String(error)}. Reload while online before changing device firmware. No device mutation was started.`,
      { runningSha },
    );
  }
  if (!response?.ok) {
    throw new WebFlasherReleaseIntegrityError(
      `The deployed WebFlasher release could not be verified (HTTP ${response?.status ?? "unknown"}). Reload while online before changing device firmware. No device mutation was started.`,
      { runningSha, httpStatus: response?.status ?? null },
    );
  }

  let manifest;
  try {
    manifest = await response.json();
  } catch {
    throw new WebFlasherReleaseIntegrityError(
      "The deployed WebFlasher release manifest is not valid JSON. No device mutation was started.",
      { runningSha },
    );
  }
  if (manifest?.schemaVersion !== 1) {
    throw new WebFlasherReleaseIntegrityError(
      "The deployed WebFlasher release manifest has an unsupported schema. No device mutation was started.",
      { runningSha, schemaVersion: manifest?.schemaVersion ?? null },
    );
  }
  const deployedSha = requireBuildSha(
    manifest.buildSha,
    "The deployed WebFlasher release manifest",
  );
  if (runningSha !== deployedSha) {
    throw new WebFlasherReleaseIntegrityError(
      `This browser tab is running WebFlasher ${runningSha.slice(0, 7)}, but the deployed release is ${deployedSha.slice(0, 7)}. Reload this page before changing device firmware. No device mutation was started.`,
      {
        runningSha,
        deployedSha,
        stale: true,
      },
    );
  }
  const expectedCatalogSha256 = requireSha256(
    manifest.firmwareCatalogSha256,
    "The deployed WebFlasher release manifest firmware catalog",
  );
  const catalogSeparator = firmwareCatalogUrl.includes("?") ? "&" : "?";
  const catalogUrl =
    `${firmwareCatalogUrl}${catalogSeparator}release=${encodeURIComponent(deployedSha)}` +
    `&fresh=${encodeURIComponent(String(cacheToken))}`;
  let catalogResponse;
  try {
    catalogResponse = await fetchImpl(catalogUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new WebFlasherReleaseIntegrityError(
      `The deployed firmware catalog could not be verified: ${error instanceof Error ? error.message : String(error)}. No device mutation was started.`,
      { runningSha, deployedSha, expectedCatalogSha256 },
    );
  }
  if (!catalogResponse?.ok) {
    throw new WebFlasherReleaseIntegrityError(
      `The deployed firmware catalog could not be verified (HTTP ${catalogResponse?.status ?? "unknown"}). No device mutation was started.`,
      {
        runningSha,
        deployedSha,
        expectedCatalogSha256,
        httpStatus: catalogResponse?.status ?? null,
      },
    );
  }
  let observedCatalogSha256;
  try {
    const catalogBytes = await catalogResponse.arrayBuffer();
    observedCatalogSha256 = await sha256Hex(catalogBytes, cryptoImpl);
  } catch (error) {
    if (error instanceof WebFlasherReleaseIntegrityError) throw error;
    throw new WebFlasherReleaseIntegrityError(
      `The deployed firmware catalog body could not be verified: ${error instanceof Error ? error.message : String(error)}. No device mutation was started.`,
      { runningSha, deployedSha, expectedCatalogSha256 },
    );
  }
  if (observedCatalogSha256 !== expectedCatalogSha256) {
    throw new WebFlasherReleaseIntegrityError(
      `WebFlasher ${deployedSha.slice(0, 7)} was deployed with firmware catalog ${expectedCatalogSha256.slice(0, 12)}…, but production served ${observedCatalogSha256.slice(0, 12)}…. Wait for the firmware archive publish to finish, then reload. No device mutation was started.`,
      {
        runningSha,
        deployedSha,
        expectedCatalogSha256,
        observedCatalogSha256,
        firmwareCatalogMismatch: true,
      },
    );
  }
  return {
    schemaVersion: 1,
    runningSha,
    deployedSha,
    firmwareCatalogSha256: expectedCatalogSha256,
    firmwareCatalogVerified: true,
    verified: true,
  };
}

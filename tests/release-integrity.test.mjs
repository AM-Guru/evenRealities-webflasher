import assert from "node:assert/strict";
import test from "node:test";
import {
  WEBFLASHER_FIRMWARE_CATALOG_URL,
  WebFlasherReleaseIntegrityError,
  assertStableMutationRuntime,
  assertCurrentWebFlasherRelease,
} from "../src/lib/releaseIntegrity.js";

const RUNNING_SHA = "a".repeat(40);
const DEPLOYED_SHA = "b".repeat(40);
const CATALOG_BYTES = new TextEncoder().encode('{"schemaVersion":2}\n');
const CATALOG_SHA =
  "659f7e41827e76690689ec414bf5796252f555ba52b34ecadabf1056cfe325f9";

function response(manifest, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => manifest,
  };
}

function catalogResponse(bytes = CATALOG_BYTES, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test("blocks device mutation in a hot-reloading development runtime", () => {
  assert.throws(
    () => assertStableMutationRuntime({ hotReloadEnabled: true }),
    (error) => {
      assert.equal(error instanceof WebFlasherReleaseIntegrityError, true);
      assert.equal(error.releaseIntegrity.hotReloadEnabled, true);
      assert.match(error.message, /npm run hardware/);
      assert.match(error.message, /No device mutation was started/);
      return true;
    },
  );
  assert.equal(
    assertStableMutationRuntime({ hotReloadEnabled: false }),
    true,
  );
});

test("permits mutation only when the running and cache-busted deployed releases match", async () => {
  const requests = [];
  const result = await assertCurrentWebFlasherRelease({
    currentBuildSha: RUNNING_SHA,
    cacheToken: 42,
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return url.startsWith("/release.json")
        ? response({
            schemaVersion: 1,
            buildSha: RUNNING_SHA,
            firmwareCatalogSha256: CATALOG_SHA,
          })
        : catalogResponse();
    },
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    runningSha: RUNNING_SHA,
    deployedSha: RUNNING_SHA,
    firmwareCatalogSha256: CATALOG_SHA,
    firmwareCatalogVerified: true,
    verified: true,
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0][0], /running=aaaaaaaa/);
  assert.match(requests[0][0], /fresh=42/);
  assert.equal(requests[0][1].cache, "no-store");
  assert.match(requests[1][0], /release=aaaaaaaa/);
  assert.match(requests[1][0], /fresh=42/);
  assert.match(requests[1][0], /^\/firmware-catalog\.json\?/);
  assert.equal(requests[1][1].cache, "no-store");
  assert.equal(WEBFLASHER_FIRMWARE_CATALOG_URL, "/firmware-catalog.json");
});

test("blocks a stale open tab before any device mutation", async () => {
  await assert.rejects(
    () =>
      assertCurrentWebFlasherRelease({
        currentBuildSha: RUNNING_SHA,
        fetchImpl: async () =>
          response({
            schemaVersion: 1,
            buildSha: DEPLOYED_SHA,
            firmwareCatalogSha256: CATALOG_SHA,
          }),
      }),
    (error) => {
      assert.equal(error instanceof WebFlasherReleaseIntegrityError, true);
      assert.equal(error.releaseIntegrity.stale, true);
      assert.equal(error.releaseIntegrity.runningSha, RUNNING_SHA);
      assert.equal(error.releaseIntegrity.deployedSha, DEPLOYED_SHA);
      assert.match(error.message, /Reload this page/);
      assert.match(error.message, /No device mutation was started/);
      return true;
    },
  );
});

test("blocks mutation when deployment identity cannot be proven", async () => {
  await assert.rejects(
    () =>
      assertCurrentWebFlasherRelease({
        currentBuildSha: RUNNING_SHA,
        fetchImpl: async () => response({}, { ok: false, status: 503 }),
      }),
    /HTTP 503.*No device mutation was started/,
  );
  await assert.rejects(
    () =>
      assertCurrentWebFlasherRelease({
        currentBuildSha: "development",
        fetchImpl: async () =>
          response({ schemaVersion: 1, buildSha: RUNNING_SHA }),
      }),
    /valid 40-character Git commit identity.*No device mutation was started/,
  );
});

test("blocks mutation when the deployed catalog does not match the release", async () => {
  await assert.rejects(
    () =>
      assertCurrentWebFlasherRelease({
        currentBuildSha: RUNNING_SHA,
        fetchImpl: async (url) =>
          url.startsWith("/release.json")
            ? response({
                schemaVersion: 1,
                buildSha: RUNNING_SHA,
                firmwareCatalogSha256: CATALOG_SHA,
              })
            : catalogResponse(new TextEncoder().encode('{"stale":true}\n')),
      }),
    (error) => {
      assert.equal(error.releaseIntegrity.firmwareCatalogMismatch, true);
      assert.match(error.message, /production served/);
      assert.match(error.message, /No device mutation was started/);
      return true;
    },
  );
});

test("blocks mutation when the deployed catalog body cannot be read", async () => {
  await assert.rejects(
    () =>
      assertCurrentWebFlasherRelease({
        currentBuildSha: RUNNING_SHA,
        fetchImpl: async (url) =>
          url.startsWith("/release.json")
            ? response({
                schemaVersion: 1,
                buildSha: RUNNING_SHA,
                firmwareCatalogSha256: CATALOG_SHA,
              })
            : {
                ok: true,
                status: 200,
                arrayBuffer: async () => {
                  throw new Error("connection closed");
                },
              },
      }),
    /catalog body could not be verified: connection closed.*No device mutation was started/,
  );
});

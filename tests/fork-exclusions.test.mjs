import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const repoUrl = new URL("../", import.meta.url);

async function assertMissing(relativePath) {
  await assert.rejects(access(new URL(relativePath, repoUrl)));
}

test("fork excludes the Remote Support interface and relay", async () => {
  await Promise.all([
    assertMissing("src/lib/remoteSupport.js"),
    assertMissing("src/lib/remoteSerial.js"),
    assertMissing("scripts/remote_support_mcp.mjs"),
    assertMissing("deploy/homeassistant-addon"),
    assertMissing("deploy/webflasher.caddy"),
  ]);

  const [app, packageJson, workflow] = await Promise.all([
    readFile(new URL("src/App.jsx", repoUrl), "utf8"),
    readFile(new URL("package.json", repoUrl), "utf8"),
    readFile(new URL(".github/workflows/pages.yml", repoUrl), "utf8"),
  ]);

  for (const source of [app, packageJson, workflow]) {
    assert.doesNotMatch(source, /remote[- ]support/i);
  }
});

test("fork deploys only through GitHub Pages", async () => {
  await Promise.all([
    assertMissing(".github/workflows/deploy.yml"),
    assertMissing(".github/actionlint.yaml"),
    assertMissing("scripts/reconcile-webflasher-caddy.sh"),
    assertMissing("scripts/verify-webflasher-caddy.sh"),
  ]);

  const workflow = await readFile(
    new URL(".github/workflows/pages.yml", repoUrl),
    "utf8",
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /actions\/configure-pages@v6/);
  assert.match(workflow, /actions\/upload-pages-artifact@v5/);
  assert.match(workflow, /actions\/deploy-pages@v5/);
  assert.doesNotMatch(workflow, /self-hosted|rpi4|ssh|homeassistant/i);
});

test("fork documentation and runtime do not reference the source project", async () => {
  const legacyBrand = ["Sybil", "Sight"].join("");
  const legacyHost = ["webflasher.", "sybil", "sight.com"].join("");
  const paths = [
    "README.md",
    "LICENSE.md",
    "index.html",
    "package.json",
    "vite.config.js",
    "src/App.jsx",
    "src/lib/automaticRecovery.js",
    "src/lib/pogoFlashBridge.js",
    "scripts/build-firmware-archive.mjs",
    "scripts/g2_pogo_flasher.md",
    "public/firmware-updates/index.json",
  ];
  await assertMissing("scripts/build_g2flash_cfw.py");
  const contents = await Promise.all(
    paths.map((relativePath) =>
      readFile(new URL(relativePath, repoUrl), "utf8"),
    ),
  );
  for (const [index, source] of contents.entries()) {
    assert.equal(source.toLowerCase().includes(legacyBrand.toLowerCase()), false, paths[index]);
    assert.equal(source.toLowerCase().includes(legacyHost), false, paths[index]);
  }
});

test("fork publishes and permits official firmware only", async () => {
  const catalog = JSON.parse(
    await readFile(
      new URL("public/firmware-updates/index.json", repoUrl),
      "utf8",
    ),
  );
  assert.ok(catalog.releases.length > 0);
  assert.ok(catalog.releases.every((release) => release.channel === "official"));

  const targets = await readFile(
    new URL("src/lib/templeFlashTargets.js", repoUrl),
    "utf8",
  );
  assert.doesNotMatch(targets, /Custom|CFW|105032302d02/i);

  const app = await readFile(new URL("src/App.jsx", repoUrl), "utf8");
  assert.doesNotMatch(app, /\bCFW\b|Stock ↔ CFW|channel === "custom"/i);

  await Promise.all([
    assertMissing("src/lib/differential.js"),
    assertMissing("scripts/build_g2flash_cfw.py"),
  ]);
  const officialOnlyPaths = [
    "src/lib/firmware.js",
    "src/lib/pogoFlashBridge.js",
    "src/lib/serial.js",
    "src/lib/automaticRecovery.js",
    "scripts/g2_case_pogo_flasher.py",
    "scripts/build-firmware-archive.mjs",
  ];
  const officialOnlySources = await Promise.all(
    officialOnlyPaths.map((relativePath) =>
      readFile(new URL(relativePath, repoUrl), "utf8"),
    ),
  );
  for (const [index, source] of officialOnlySources.entries()) {
    assert.doesNotMatch(
      source,
      /\bCFW\b|REVIEWED_CFW|reviewed-custom|flash-reviewed-cfw|Stock\s*(?:↔|\/|-)\s*CFW/i,
      officialOnlyPaths[index],
    );
  }
});

test("fork has one canonical firmware catalog source", async () => {
  await assertMissing("public/firmware-catalog.json");

  const [catalog, viteConfig] = await Promise.all([
    readFile(
      new URL("public/firmware-updates/index.json", repoUrl),
      "utf8",
    ),
    readFile(new URL("vite.config.js", repoUrl), "utf8"),
  ]);

  const parsed = JSON.parse(catalog);
  assert.ok(parsed.releases.length > 0);
  assert.ok(
    parsed.releases.every((release) =>
      release.url.startsWith("/firmware-updates/g2/"),
    ),
  );
  assert.ok(
    parsed.ringReleases.every((release) =>
      release.url.startsWith("/firmware-updates/r1/"),
    ),
  );
  assert.match(
    viteConfig,
    /public\/firmware-updates\/index\.json/,
  );
  assert.doesNotMatch(viteConfig, /public\/firmware-catalog\.json/);
});

test("fork excludes the R1 bootloader unlock implementation and payloads", async () => {
  await Promise.all([
    assertMissing("src/lib/r1Unlock.js"),
    assertMissing("src/lib/r1Ace.js"),
    assertMissing("scripts/build_r1_ace_patch.py"),
    assertMissing("public/firmware-updates/local-r1-owner-unlock"),
    assertMissing("public/firmware-updates/r1-owner-unlock"),
  ]);

  const [app, firmwareCatalog, packageJson] = await Promise.all([
    readFile(new URL("src/App.jsx", repoUrl), "utf8"),
    readFile(new URL("public/firmware-updates/index.json", repoUrl), "utf8"),
    readFile(new URL("package.json", repoUrl), "utf8"),
  ]);
  for (const source of [app, firmwareCatalog, packageJson]) {
    assert.doesNotMatch(
      source,
      /r1Unlock|unlockRingBootloader|Unlock R1 bootloader|R1 ACE|ACE patch|owner[- ]unlock/i,
    );
  }
});

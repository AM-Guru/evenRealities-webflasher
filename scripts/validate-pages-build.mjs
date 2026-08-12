#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const distRoot = path.resolve("dist");

async function requireRegularFile(relativePath) {
  const absolutePath = path.join(distRoot, relativePath);
  const stats = await lstat(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${relativePath} is not a regular GitHub Pages file`);
  }
  return readFile(absolutePath);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactPath(url) {
  if (
    typeof url !== "string" ||
    !/^\/firmware-updates\/(?:g2|r1)\//.test(url)
  ) {
    throw new Error(`Catalog URL is not a repository-hosted firmware path: ${url}`);
  }
  return url.slice(1);
}

const [indexBytes, releaseBytes, catalogBytes] = await Promise.all([
  requireRegularFile("index.html"),
  requireRegularFile("release.json"),
  requireRegularFile("firmware-catalog.json"),
]);

const release = JSON.parse(releaseBytes);
const catalog = JSON.parse(catalogBytes);
if (release.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(release.buildSha)) {
  throw new Error("release.json does not contain a Git commit identity");
}
if (process.env.GITHUB_SHA && release.buildSha !== process.env.GITHUB_SHA) {
  throw new Error("release.json does not match GITHUB_SHA");
}
if (release.firmwareCatalogSha256 !== sha256(catalogBytes)) {
  throw new Error("release.json does not match firmware-catalog.json");
}
if (catalog.releases.some((entry) => entry.channel !== "official")) {
  throw new Error("The GitHub Pages catalog must contain official firmware only");
}
if (catalog.releases.some((entry) => !entry.url.startsWith("/firmware-updates/g2/"))) {
  throw new Error("Every G2 catalog URL must use the firmware-updates/g2 directory");
}
if (
  (catalog.ringReleases ?? []).some(
    (entry) => !entry.url.startsWith("/firmware-updates/r1/"),
  )
) {
  throw new Error("Every R1 catalog URL must use the firmware-updates/r1 directory");
}

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/").pop();
if (repositoryName) {
  const expectedBase = `/${repositoryName}/`;
  const index = indexBytes.toString("utf8");
  if (!index.includes(`${expectedBase}assets/`)) {
    throw new Error(`index.html was not built for GitHub Pages base ${expectedBase}`);
  }
}

for (const entry of [...catalog.releases, ...(catalog.ringReleases ?? [])]) {
  const bytes = await requireRegularFile(artifactPath(entry.url));
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
    throw new Error(`${entry.id} does not match its catalog size and SHA-256`);
  }
}

process.stdout.write(
  `Validated GitHub Pages build with ${catalog.releases.length} G2 and ${catalog.ringReleases?.length ?? 0} R1 releases.\n`,
);

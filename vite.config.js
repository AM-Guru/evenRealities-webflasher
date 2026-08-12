import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function resolveSiteBase() {
  const configured = String(process.env.VITE_BASE_PATH ?? "").trim();
  if (configured) {
    const normalized = configured.replace(/^\/+|\/+$/g, "");
    return normalized ? `/${normalized}/` : "/";
  }
  const repository = String(process.env.GITHUB_REPOSITORY ?? "").trim();
  if (process.env.GITHUB_ACTIONS === "true" && repository.includes("/")) {
    return `/${repository.split("/").pop()}/`;
  }
  return "/";
}

function resolveBuildSha() {
  const configured = String(
    process.env.GITHUB_SHA ?? process.env.VITE_BUILD_SHA ?? "",
  )
    .trim()
    .toLowerCase();
  if (/^[0-9a-f]{40}$/.test(configured)) return configured;
  try {
    const local = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    })
      .trim()
      .toLowerCase();
    if (/^[0-9a-f]{40}$/.test(local)) return local;
  } catch {
    // A source archive without Git metadata may still be inspected and tested,
    // but its build cannot pass the production mutation-release gate.
  }
  return "development";
}

function firmwareCatalogSource() {
  const catalogPath = fileURLToPath(
    new URL(
      "./public/firmware-updates/index.json",
      import.meta.url,
    ),
  );
  return readFileSync(catalogPath);
}

function releaseManifest(buildSha, catalogSource) {
  const catalogSha256 = createHash("sha256")
    .update(catalogSource)
    .digest("hex");
  const source = `${JSON.stringify({
    schemaVersion: 1,
    buildSha,
    firmwareCatalogSha256: catalogSha256,
  })}\n`;
  return {
    name: "webflasher-release-manifest",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, "http://localhost").pathname;
        if (pathname === "/firmware-catalog.json") {
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(catalogSource);
          return;
        }
        if (pathname !== "/release.json") {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(source);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "release.json",
        source,
      });
      this.emitFile({
        type: "asset",
        fileName: "firmware-catalog.json",
        source: catalogSource,
      });
    },
  };
}

const buildSha = resolveBuildSha();
const catalogSource = firmwareCatalogSource();
const siteBase = resolveSiteBase();

export default defineConfig({
  base: siteBase,
  plugins: [react(), releaseManifest(buildSha, catalogSource)],
  define: {
    __WEBFLASHER_BUILD_SHA__: JSON.stringify(buildSha),
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    watch: {
      usePolling: process.env.CODEX_SANDBOX === "seatbelt",
    },
  },
});

// Post-build workaround for @opennextjs/cloudflare <= 1.20.10 with Next.js 16.4+.
//
// Next.js 16.4 loads `.next/server/preview-props.json` in the server constructor, but OpenNext's
// inlined `loadManifest` does not know that file, so every request fails with
// "Unexpected loadManifest(/.next/server/preview-props.json) call!".
// Upstream: https://github.com/opennextjs/opennextjs-cloudflare/issues/1355 (fix: PR #1356).
//
// This script adds the missing branch to the bundled handler and returns the real JSON (draft-mode
// ids/keys generated at build time; the same values already ship inside the inlined
// prerender-manifest). It is a no-op once OpenNext inlines the file itself: delete it then.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OPEN_NEXT_DIR = ".open-next";
const MANIFEST_SUFFIX = "/server/preview-props.json";

function fail(message) {
  console.error(`[patch-open-next-preview-props] ${message}`);
  process.exit(1);
}

/** All `handler.mjs` files under the server function (path differs inside monorepos). */
function findHandlers(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".next") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findHandlers(path);
    return entry.name === "handler.mjs" ? [path] : [];
  });
}

const serverDir = join(OPEN_NEXT_DIR, "server-functions", "default");
const handlers = findHandlers(serverDir).filter((file) => readFileSync(file, "utf8").includes("Unexpected loadManifest"));
if (handlers.length !== 1) fail(`expected one bundled handler with loadManifest, found ${handlers.length} (run opennextjs-cloudflare build first)`);
const handlerPath = handlers[0];
const code = readFileSync(handlerPath, "utf8");

if (code.includes(MANIFEST_SUFFIX)) {
  console.log("[patch-open-next-preview-props] already handled by OpenNext, nothing to do");
  process.exit(0);
}

const manifestPath = [join(handlerPath, "..", ".next", "server", "preview-props.json"), join(".next", "server", "preview-props.json")].find(existsSync);
if (!manifestPath) {
  console.log("[patch-open-next-preview-props] no preview-props.json in this Next.js build, nothing to do");
  process.exit(0);
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  fail(`cannot parse ${manifestPath}: ${e.message}`);
}
if (!manifest?.previewModeId || !manifest.previewModeSigningKey || !manifest.previewModeEncryptionKey) {
  fail(`${manifestPath} does not look like Next.js preview props`);
}

// The throw emitted by OpenNext's load-manifest patch (template-literal or minified concat form).
const THROW_RE = /throw new Error\((?:`Unexpected loadManifest\(\$\{(\w+)\}\) call!`|"Unexpected loadManifest\(" ?\+ ?(\w+) ?\+ ?"\) call!")\)/g;
const matches = [...code.matchAll(THROW_RE)];
if (matches.length !== 1) fail(`expected exactly one loadManifest throw in ${handlerPath}, found ${matches.length}`);
const [match] = matches;
const pathVar = match[1] ?? match[2];
const branch = `if (${pathVar}.endsWith(${JSON.stringify(MANIFEST_SUFFIX)})) { return ${JSON.stringify(manifest)}; }\n`;
writeFileSync(handlerPath, code.slice(0, match.index) + branch + code.slice(match.index));
console.log(`[patch-open-next-preview-props] patched ${handlerPath}`);

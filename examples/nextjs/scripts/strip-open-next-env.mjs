// Keeps .env files out of the Worker bundle.
//
// `opennextjs-cloudflare build` compiles every .env/.env.local/.env.<mode> file of the app AND of the
// monorepo root into .open-next/cloudflare/next-env.mjs, which wrangler then uploads with the Worker.
// In a monorepo that can silently ship unrelated secrets. This example reads its configuration from
// wrangler.jsonc `vars` and `wrangler secret put` instead, so the compiled values are dropped.
// (NEXT_PUBLIC_* values used in client code are already inlined by `next build` and are unaffected.)
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = join(".open-next", "cloudflare", "next-env.mjs");
if (!existsSync(file)) {
  console.error(`[strip-open-next-env] ${file} not found (run opennextjs-cloudflare build first)`);
  process.exit(1);
}
writeFileSync(file, ["production", "development", "test"].map((mode) => `export const ${mode} = {};\n`).join(""));
console.log(`[strip-open-next-env] cleared ${file}`);

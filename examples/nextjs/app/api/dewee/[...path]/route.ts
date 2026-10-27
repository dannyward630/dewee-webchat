// Mounts the dewee-webchat backend at /api/dewee/* (config, session, chat, history).
// The integration secret stays on the server; the browser only ever sees signed visitor tokens.
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";

export const dynamic = "force-dynamic";

type Env = Record<string, string | undefined>;

/** Workers vars/secrets (getCloudflareContext) layered over process.env (`next dev`, .env.local). */
function readEnv(): Env {
  const env: Env = { ...process.env };
  try {
    for (const [key, value] of Object.entries(getCloudflareContext().env as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value;
    }
  } catch {
    // No Cloudflare context (e.g. plain `next start`): process.env alone is used.
  }
  return env;
}

// Created on the first request: Workers bindings are only available inside a request.
let handler: ((request: Request) => Promise<Response>) | undefined;
const dewee = (request: Request) => (handler ??= createDeweeHandler(optionsFromEnv(readEnv())))(request);

export { dewee as GET, dewee as POST, dewee as OPTIONS };

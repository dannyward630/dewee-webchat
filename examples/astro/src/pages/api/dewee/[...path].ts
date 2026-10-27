// Backend for the widget: /api/dewee/{config,session,chat,history}.
// The integration secret stays in the Worker; the browser only sees visitor tokens.
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";

export const prerender = false;

let handler: ((request: Request) => Promise<Response>) | undefined;

export const ALL: APIRoute = ({ request }) => {
  // Created on first request so bindings/secrets are resolved and reused across requests.
  // Cloudflare.Env (from `wrangler types`) has no index signature, hence the widening cast.
  handler ??= createDeweeHandler(optionsFromEnv(env as unknown as Record<string, string | undefined>));
  return handler(request);
};

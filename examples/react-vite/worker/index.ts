// Cloudflare Worker: /api/dewee/* goes to the dewee-webchat backend (the integration secret stays here),
// everything else is the Vite-built single-page app served from static assets.
import { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";

type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DEWEE_WEBCHAT_TRANSPORT?: string;
  DEWEE_CCP_CHAT_URL?: string;
  DEWEE_WEBCHAT_INTEGRATION_ID?: string;
  DEWEE_WEBCHAT_INTEGRATION_SECRET?: string;
  DEWEE_WEBCHAT_SECRET?: string;
  DEWEE_ALLOWED_ORIGINS?: string;
  // Deprecated legacy-gateway transport
  DEWEE_GATEWAY_URL?: string;
  DEWEE_GATEWAY_TOKEN?: string;
  DEWEE_AGENTS?: string;
  DEWEE_DEFAULT_AGENT?: string;
};

// Created once per isolate so the agent-name cache and rate limiter are reused across requests.
let dewee: ((request: Request) => Promise<Response>) | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/api/dewee/")) {
      const { ASSETS: _assets, ...vars } = env;
      dewee ??= createDeweeHandler(optionsFromEnv(vars));
      return dewee(request);
    }
    return env.ASSETS.fetch(request);
  },
};

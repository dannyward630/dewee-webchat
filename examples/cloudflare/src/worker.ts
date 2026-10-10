// webchat.dewee.sh: the playground page (static assets) plus the dewee-webchat backend on /api/dewee/*.
import { createDeweeHandler, optionsFromEnv, type RateLimiter } from "dewee-webchat/server";

interface Env {
  ASSETS: Fetcher;
  CHAT_LIMITER: RateLimit;
  SESSION_LIMITER: RateLimit;
  [key: string]: unknown;
}

let handler: ((req: Request) => Promise<Response>) | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/dewee/")) return env.ASSETS.fetch(req);

    if (!handler) {
      // Workers rate limiting bindings are shared across isolates, unlike the in-memory default.
      const rateLimit: RateLimiter = async (key, bucket) =>
        (await (bucket === "chat" ? env.CHAT_LIMITER : env.SESSION_LIMITER).limit({ key })).success;
      handler = createDeweeHandler(optionsFromEnv(env as unknown as Record<string, string>, { rateLimit }));
    }
    return handler(req);
  },
} satisfies ExportedHandler<Env>;

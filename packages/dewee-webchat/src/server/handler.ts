// Framework-agnostic backend: (Request) => Promise<Response>.
// Routes are matched by the last path segment, so mount it under any prefix
// (e.g. /api/dewee/[...path]): GET config | POST session | POST chat | GET history | OPTIONS.
import {
  HEADER_GATEWAY_TOKEN,
  HEADER_GATEWAY_URL,
  VERSION,
  type AgentInfo,
  type ChatStreamEvent,
  type PublicConfig,
} from "../protocol";
import { buildSessionKey, fetchHistory, listAgents, streamChat, type GatewayCredentials, type GatewayError } from "./gateway-client";
import {
  memoryRateLimiter,
  randomId,
  signVisitorToken,
  verifyTurnstile,
  verifyVisitorToken,
  type RateLimiter,
} from "./security";

export interface DeweeHandlerOptions {
  /** Gateway runtime origin. Required unless every request brings its own credentials. */
  gatewayUrl?: string;
  /** Gateway token or operator API key (server-side only). */
  token?: string;
  tenantId?: string;
  /** HMAC secret for visitor tokens (>= 32 random chars). */
  secret?: string;
  /** Agents visitors may talk to. The first is the default. `"*"` = every active agent. */
  agents?: Array<string | AgentInfo> | "*";
  defaultAgent?: string;
  /** Let the widget switch between allowed agents. Default: true when more than one agent. */
  allowAgentSwitch?: boolean;
  /** Cross-origin sites allowed to call this backend. Same-origin is always allowed. */
  allowedOrigins?: string[] | "*";
  /**
   * Let visitors bring their own gateway URL + token (sent per request, never stored).
   * Meant for playgrounds. `allowedHosts` restricts which gateways may be targeted.
   */
  allowClientCredentials?: boolean | { allowedHosts?: string[] };
  /** Cloudflare Turnstile. When set, issuing a visitor session requires a valid challenge. */
  turnstile?: { siteKey: string; secretKey: string };
  /** Custom limiter, or false to disable. Default: in-memory 20 msgs/min, 10 sessions/10 min per IP. */
  rateLimit?: RateLimiter | false;
  maxMessageLength?: number;
  /** Prefix for the per-visitor gateway user id. */
  userIdPrefix?: string;
  sessionTtlMs?: number;
  /** Max duration of one agent run. */
  timeoutMs?: number;
  /** Observe traffic (logging/analytics). Errors thrown here are ignored. */
  onChat?: (info: { visitorId: string; agent: string; message: string; reply?: string; error?: string }) => void;
}

type Handler = (request: Request) => Promise<Response>;

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function createDeweeHandler(options: DeweeHandlerOptions): Handler {
  const o = {
    maxMessageLength: 4000,
    userIdPrefix: "webchat-",
    sessionTtlMs: 30 * 24 * 3600 * 1000,
    timeoutMs: 180000,
    ...options,
  };
  let secret = o.secret;
  if (!secret) {
    secret = randomId(32);
    console.warn("[dewee-webchat] No secret configured: using an ephemeral one. Visitor sessions reset on restart.");
  }
  const limiter: RateLimiter | null =
    o.rateLimit === false ? null : o.rateLimit ?? memoryRateLimiter({ chat: [20, 60_000], session: [10, 600_000] });
  const staticAgents: AgentInfo[] =
    o.agents === "*" ? [] : (o.agents ?? []).map((a) => (typeof a === "string" ? { id: a } : a));
  const wildcardAgents = o.agents === "*";
  const byo = o.allowClientCredentials ? (o.allowClientCredentials === true ? {} : o.allowClientCredentials) : null;

  function serverCreds(): GatewayCredentials | null {
    return o.gatewayUrl && o.token ? { url: o.gatewayUrl, token: o.token, tenantId: o.tenantId } : null;
  }

  /** Resolves credentials: client-supplied (when allowed) or the server's own. */
  function resolveCreds(req: Request): { creds: GatewayCredentials | null; byo: boolean; error?: string } {
    const url = req.headers.get(HEADER_GATEWAY_URL);
    const token = req.headers.get(HEADER_GATEWAY_TOKEN);
    if (url || token) {
      if (!byo) return { creds: null, byo: true, error: "Client credentials are disabled on this server" };
      if (!url || !token) return { creds: null, byo: true, error: "Both gateway URL and token are required" };
      let u: URL;
      try { u = new URL(url); } catch { return { creds: null, byo: true, error: "Invalid gateway URL" }; }
      // The server connects wherever the client points it, so internal hosts need an explicit allowlist entry.
      const listed = !!byo.allowedHosts?.includes(u.hostname);
      if (byo.allowedHosts?.length && !listed) return { creds: null, byo: true, error: "Gateway host not allowed" };
      if (isInternalHost(u.hostname) && !listed) return { creds: null, byo: true, error: "Gateway host not allowed" };
      if (u.protocol !== "https:" && !(listed && u.protocol === "http:")) return { creds: null, byo: true, error: "Gateway URL must use https" };
      return { creds: { url: u.origin + u.pathname.replace(/\/$/, ""), token }, byo: true };
    }
    return { creds: serverCreds(), byo: false };
  }

  async function agentsFor(creds: GatewayCredentials | null, isByo: boolean): Promise<AgentInfo[]> {
    if ((isByo || wildcardAgents) && creds) return listAgents(creds);
    if (creds && staticAgents.some((a) => !a.name)) {
      // Fill missing display names from the gateway once; ids stay the allowlist.
      namedAgents ??= listAgents(creds)
        .then((all) => staticAgents.map((a) => ({ ...a, name: a.name ?? all.find((x) => x.id === a.id)?.name })))
        .catch(() => { namedAgents = undefined; return staticAgents; });
      return namedAgents;
    }
    return staticAgents;
  }
  let namedAgents: Promise<AgentInfo[]> | undefined;

  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin");
    if (!origin) return {};
    const allowed = o.allowedOrigins === "*" || (o.allowedOrigins ?? []).includes(origin) || origin === new URL(req.url).origin;
    if (!allowed) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": `content-type, authorization, ${HEADER_GATEWAY_URL}, ${HEADER_GATEWAY_TOKEN}`,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }

  function originAllowed(req: Request): boolean {
    const origin = req.headers.get("origin");
    if (!origin || origin === new URL(req.url).origin) return true;
    return o.allowedOrigins === "*" || (o.allowedOrigins ?? []).includes(origin);
  }

  const json = (req: Request, body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(req) },
    });
  const fail = (req: Request, status: number, message: string, code = "bad_request") => json(req, { error: { message, code } }, status);

  const clientIp = (req: Request) =>
    req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

  async function visitorFrom(req: Request): Promise<string | null> {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const claims = token ? await verifyVisitorToken(secret!, token) : null;
    return claims?.v ?? null;
  }

  async function pickAgent(requested: string | null | undefined, creds: GatewayCredentials | null, isByo: boolean): Promise<string | null> {
    if (isByo || wildcardAgents) {
      const a = requested || o.defaultAgent || (await agentsFor(creds, isByo))[0]?.id;
      return a && AGENT_RE.test(a) ? a : null;
    }
    const def = o.defaultAgent || staticAgents[0]?.id;
    if (!requested) return def ?? null;
    return staticAgents.some((a) => a.id === requested) ? requested : null;
  }

  async function handleConfig(req: Request): Promise<Response> {
    const { creds, byo: isByo, error } = resolveCreds(req);
    if (error) return fail(req, 400, error, "bad_credentials");
    let agents: AgentInfo[] = [];
    try {
      agents = await agentsFor(creds, isByo);
    } catch (e) {
      return fail(req, 502, (e as Error).message, "gateway_error");
    }
    const body: PublicConfig = {
      agents,
      defaultAgent: (!isByo && o.defaultAgent) || agents[0]?.id || "",
      allowAgentSwitch: o.allowAgentSwitch ?? (isByo || agents.length > 1),
      allowClientCredentials: !!byo,
      turnstileSiteKey: o.turnstile?.siteKey,
      maxMessageLength: o.maxMessageLength,
      version: VERSION,
    };
    return json(req, body);
  }

  async function handleSession(req: Request): Promise<Response> {
    const ip = clientIp(req);
    if (limiter && !(await limiter(ip, "session"))) return fail(req, 429, "Too many sessions, slow down", "rate_limited");
    const body: any = await req.json().catch(() => ({}));
    if (o.turnstile) {
      if (!body?.turnstileToken || !(await verifyTurnstile(o.turnstile.secretKey, String(body.turnstileToken), ip))) {
        return fail(req, 403, "Verification failed", "turnstile_failed");
      }
    }
    // Refresh an existing visitor instead of minting a new identity, so history survives.
    const previous = typeof body?.token === "string" ? await verifyVisitorToken(secret!, body.token) : null;
    const visitorId = previous?.v ?? randomId(16);
    const expiresAt = Date.now() + o.sessionTtlMs;
    return json(req, { visitorId, token: await signVisitorToken(secret!, { v: visitorId, exp: expiresAt }), expiresAt });
  }

  async function handleChat(req: Request): Promise<Response> {
    const visitorId = await visitorFrom(req);
    if (!visitorId) return fail(req, 401, "Missing or expired visitor session", "unauthorized");
    if (limiter && !(await limiter(`${visitorId}|${clientIp(req)}`, "chat"))) return fail(req, 429, "Too many messages, please wait a moment", "rate_limited");
    const { creds, byo: isByo, error } = resolveCreds(req);
    if (error) return fail(req, 400, error, "bad_credentials");
    if (!creds) return fail(req, 500, "Gateway is not configured", "not_configured");

    const body: any = await req.json().catch(() => null);
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return fail(req, 400, "Message is required");
    if (message.length > o.maxMessageLength) return fail(req, 413, `Message exceeds ${o.maxMessageLength} characters`, "too_long");
    const conversationId = typeof body?.conversationId === "string" && ID_RE.test(body.conversationId) ? body.conversationId : randomId(9);
    const agent = await pickAgent(body?.agent, creds, isByo);
    if (!agent) return fail(req, 403, "Agent not allowed", "agent_not_allowed");

    const sessionKey = buildSessionKey(agent, `webchat-${visitorId}-${conversationId}`);
    const abort = new AbortController();
    req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (e: ChatStreamEvent | string) =>
      writer.write(enc.encode(typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`)).catch(() => abort.abort());

    (async () => {
      const keepAlive = setInterval(() => send(": ping\n\n"), 15000);
      let reply = "";
      let errMsg: string | undefined;
      try {
        await send({ type: "start", conversationId, agent });
        for await (const ev of streamChat({ creds, userId: o.userIdPrefix + visitorId, agent, sessionKey, message, signal: abort.signal, timeoutMs: o.timeoutMs })) {
          if (ev.type === "start") continue; // already announced with the conversation id
          if (ev.type === "done") reply = ev.content;
          if (ev.type === "error") errMsg = ev.message;
          await send(ev);
          if (abort.signal.aborted) break;
        }
      } catch (e) {
        errMsg = (e as Error).message;
        await send({ type: "error", message: errMsg, code: "gateway_error" });
      } finally {
        clearInterval(keepAlive);
        try { o.onChat?.({ visitorId, agent, message, reply, error: errMsg }); } catch { /* observer errors are ignored */ }
        writer.close().catch(() => {});
      }
    })();

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        ...corsHeaders(req),
      },
    });
  }

  async function handleHistory(req: Request): Promise<Response> {
    const visitorId = await visitorFrom(req);
    if (!visitorId) return fail(req, 401, "Missing or expired visitor session", "unauthorized");
    const { creds, byo: isByo, error } = resolveCreds(req);
    if (error) return fail(req, 400, error, "bad_credentials");
    if (!creds) return fail(req, 500, "Gateway is not configured", "not_configured");
    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId") || "";
    if (!ID_RE.test(conversationId)) return fail(req, 400, "Invalid conversationId");
    const agent = await pickAgent(url.searchParams.get("agent"), creds, isByo);
    if (!agent) return fail(req, 403, "Agent not allowed", "agent_not_allowed");
    try {
      const messages = await fetchHistory(creds, o.userIdPrefix + visitorId, agent, buildSessionKey(agent, `webchat-${visitorId}-${conversationId}`));
      return json(req, { messages });
    } catch (e) {
      // A conversation that has not sent its first message yet does not exist on the gateway.
      if ((e as GatewayError).code === "NOT_FOUND") return json(req, { messages: [] });
      return fail(req, 502, (e as Error).message, "gateway_error");
    }
  }

  return async function deweeHandler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (!originAllowed(req)) return fail(req, 403, "Origin not allowed", "forbidden_origin");
    const action = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
    try {
      if (req.method === "GET" && action === "config") return await handleConfig(req);
      if (req.method === "POST" && action === "session") return await handleSession(req);
      if (req.method === "POST" && action === "chat") return await handleChat(req);
      if (req.method === "GET" && action === "history") return await handleHistory(req);
      return fail(req, 404, "Not found", "not_found");
    } catch (e) {
      return fail(req, 500, (e as Error).message || "Internal error", "internal");
    }
  };
}

/** Reads options from environment variables (process.env, Workers env, import.meta.env…). */
export function optionsFromEnv(env: Record<string, string | undefined>, overrides: Partial<DeweeHandlerOptions> = {}): DeweeHandlerOptions {
  const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);
  const agents = env.DEWEE_AGENTS?.trim() === "*" ? "*" : list(env.DEWEE_AGENTS);
  const origins = env.DEWEE_ALLOWED_ORIGINS?.trim() === "*" ? "*" : list(env.DEWEE_ALLOWED_ORIGINS);
  const byoHosts = list(env.DEWEE_CLIENT_CREDENTIAL_HOSTS);
  return {
    gatewayUrl: env.DEWEE_GATEWAY_URL || env.GOCLAW_GATEWAY_URL,
    token: env.DEWEE_GATEWAY_TOKEN || env.GOCLAW_GATEWAY_TOKEN,
    tenantId: env.DEWEE_TENANT_ID,
    secret: env.DEWEE_WEBCHAT_SECRET,
    agents,
    defaultAgent: env.DEWEE_DEFAULT_AGENT,
    allowedOrigins: origins,
    allowClientCredentials: env.DEWEE_ALLOW_CLIENT_CREDENTIALS === "true" ? (byoHosts?.length ? { allowedHosts: byoHosts } : true) : false,
    turnstile: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY } : undefined,
    // undefined overrides must not erase env-derived values
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
}

/** Loopback, private, link-local and metadata addresses (plus bare/internal names). */
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || !h.includes(".") && !h.includes(":")) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h.includes(":") && (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:"));
}

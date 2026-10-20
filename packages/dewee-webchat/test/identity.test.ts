// Signed-in users through a Dewee identity session exchange, against a fake gateway that serves the
// identity HTTP routes and the WS v3 protocol on one port. Covers isolation between users, fail-closed
// session issuance, typed error forwarding, web-first linking and secret hygiene.
import { createHmac, generateKeyPairSync, randomUUID, verify as verifySignature, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { ChatStreamEvent } from "../src/protocol";
import { createDeweeHandler, signVisitorToken, type DeweeHandlerOptions, type DeweeIdentityOptions } from "../src/server";
import { ApiClient } from "../src/widget/api-client";
import { pickStrings } from "../src/widget/i18n";

const GW_TOKEN = "gw-token-NEVER-IN-BROWSER-0001";
const ASSERTION_SECRET = "assertion-secret-NEVER-IN-BROWSER-0000000001";
const VISITOR_SECRET = "visitor-secret-NEVER-IN-BROWSER-00000000001";
const APP_ID = "8f0c6a2e-3b1d-4c5e-9a7f-1b2c3d4e5f60";
const ISSUER = "https://host.example";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateJwk = { ...(ec.privateKey.export({ format: "jwk" }) as Record<string, string>), kid: "k1", alg: "ES256" } as { kty: string; kid: string; d: string; alg: string };
const ecPublic: KeyObject = ec.publicKey;

// ---------- fake gateway ----------

interface Session { principal: string; agent: string; expiresAt: number }
const sessions = new Map<string, Session>();
const expiredSessions = new Set<string>();
const revokeDuringRun = new Set<string>();
const seen = { connects: [] as any[], sends: [] as any[], exchanges: [] as { sub: string; agent: string; ttl?: number }[] };
let gatewayUrl = "";
let server: Server;

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/** Checks a partner assertion the way the gateway does (HS256 with the secret, or ES256 with the JWKS key). */
function verifyAssertion(jws: string): { sub: string } | null {
  const [h, p, s] = jws.split(".");
  if (!h || !p || !s) return null;
  const header = b64json(h);
  const claims = b64json(p);
  let ok = false;
  if (header.alg === "HS256") ok = createHmac("sha256", ASSERTION_SECRET).update(`${h}.${p}`).digest("base64url") === s;
  if (header.alg === "ES256") ok = verifySignature("sha256", Buffer.from(`${h}.${p}`), { key: ecPublic, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!ok || header.typ !== "dewee-session+jwt" || claims.aud !== `dewee:${APP_ID}` || claims.iss !== ISSUER) return null;
  return { sub: claims.sub };
}

const identityError = (code: string, action: string) => ({ error: { code, message: code, type: "identity_error", remediation: { action, audience: "end_user" } } });

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function onHttp(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (req.method === "POST" && req.url === "/v1/identity/sessions/exchange") {
    const auth = String(req.headers.authorization ?? "");
    const proof = auth.startsWith("Dewee-Assertion ") ? verifyAssertion(auth.slice(16)) : null;
    if (!proof) return sendJson(res, 401, identityError("IDENTITY_REQUIRED", "reauthenticate"));
    seen.exchanges.push({ sub: proof.sub, agent: body.agent_id, ttl: body.ttl_seconds });
    if (proof.sub === "suspended-user") return sendJson(res, 409, identityError("LINK_REVOKED", "reauthenticate"));
    const token = `idsess_${randomUUID()}`;
    const expiresAt = Date.now() + (body.ttl_seconds ?? 3600) * 1000;
    // One principal per subject: a stable fake id derived from it.
    const principal = createHmac("sha256", "principal").update(proof.sub).digest("hex").slice(0, 32);
    sessions.set(token, { principal, agent: body.agent_id, expiresAt });
    return sendJson(res, 201, {
      session_token: token, token_type: "identity_session", header: "X-Dewee-Identity-Session", session_id: randomUUID(),
      principal_id: principal, application_id: APP_ID, agent_id: randomUUID(), expires_at: new Date(expiresAt).toISOString(), test_mode: false,
    });
  }
  if (req.method === "POST" && req.url === "/v1/identity/links") {
    const s = sessions.get(String(req.headers["x-dewee-identity-session"] ?? ""));
    if (!s) return sendJson(res, 401, identityError("IDENTITY_REQUIRED", "reauthenticate"));
    return sendJson(res, 201, {
      transaction_id: randomUUID(), kind: "web_first", state: "awaiting_channel_proof", proof_code: "482913",
      expires_at: new Date(Date.now() + 600_000).toISOString(), created: true,
      deep_links: [{ channel_type: "telegram", channel_instance_id: randomUUID(), name: "acme-bot", display_name: "Acme Bot" }],
    });
  }
  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
}

beforeAll(async () => {
  server = createServer((req, res) => void onHttp(req, res));
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    let user = "";
    let sessionToken = "";
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      const ok = (payload: unknown) => ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload }));
      const err = (code: string, action?: string) =>
        ws.send(JSON.stringify({ type: "res", id: f.id, ok: false, error: { code, message: `${code} (gateway)`, ...(action ? { details: { remediation: { action, audience: "end_user" } } } : {}) } }));
      if (f.method === "connect") {
        seen.connects.push(f.params);
        if (f.params.token !== GW_TOKEN) return err("UNAUTHORIZED");
        if (f.params.identity_session !== undefined) {
          const s = sessions.get(f.params.identity_session);
          if (expiredSessions.has(f.params.identity_session)) return err("LINK_EXPIRED", "reauthenticate");
          if (!s) return err("IDENTITY_REQUIRED", "reauthenticate");
          if (f.params.user_id !== undefined && f.params.user_id !== `tuc:${s.principal}`) return err("IDENTITY_CONFLICT", "contact_admin");
          user = `tuc:${s.principal}`;
          sessionToken = f.params.identity_session;
        } else user = f.params.user_id;
        return ok({ role: "operator" });
      }
      if (f.method === "chat.send") {
        seen.sends.push({ ...f.params, user });
        if (sessionToken && sessions.get(sessionToken)?.agent !== f.params.agentId) return err("PERMISSION_DENIED", "contact_admin");
        const base = { agentId: f.params.agentId, runId: "run-1", sessionKey: f.params.sessionKey };
        ws.send(JSON.stringify({ type: "event", event: "agent", payload: { ...base, type: "run.started", payload: {} } }));
        if (revokeDuringRun.has(sessionToken)) return err("LINK_REVOKED", "reauthenticate");
        ws.send(JSON.stringify({ type: "event", event: "agent", payload: { ...base, type: "chunk", payload: { content: `hello ${user}` } } }));
        return ok({ content: `hello ${user}` });
      }
      if (f.method === "chat.history") return ok({ messages: [{ role: "user", content: `history of ${user}` }] });
      ok({});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

// ---------- handler under test ----------

/** Every body this file's handlers sent to a browser; checked for secrets at the end. */
const browserBodies: string[] = [];

const cookieUser = async (req: Request) => {
  const uid = /(?:^|;\s*)uid=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (uid === "boom") throw new Error("login store down");
  return uid ? { subject: uid } : null;
};

function makeHandler(identity: Partial<DeweeIdentityOptions> = {}, extra: Partial<DeweeHandlerOptions> = {}) {
  const h = createDeweeHandler({
    gatewayUrl,
    token: GW_TOKEN,
    secret: VISITOR_SECRET,
    agents: ["support", "sales"],
    rateLimit: false,
    identity: { authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET, ...identity },
    ...extra,
  });
  return async (req: Request) => {
    const res = await h(req);
    const text = await res.text();
    browserBodies.push(text, JSON.stringify(Object.fromEntries(res.headers)));
    return { status: res.status, text, json: () => JSON.parse(text) };
  };
}
type TestHandler = ReturnType<typeof makeHandler>;

const BASE = "https://site.test/api/dewee";
const session = (h: TestHandler, uid?: string, body: unknown = {}) =>
  h(new Request(`${BASE}/session`, { method: "POST", headers: uid ? { cookie: `uid=${uid}` } : {}, body: JSON.stringify(body) }));
const chat = (h: TestHandler, token: string, body: Record<string, unknown> = {}, cookie?: string) =>
  h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ message: "hi", conversationId: "conv_ident1", ...body }) }));
const sse = (text: string): ChatStreamEvent[] => text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
const claimsOf = (token: string) => b64json(token.split(".")[0]);

describe("identity sessions: isolation", () => {
  it("gives users A and B different identity sessions and never sends a client-chosen user_id", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const b = (await session(h, "user-b")).json();
    expect(a.verified).toBe(true);
    expect(b.verified).toBe(true);
    expect(claimsOf(a.token).ids).not.toBe(claimsOf(b.token).ids);
    expect(a.visitorId).not.toBe(b.visitorId);

    const ra = sse((await chat(h, a.token, { agent: "support", userId: "evil" })).text);
    const connA = seen.connects.at(-1);
    expect(connA).toEqual({ token: GW_TOKEN, identity_session: claimsOf(a.token).ids });
    expect(connA).not.toHaveProperty("user_id");
    const rb = sse((await chat(h, b.token)).text);
    expect(seen.connects.at(-1).identity_session).toBe(claimsOf(b.token).ids);
    expect(ra.at(-1)).toMatchObject({ type: "done" });
    expect((ra.at(-1) as any).content).not.toBe((rb.at(-1) as any).content);
  });

  it("keeps chatting as A when A's visitor token is replayed with B's cookie (no switch)", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const asA = sse((await chat(h, a.token)).text).at(-1) as any;
    const replay = sse((await chat(h, a.token, {}, "uid=user-b")).text).at(-1) as any;
    expect(seen.connects.at(-1).identity_session).toBe(claimsOf(a.token).ids);
    expect(replay.content).toBe(asA.content);
  });

  it("keeps the same visitor id for the same user across sessions, so history follows them", async () => {
    const h = makeHandler();
    const first = (await session(h, "user-a")).json();
    const second = (await session(h, "user-a")).json();
    expect(second.visitorId).toBe(first.visitorId);
    expect(claimsOf(second.token).ids).not.toBe(claimsOf(first.token).ids);
  });

  it("answers 401 to a tampered or foreign-signed token", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const b = (await session(h, "user-b")).json();
    const [, sig] = a.token.split(".");
    const swapped = Buffer.from(JSON.stringify({ ...claimsOf(a.token), ids: claimsOf(b.token).ids })).toString("base64url");
    expect((await chat(h, `${swapped}.${sig}`)).status).toBe(401);
    const forged = await signVisitorToken("another-secret-of-at-least-32-chars!!", { v: "visitor_123", exp: Date.now() + 60_000, ids: claimsOf(b.token).ids, ida: "support" });
    expect((await chat(h, forged)).status).toBe(401);
  });

  it("binds the session to one agent", async () => {
    const h = makeHandler();
    const cfg = (await h(new Request(`${BASE}/config`))).json();
    expect(cfg).toMatchObject({ identity: true, allowAgentSwitch: false, defaultAgent: "support" });
    const a = (await session(h, "user-a")).json();
    expect(seen.exchanges.at(-1)).toMatchObject({ sub: "user-a", agent: "support" });
    expect((await chat(h, a.token, { agent: "sales" })).status).toBe(403);
  });
});

describe("identity sessions: fail closed", () => {
  it("refuses identity mode combined with client credentials and other misconfiguration", () => {
    const base = { gatewayUrl: "https://gw.example.com", token: GW_TOKEN, secret: VISITOR_SECRET, agents: ["support"] };
    const identity = { authenticate: cookieUser, appId: APP_ID, issuer: ISSUER, assertionSecret: ASSERTION_SECRET };
    expect(() => createDeweeHandler({ ...base, identity, allowClientCredentials: true })).toThrow(/allowClientCredentials/);
    expect(() => createDeweeHandler({ ...base, identity, allowClientCredentials: { allowedHosts: ["gw.example.com"] } })).toThrow(/allowClientCredentials/);
    expect(() => createDeweeHandler({ ...base, token: undefined, identity })).toThrow(/gatewayUrl and token/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, privateKeyJwk: privateJwk } })).toThrow(/exactly one/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, audience: "dewee:someone-else" } })).toThrow(/audience/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, appId: "acme" } })).toThrow(/appId/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, agent: "admin" } })).toThrow(/not in agents/);
    expect(() => createDeweeHandler({ ...base, identity: { ...identity, assertionSecret: "short" } })).toThrow(/too short/);
    // The error never echoes a secret.
    try { createDeweeHandler({ ...base, identity, allowClientCredentials: true }); } catch (e) { expect(String(e)).not.toContain(ASSERTION_SECRET); }
  });

  it("falls back to an anonymous visitor only when identity is not required", async () => {
    const h = makeHandler();
    for (const uid of [undefined, "boom"]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const s = (await session(h, uid)).json();
      warn.mockRestore();
      expect(s.verified).toBeUndefined();
      expect(claimsOf(s.token)).not.toHaveProperty("ids");
      await chat(h, s.token);
      expect(seen.connects.at(-1)).toEqual({ token: GW_TOKEN, user_id: `webchat-${s.visitorId}` });
    }
  });

  it("issues no session at all when identity is required and the user is not signed in", async () => {
    const h = makeHandler({ required: true });
    const none = await session(h);
    expect(none.status).toBe(401);
    expect(none.json()).toEqual({ error: { message: expect.any(String), code: "IDENTITY_REQUIRED", remediation: { action: "reauthenticate", audience: "end_user" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = await session(h, "boom");
    warn.mockRestore();
    expect(boom.status).toBe(503);
    expect(boom.json().error.code).toBe("SOURCE_UNAVAILABLE");
    expect(boom.json()).not.toHaveProperty("token");
    // An anonymous visitor token from before the switch is refused too.
    const anon = await signVisitorToken(VISITOR_SECRET, { v: "visitor_123", exp: Date.now() + 60_000 });
    const r = await chat(h, anon);
    expect([r.status, r.json().error.code]).toEqual([401, "IDENTITY_REQUIRED"]);
  });

  it("never downgrades a signed-in user whose exchange is refused", async () => {
    const h = makeHandler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await session(h, "suspended-user");
    const bad = await makeHandler({ assertionSecret: "wrong-secret-but-long-enough-0000000000001" })(
      new Request(`${BASE}/session`, { method: "POST", headers: { cookie: "uid=user-a" }, body: "{}" }),
    );
    const email = await session(h, "someone@example.com");
    warn.mockRestore();
    expect(r.status).toBe(401);
    expect(r.json()).toEqual({ error: { message: expect.any(String), code: "LINK_REVOKED", remediation: { action: "reauthenticate", audience: "end_user" } } });
    expect([bad.status, bad.json().error.code]).toEqual([401, "IDENTITY_REQUIRED"]);
    expect([email.status, email.json().error.code]).toEqual([500, "identity_misconfigured"]);
    for (const res of [r, bad, email]) expect(res.json()).not.toHaveProperty("token");
  });

  it("caps the visitor token at the identity session expiry", async () => {
    const short = (await session(makeHandler({ sessionTtlSeconds: 120 }), "user-a")).json();
    expect(seen.exchanges.at(-1)?.ttl).toBe(120);
    expect(short.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(short.expiresAt).toBeGreaterThan(Date.now() + 100_000);
    expect(claimsOf(short.token).exp).toBe(short.expiresAt);
    const visitorCap = (await session(makeHandler({}, { sessionTtlMs: 30_000 }), "user-a")).json();
    expect(visitorCap.expiresAt).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("anonymous handlers ignore identity tokens and expose no link route", async () => {
    const h = createDeweeHandler({ gatewayUrl, token: GW_TOKEN, secret: VISITOR_SECRET, agents: ["support"], rateLimit: false });
    const withIds = await signVisitorToken(VISITOR_SECRET, { v: "visitor_123", exp: Date.now() + 60_000, ids: "idsess_x", ida: "support" });
    const r = await h(new Request(`${BASE}/chat`, { method: "POST", headers: { authorization: `Bearer ${withIds}` }, body: JSON.stringify({ message: "hi" }) }));
    expect(r.status).toBe(401);
    expect((await h(new Request(`${BASE}/link`, { method: "POST", body: "{}" }))).status).toBe(404);
    const cfg = await (await h(new Request(`${BASE}/config`))).json();
    expect(cfg).not.toHaveProperty("identity");
  });
});

describe("identity sessions: typed gateway errors", () => {
  it("forwards LINK_EXPIRED at connect as a typed 401 for chat and history", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    expiredSessions.add(claimsOf(a.token).ids);
    const r = await chat(h, a.token);
    expect(r.status).toBe(401);
    expect(r.json()).toEqual({ error: { message: expect.any(String), code: "LINK_EXPIRED", remediation: { action: "reauthenticate", audience: "end_user" } } });
    const hist = await h(new Request(`${BASE}/history?agent=support&conversationId=conv_ident1`, { headers: { authorization: `Bearer ${a.token}` } }));
    expect([hist.status, hist.json().error.code]).toEqual([401, "LINK_EXPIRED"]);
  });

  it("forwards an identity error raised during the run in the event stream", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    revokeDuringRun.add(claimsOf(a.token).ids);
    const events = sse((await chat(h, a.token)).text);
    expect(events.at(-1)).toEqual({ type: "error", message: expect.any(String), code: "LINK_REVOKED", remediation: { action: "reauthenticate", audience: "end_user" } });
  });

  it("reads history as the session's user", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const r = await h(new Request(`${BASE}/history?agent=support&conversationId=conv_ident1`, { headers: { authorization: `Bearer ${a.token}` } }));
    expect(r.json().messages[0].content).toMatch(/^history of tuc:/);
    expect(seen.connects.at(-1)).not.toHaveProperty("user_id");
  });
});

describe("web-first linking", () => {
  it("returns the proof code and the chat accounts to send it to", async () => {
    const h = makeHandler();
    const a = (await session(h, "user-a")).json();
    const r = await h(new Request(`${BASE}/link`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify({ idempotencyKey: "req-1" }) }));
    expect(r.status).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ proofCode: "482913", deepLinks: [{ channelType: "telegram", name: "acme-bot", displayName: "Acme Bot" }] });
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refuses visitors who are not signed in", async () => {
    const h = makeHandler();
    const anon = (await session(h)).json();
    const r = await h(new Request(`${BASE}/link`, { method: "POST", headers: { authorization: `Bearer ${anon.token}` }, body: "{}" }));
    expect([r.status, r.json().error.code]).toEqual([401, "IDENTITY_REQUIRED"]);
  });
});

describe("jwks applications", () => {
  it("signs with a private JWK", async () => {
    const h = makeHandler({ assertionSecret: undefined, privateKeyJwk: privateJwk });
    const s = await session(h, "user-c");
    expect(s.status).toBe(200);
    expect(s.json().verified).toBe(true);
  });
});

describe("widget client", () => {
  it("re-requests /session on LINK_EXPIRED and keeps signed-in sessions out of storage", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });
    const calls: string[] = [];
    let chats = 0;
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "https://site.test").pathname.split("/").pop()!;
      calls.push(path);
      if (path === "config") return json(200, { agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "t", identity: true });
      if (path === "session") return json(200, { visitorId: "v_signed_in1", token: `tok${calls.length}`, expiresAt: Date.now() + 3_600_000, verified: true });
      if (path === "chat" && ++chats === 1) return json(401, { error: { message: "expired", code: "LINK_EXPIRED", remediation: { action: "reauthenticate", audience: "end_user" } } });
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer tok/);
      return new Response(`data: ${JSON.stringify({ type: "done", content: "ok" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }));
    try {
      const api = new ApiClient({ endpoint: "/api/dewee" });
      const events: ChatStreamEvent[] = [];
      await api.chat({ message: "hi", agent: "support", conversationId: "conv_ident1" }, (e) => events.push(e));
      expect(calls).toEqual(["config", "session", "chat", "session", "chat"]);
      expect(events).toEqual([{ type: "done", content: "ok" }]);
      expect([...storage.keys()]).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("has localized copy for every identity error", () => {
    for (const locale of ["en", "vi"]) {
      const s = pickStrings(locale);
      for (const code of ["IDENTITY_REQUIRED", "IDENTITY_LINK_REQUIRED", "IDENTITY_CONFLICT", "LINK_EXPIRED", "LINK_REVOKED", "PERMISSION_DENIED", "SOURCE_UNAVAILABLE"] as const) {
        expect(s.identityErrors[code]).toBeTruthy();
      }
    }
    expect(pickStrings("vi").identityErrors.LINK_EXPIRED).not.toBe(pickStrings("en").identityErrors.LINK_EXPIRED);
  });
});

describe("secret hygiene", () => {
  it("never sends the gateway token, assertion secret, visitor secret or private key to a browser", () => {
    expect(browserBodies.length).toBeGreaterThan(40);
    const all = browserBodies.join("\n");
    for (const secret of [GW_TOKEN, ASSERTION_SECRET, VISITOR_SECRET, privateJwk.d]) expect(all).not.toContain(secret);
  });
});

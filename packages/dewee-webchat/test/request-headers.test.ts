// @vitest-environment happy-dom
// Custom request headers, custom fetch and session reuse in the browser API client.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiClient, defineDeweeChat, type DeweeChatElement } from "../src/index";

interface Seen { path: string; headers: Record<string, string> }

function backend(opts: { ttlMs?: number } = {}) {
  const seen: Seen[] = [];
  let sessions = 0;
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), "https://site.test").pathname.replace("/api/dewee/", "");
    seen.push({ path, headers: { ...(init?.headers as Record<string, string>) } });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (path === "config") return json({ agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "test" });
    if (path === "session") return json({ visitorId: "v1", token: `tok${++sessions}`, expiresAt: Date.now() + (opts.ttlMs ?? 30 * 86_400_000) });
    if (path === "history") return json({ messages: [] });
    return new Response(`data: ${JSON.stringify({ type: "done", content: "ok" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  return { seen, fetchImpl, sessions: () => sessions };
}

const jsonRes = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/**
 * A backend that signs users in: every /session is a signed-in session `tok<n>`. `override` may answer
 * a call first (by path and per-path call number); `holdSession` may delay the n-th /session.
 */
function identityBackend(
  override?: (path: string, n: number) => Response | undefined,
  holdSession?: (n: number) => Promise<void> | undefined,
) {
  const seen: Seen[] = [];
  let sessions = 0;
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), "https://site.test").pathname.replace("/api/dewee/", "");
    seen.push({ path, headers: { ...(init?.headers as Record<string, string>) } });
    const n = seen.filter((s) => s.path === path).length;
    const answer = override?.(path, n);
    if (answer) return answer;
    if (path === "config") return jsonRes(200, { agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "test", identity: true });
    if (path === "session") {
      await holdSession?.(n);
      return jsonRes(200, { visitorId: "v_signed_in1", token: `tok${++sessions}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000, verified: true });
    }
    if (path === "link") return jsonRes(200, { proofCode: "482913", expiresAt: Date.now() + 600_000, deepLinks: [] });
    if (path === "history") return jsonRes(200, { messages: [] });
    return new Response(`data: ${JSON.stringify({ type: "done", content: "ok" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  return { seen, fetchImpl };
}

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("ApiClient headers", () => {
  it("merges custom headers into every request and evaluates a function per request", async () => {
    const b = backend();
    let n = 0;
    const api = new ApiClient({ endpoint: "/api/dewee", fetch: b.fetchImpl as typeof fetch, headers: async () => ({ "X-CSRF-Token": `csrf-${++n}` }) });
    await api.history("support", "conv_abc123");
    await api.chat({ message: "hi", agent: "support", conversationId: "conv_abc123" }, () => {});
    expect(b.seen.map((s) => s.path)).toEqual(["config", "session", "history", "chat"]);
    expect(b.seen.map((s) => s.headers["x-csrf-token"])).toEqual(["csrf-1", "csrf-2", "csrf-3", "csrf-4"]);
    expect(b.seen[3].headers.authorization).toBe("Bearer tok1");
  });

  it("never lets custom headers override reserved ones", async () => {
    const b = backend();
    const api = new ApiClient({
      endpoint: "/api/dewee",
      gatewayUrl: "https://gw.example.com",
      gatewayToken: "real",
      fetch: b.fetchImpl as typeof fetch,
      headers: { Authorization: "Bearer evil", "Content-Type": "text/plain", "X-Dewee-Gateway-Url": "https://evil.test", "x-dewee-gateway-token": "evil", "x-extra": "1" },
    });
    await api.history("support", "conv_abc123");
    const h = b.seen.at(-1)!.headers;
    expect(h).toEqual({ "x-extra": "1", "content-type": "application/json", "x-dewee-gateway-url": "https://gw.example.com", "x-dewee-gateway-token": "real", authorization: "Bearer tok1" });
  });

  it("sends custom headers on signed-in /link and /history, re-evaluated on renewal, without overriding reserved ones", async () => {
    // The first /link is refused (revoked link): the client renews the session and retries once.
    const { seen, fetchImpl } = identityBackend((path, n) =>
      path === "link" && n === 1 ? jsonRes(401, { error: { message: "revoked", code: "LINK_REVOKED" } }) : undefined,
    );
    let n = 0;
    const api = new ApiClient({
      endpoint: "/api/dewee",
      gatewayUrl: "https://gw.example.com",
      gatewayToken: "real",
      fetch: fetchImpl as typeof fetch,
      headers: () => ({
        "X-CSRF-Token": `csrf-${++n}`,
        Authorization: "Bearer evil",
        "content-type": "text/plain",
        "x-dewee-gateway-url": "https://evil.test",
        "X-Dewee-Gateway-Token": "evil",
      }),
    });
    expect((await api.link()).proofCode).toBe("482913");
    await api.history("support", "conv_abc123");
    expect(seen.map((s) => s.path)).toEqual(["config", "session", "link", "session", "link", "history"]);
    expect(seen.map((s) => s.headers["x-csrf-token"])).toEqual(["csrf-1", "csrf-2", "csrf-3", "csrf-4", "csrf-5", "csrf-6"]);
    const reserved = { "content-type": "application/json", "x-dewee-gateway-url": "https://gw.example.com", "x-dewee-gateway-token": "real" };
    expect(seen[2].headers).toEqual({ "x-csrf-token": "csrf-3", ...reserved, authorization: "Bearer tok1" });
    expect(seen[4].headers).toEqual({ "x-csrf-token": "csrf-5", ...reserved, authorization: "Bearer tok2" });
    expect(seen[5].headers).toEqual({ "x-csrf-token": "csrf-6", ...reserved, authorization: "Bearer tok2" });
    expect(localStorage.length).toBe(0); // signed-in sessions are never stored
  });

  it("sends the renewed token when renewSession() runs while host headers are pending", async () => {
    let releaseSession!: () => void;
    const { seen, fetchImpl } = identityBackend(undefined, (n) => (n === 2 ? new Promise<void>((r) => (releaseSession = r)) : undefined));
    const gates: (() => void)[] = [];
    let slow = false;
    const api = new ApiClient({
      endpoint: "/api/dewee",
      fetch: fetchImpl as typeof fetch,
      headers: () => (slow ? new Promise<Record<string, string>>((r) => gates.push(() => r({ "x-csrf-token": "late" }))) : {}),
    });
    await api.ensureSession();
    slow = true;
    const history = api.history("support", "conv_abc123");
    await vi.waitFor(() => expect(gates).toHaveLength(1)); // history waits on the host headers
    slow = false;
    const renewed = api.renewSession(); // host sign-in or sign-out meanwhile
    await vi.waitFor(() => expect(seen.filter((s) => s.path === "session")).toHaveLength(2));
    gates[0](); // host headers resolve while the new /session is still in flight
    releaseSession();
    await history;
    expect((await renewed).token).toBe("tok2");
    expect(seen.map((s) => s.path)).toEqual(["config", "session", "session", "history"]);
    expect(seen[3].headers).toEqual({ "x-csrf-token": "late", "content-type": "application/json", authorization: "Bearer tok2" });
  });

  it("re-applies host headers on the chat 401 retry with the renewed token", async () => {
    let n = 0;
    const { seen, fetchImpl } = identityBackend((path, k) =>
      path === "chat" && k === 1 ? jsonRes(401, { error: { message: "expired", code: "LINK_EXPIRED" } }) : undefined,
    );
    const api = new ApiClient({ endpoint: "/api/dewee", fetch: fetchImpl as typeof fetch, headers: () => ({ "x-csrf-token": `csrf-${++n}` }) });
    await api.chat({ message: "hi", agent: "support", conversationId: "conv_abc123" }, () => {});
    expect(seen.map((s) => s.path)).toEqual(["config", "session", "chat", "session", "chat"]);
    expect(seen[2].headers).toMatchObject({ "x-csrf-token": "csrf-3", authorization: "Bearer tok1" });
    expect(seen[4].headers).toMatchObject({ "x-csrf-token": "csrf-5", authorization: "Bearer tok2" });
  });

  it("never sends authorization to /config or /session, even with a session held", async () => {
    const anon = backend({ ttlMs: 60_000 });
    const a = new ApiClient({ endpoint: "/api/dewee", fetch: anon.fetchImpl as typeof fetch, headers: { "x-a": "1" } });
    await a.ensureSession();
    vi.useFakeTimers({ now: Date.now() + 45_000 }); // inside the 30 s margin: the stored token is refreshed
    try {
      await a.history("support", "conv_abc123");
      await a.getConfig(true);
    } finally {
      vi.useRealTimers();
    }
    const signed = identityBackend((path, k) => (path === "link" && k === 1 ? jsonRes(401, { error: { message: "revoked", code: "LINK_REVOKED" } }) : undefined));
    const s = new ApiClient({ endpoint: "/api/dewee", fetch: signed.fetchImpl as typeof fetch });
    await s.link();
    await s.renewSession();
    const all = [...anon.seen, ...signed.seen];
    const pre = all.filter((x) => x.path === "config" || x.path === "session");
    expect(anon.seen.map((x) => x.path)).toEqual(["config", "session", "session", "history", "config"]);
    expect(pre).toHaveLength(8); // anonymous: 2 config + 2 session; signed in: 1 config + 3 session

    expect(pre.every((x) => !("authorization" in x.headers))).toBe(true);
  });

  it("uses globalThis.fetch by default", async () => {
    const b = backend();
    vi.stubGlobal("fetch", b.fetchImpl);
    await new ApiClient({ endpoint: "/api/dewee", headers: { "x-a": "1" } }).getConfig();
    expect(b.seen[0].headers["x-a"]).toBe("1");
  });
});

describe("session reuse", () => {
  it("reuses a short-lived session until 10% of its lifetime remains", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    try {
      const b = backend({ ttlMs: 10 * 60_000 }); // 10 min tokens
      const api = new ApiClient({ endpoint: "/api/dewee", fetch: b.fetchImpl as typeof fetch });
      await api.ensureSession();
      vi.advanceTimersByTime(8 * 60_000);
      await api.ensureSession();
      expect(b.sessions()).toBe(1); // 2 min left > 1 min margin
      vi.advanceTimersByTime(90_000);
      await api.ensureSession();
      expect(b.sessions()).toBe(2); // 30 s left: refreshed
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the 24 h margin for long-lived sessions", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    try {
      const b = backend({ ttlMs: 30 * 86_400_000 });
      const api = new ApiClient({ endpoint: "/api/dewee", fetch: b.fetchImpl as typeof fetch });
      await api.ensureSession();
      vi.advanceTimersByTime(28 * 86_400_000);
      await api.ensureSession();
      expect(b.sessions()).toBe(1);
      vi.advanceTimersByTime(1.5 * 86_400_000);
      await api.ensureSession();
      expect(b.sessions()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("<dewee-chat> headers and fetch", () => {
  beforeAll(() => defineDeweeChat());

  it("applies configure({ headers, fetch }) and property updates without remounting", async () => {
    const b = backend();
    const el = document.createElement("dewee-chat") as DeweeChatElement;
    el.setAttribute("endpoint", "/api/dewee");
    el.setAttribute("mode", "inline");
    el.setAttribute("persist", "false");
    let csrf = "a";
    el.configure({ headers: () => ({ "x-csrf-token": csrf }), fetch: b.fetchImpl as typeof fetch });
    document.body.appendChild(el);
    await el.send("one");
    csrf = "b";
    await el.send("two");
    el.headers = { "x-csrf-token": "c" };
    await el.send("three");
    const chats = b.seen.filter((s) => s.path === "chat").map((s) => s.headers["x-csrf-token"]);
    expect(chats).toEqual(["a", "b", "c"]);
    expect(b.seen.every((s) => s.headers["x-csrf-token"])).toBe(true);
  });
});

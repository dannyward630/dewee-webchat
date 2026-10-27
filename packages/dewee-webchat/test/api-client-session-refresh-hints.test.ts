// @vitest-environment happy-dom
// How the browser client sizes its /session refreshes from the backend's refresh hint (`expiresIn`)
// and carries the tab's signed-in token as a reuse hint (`verifiedToken`) across page loads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/index";

const jsonRes = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const VERIFIED_KEY = "dewee-webchat:verified:/api/dewee";

type SessionAnswer = (n: number) => Response;

/** A backend recording each /session body; `answer` decides each /session response. */
function backend(identity: boolean, answer: SessionAnswer) {
  const bodies: Array<Record<string, string>> = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), "https://site.test").pathname.replace("/api/dewee/", "");
    if (path === "config") return jsonRes(200, { agents: [{ id: "shop" }], defaultAgent: "shop", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "test", ...(identity ? { identity: true } : {}) });
    if (path === "session") {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return answer(bodies.length);
    }
    if (path === "chat" && String((init?.headers as Record<string, string>)?.authorization).endsWith("revoked")) return jsonRes(401, { error: { code: "LINK_REVOKED", message: "revoked" } });
    return new Response(`data: ${JSON.stringify({ type: "done", content: "ok" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  return { bodies, fetch: fetchImpl as unknown as typeof fetch };
}

const page = (fetchImpl: typeof fetch) => new ApiClient({ endpoint: "/api/dewee", fetch: fetchImpl });

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("anonymous refresh hint", () => {
  it("comes back before the reported refresh point even though the token itself lives 30 days", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ["Date"] });
    const b = backend(false, (n) => jsonRes(200, { visitorId: "v_anon_001", token: `anon${n}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000 }));
    await page(b.fetch).ensureSession();
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await page(b.fetch).ensureSession(); // a later page load: still fresh
    expect(b.bodies).toHaveLength(1);
    vi.setSystemTime(Date.now() + 26 * 60_000); // 4 min left, under the 6 min margin
    const s = await page(b.fetch).ensureSession();
    expect(b.bodies).toHaveLength(2);
    expect(b.bodies[1].token).toBe("anon1"); // same visitor refreshed, not a new one
    expect(s.token).toBe("anon2");
  });

  it("counts the hint from receipt, so a browser clock that runs ahead does not refresh every load", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000, toFake: ["Date"] });
    // The server's clock is 2 h behind the browser's: its absolute expiresAt is already "past".
    const b = backend(false, (n) => jsonRes(200, { visitorId: "v_anon_002", token: `anon${n}`, expiresAt: Date.now() - 3_600_000, expiresIn: 3_600_000 }));
    await page(b.fetch).ensureSession();
    await page(b.fetch).ensureSession();
    expect(b.bodies).toHaveLength(1);
  });
});

describe("signed-in reuse hint", () => {
  const verified = (n: number) => jsonRes(200, { visitorId: "v_member_01", token: `member${n}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000, verified: true });

  it("sends the tab's previous signed-in token on the next page load, and never stores it in localStorage", async () => {
    const b = backend(true, verified);
    await page(b.fetch).ensureSession();
    expect(b.bodies[0].verifiedToken).toBeUndefined();
    expect(sessionStorage.getItem(VERIFIED_KEY)).toBe("member1");
    expect(JSON.stringify({ ...localStorage })).not.toContain("member1");
    await page(b.fetch).ensureSession();
    expect(b.bodies[1].verifiedToken).toBe("member1");
    expect(sessionStorage.getItem(VERIFIED_KEY)).toBe("member2");
  });

  it("drops the hint when the backend answers anonymously or refuses the session", async () => {
    const anon = backend(true, (n) => (n === 1 ? verified(n) : jsonRes(200, { visitorId: "v_anon_003", token: "anon", expiresAt: Date.now() + 3_600_000 })));
    await page(anon.fetch).ensureSession();
    await page(anon.fetch).ensureSession();
    expect(sessionStorage.getItem(VERIFIED_KEY)).toBeNull();

    const refused = backend(true, (n) => (n === 1 ? verified(n) : jsonRes(401, { error: { code: "IDENTITY_REQUIRED", message: "sign in" } })));
    await page(refused.fetch).ensureSession();
    await expect(page(refused.fetch).ensureSession()).rejects.toMatchObject({ status: 401 });
    expect(sessionStorage.getItem(VERIFIED_KEY)).toBeNull();
  });

  it("drops the hint of a session the backend refused on chat, so the renewal does not offer it again", async () => {
    const b = backend(true, (n) => jsonRes(200, { visitorId: "v_member_01", token: n === 1 ? "revoked" : `member${n}`, expiresAt: Date.now() + 3_600_000, expiresIn: 3_600_000, verified: true }));
    const api = page(b.fetch);
    await api.chat({ agent: "shop", conversationId: "conv_hint_0001", message: "hi" }, () => {});
    expect(b.bodies).toHaveLength(2);
    expect(b.bodies[1].verifiedToken).toBeUndefined();
    expect(sessionStorage.getItem(VERIFIED_KEY)).toBe("member2");
  });
});

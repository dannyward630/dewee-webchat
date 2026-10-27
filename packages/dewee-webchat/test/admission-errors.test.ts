import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { createDeweeHandler } from "../src/server";
import { DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS, admissionErrorEvent, admissionErrorResponse, normalizeRetryAfterMs } from "../src/server/admission-errors";
import type { ChatStreamEvent } from "../src/protocol";

const SECRET_TEXT = "limit chat.send for tenant acme exceeded (admin: ops@internal)";

// A fake gateway whose chat.send is refused with the error the message asks for (`refuse:<json>`).
let wss: WebSocketServer;
let gatewayUrl = "";

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  gatewayUrl = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.method === "connect") return ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: {} }));
      if (f.method === "chat.send") {
        const error = JSON.parse(String(f.params.message).slice("refuse:".length));
        return ws.send(JSON.stringify({ type: "res", id: f.id, ok: false, error: { message: SECRET_TEXT, ...error } }));
      }
      ws.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: {} }));
    });
  });
});

afterAll(() => wss.close());

async function chat(error: Record<string, unknown>): Promise<{ res: Response; events: ChatStreamEvent[] }> {
  const h = createDeweeHandler({ gatewayUrl, token: "good", secret: "s".repeat(32), agents: ["support"], rateLimit: false });
  const s = (await (await h(new Request("https://site.test/api/dewee/session", { method: "POST", body: "{}" }))).json()) as { token: string };
  const res = await h(
    new Request("https://site.test/api/dewee/chat", {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ message: `refuse:${JSON.stringify(error)}` }),
    }),
  );
  // text() resolves only once the server closed the stream: a hang fails the test by timeout.
  const text = await res.text();
  return { res, events: text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5))) };
}

describe("admission error mapping", () => {
  it("maps POLICY_DENIED without a cooldown", () => {
    expect(admissionErrorEvent("POLICY_DENIED", 9000)).toEqual({ type: "error", message: "This message can't be sent.", code: "POLICY_DENIED" });
  });

  it("maps RATE_LIMITED with a normalized retryAfterMs", () => {
    expect(admissionErrorEvent("RATE_LIMITED", 1234.2)).toEqual({ type: "error", message: "Too many messages, please wait a moment.", code: "RATE_LIMITED", retryAfterMs: 1235 });
    expect(admissionErrorEvent("RATE_LIMITED").retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
  });

  it("reserves CHALLENGE_REQUIRED as a typed code without a payload", () => {
    expect(admissionErrorEvent("CHALLENGE_REQUIRED", 10)).toEqual({ type: "error", message: "Verification is required to continue.", code: "CHALLENGE_REQUIRED" });
  });

  it("defaults and caps retryAfterMs", () => {
    for (const bad of [undefined, null, 0, -5, NaN, Infinity, "", "soon", true, {}]) expect(normalizeRetryAfterMs(bad)).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(normalizeRetryAfterMs("2500")).toBe(2500);
    expect(normalizeRetryAfterMs(10 * MAX_RETRY_AFTER_MS)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("answers refusals before streaming as JSON with Retry-After", () => {
    expect(admissionErrorResponse("RATE_LIMITED", 1500)).toEqual({
      status: 429,
      body: { error: { message: "Too many messages, please wait a moment.", code: "RATE_LIMITED", retryAfterMs: 1500 } },
      headers: { "retry-after": "2" },
    });
    expect(admissionErrorResponse("POLICY_DENIED")).toEqual({ status: 403, body: { error: { message: "This message can't be sent.", code: "POLICY_DENIED" } }, headers: {} });
  });
});

describe("POST /chat with a refused chat.send", () => {
  it("streams a typed POLICY_DENIED error and ends the stream", async () => {
    const { res, events } = await chat({ code: "POLICY_DENIED", retryable: false });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    expect(events[1]).toEqual({ type: "error", message: "This message can't be sent.", code: "POLICY_DENIED" });
  });

  it("streams RATE_LIMITED with the gateway's retryAfterMs", async () => {
    const { events } = await chat({ code: "RATE_LIMITED", retryable: true, retryAfterMs: 7000 });
    expect(events.at(-1)).toEqual({ type: "error", message: "Too many messages, please wait a moment.", code: "RATE_LIMITED", retryAfterMs: 7000 });
  });

  it("streams CHALLENGE_REQUIRED typed and nothing else", async () => {
    const { events } = await chat({ code: "CHALLENGE_REQUIRED", details: { challenge: "ctx-123" } });
    expect(events.at(-1)).toEqual({ type: "error", message: "Verification is required to continue.", code: "CHALLENGE_REQUIRED" });
  });

  it("never forwards the gateway's own message for admission refusals", async () => {
    for (const code of ["POLICY_DENIED", "RATE_LIMITED", "CHALLENGE_REQUIRED"]) {
      const { events } = await chat({ code, retryAfterMs: 100 });
      expect(JSON.stringify(events)).not.toContain("acme");
    }
  });
});

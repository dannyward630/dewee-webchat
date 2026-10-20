// @vitest-environment happy-dom
// Drives <dewee-chat> against a mocked backend: auto-turn bound, confirmation gate, backward compat.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

type Reply = (body: any, n: number) => { content: string; actionsHash?: string };

function mockBackend(reply: Reply) {
  const chats: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site.test").pathname;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (path.endsWith("/config")) return json({ agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "test" });
    if (path.endsWith("/session")) return json({ visitorId: "v1", token: "t", expiresAt: Date.now() + 7 * 86_400_000 });
    if (path.endsWith("/history")) return json({ messages: [] });
    const body = JSON.parse(String(init?.body));
    chats.push(body);
    const r = reply(body, chats.length);
    const frames = [{ type: "start", conversationId: body.conversationId, agent: body.agent, actionsHash: r.actionsHash }, { type: "done", content: r.content }];
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }));
  return chats;
}

async function mount(): Promise<DeweeChatElement> {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  el.setAttribute("endpoint", "/api/dewee");
  el.setAttribute("mode", "inline");
  el.setAttribute("persist", "false");
  document.body.appendChild(el);
  await new Promise((r) => setTimeout(r, 0));
  return el;
}

const directive = (name: string, args: unknown = {}, id = "c1") => "Working on it.\n\n```dewee-action\n" + JSON.stringify({ id, name, args }) + "\n```";

beforeAll(() => defineDeweeChat());
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("<dewee-chat> page actions", () => {
  it("stops automatic turns after maxActionRounds", async () => {
    const chats = mockBackend(() => ({ content: directive("navigate", { route: "/runs" }), actionsHash: "h1" }));
    const el = await mount();
    const handler = vi.fn(async () => ({ ok: true }));
    el.configure({ maxActionRounds: 2 });
    el.registerActions({ name: "navigate", description: "Go", sensitivity: "navigate", handler });
    const events: any[] = [];
    el.addEventListener("dewee:action", (e) => events.push((e as CustomEvent).detail));
    await el.send("open runs");
    expect(chats).toHaveLength(3); // visitor turn + 2 automatic result turns
    expect(handler).toHaveBeenCalledTimes(2);
    expect(chats[0].actions).toEqual([{ name: "navigate", description: "Go", sensitivity: "navigate", parameters: { type: "object", properties: {} } }]);
    expect(chats[0].actionsHash).toBeUndefined();
    expect(chats[1].actionsHash).toBe("h1"); // acknowledged after the first done turn
    expect(chats[1].message.startsWith("```dewee-action-result\n")).toBe(true);
    expect(events.filter((e) => e.phase === "result").map((e) => e.status)).toEqual(["ok", "ok"]);
    const shadow = el.shadowRoot!;
    const visible = [...shadow.querySelectorAll(".msg:not([hidden])")].map((m) => m.textContent).join("\n");
    expect(visible).toContain("Working on it.");
    expect(visible).not.toContain('"name":"navigate"'); // directive and result blocks hidden from the transcript
    expect(shadow.querySelector(".notice")?.textContent).toContain("2");
  });

  it("never runs a mutate handler the host does not approve, and reports the denial", async () => {
    const chats = mockBackend((_b, n) => ({ content: n === 1 ? directive("runs.cancel", { id: "r1" }) : "Okay, I left it running." }));
    const el = await mount();
    const handler = vi.fn();
    const confirm = vi.fn(async () => false);
    el.configure({ confirm });
    el.registerActions({ name: "runs.cancel", description: "Cancel a run", sensitivity: "mutate", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, handler });
    await el.send("cancel r1");
    expect(confirm).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(chats).toHaveLength(2);
    expect(chats[1].message).toContain('"status":"denied"');
  });

  it("sends the page context with every turn", async () => {
    const chats = mockBackend(() => ({ content: "hi" }));
    const el = await mount();
    el.configure({ getPageContext: () => ({ route: "/runs" }) });
    await el.send("where am I?");
    expect(chats[0].pageContext).toEqual({ route: "/runs" });
  });

  it("keeps the old wire format and rendering without actions", async () => {
    const block = directive("navigate");
    const chats = mockBackend(() => ({ content: block }));
    const el = await mount();
    await el.send("hello");
    expect(chats).toHaveLength(1);
    expect(Object.keys(chats[0]).sort()).toEqual(["agent", "conversationId", "message"]);
    expect(el.shadowRoot!.textContent).toContain('"name":"navigate"'); // shown as a normal code block
  });
});

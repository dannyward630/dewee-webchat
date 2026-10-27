// @vitest-environment happy-dom
// Drives <dewee-chat> against a backend that refuses messages: cooldown after RATE_LIMITED, inline POLICY_DENIED.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineDeweeChat, type DeweeChatElement } from "../src/index";

/** `refusal` is the error event of the next /chat, or null to answer normally. */
function mockBackend(refusal: () => Record<string, unknown> | null) {
  const chats: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site.test").pathname;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (path.endsWith("/config")) return json({ agents: [{ id: "support" }], defaultAgent: "support", allowAgentSwitch: false, allowClientCredentials: false, maxMessageLength: 4000, version: "test" });
    if (path.endsWith("/session")) return json({ visitorId: "v1", token: "t", expiresAt: Date.now() + 7 * 86_400_000 });
    if (path.endsWith("/history")) return json({ messages: [] });
    const body = JSON.parse(String(init?.body));
    chats.push(body);
    const err = refusal();
    const frames = [{ type: "start", conversationId: body.conversationId, agent: body.agent }, err ? { type: "error", ...err } : { type: "done", content: "ok" }];
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }));
  return chats;
}

async function mount(): Promise<DeweeChatElement> {
  const el = document.createElement("dewee-chat") as DeweeChatElement;
  el.setAttribute("endpoint", "/api/dewee");
  el.setAttribute("mode", "inline");
  el.setAttribute("persist", "false");
  el.setAttribute("locale", "en");
  document.body.appendChild(el);
  await new Promise((r) => setTimeout(r, 0));
  return el;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => defineDeweeChat());
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("<dewee-chat> admission errors", () => {
  it("disables send during the RATE_LIMITED cooldown, announces it and re-enables send", async () => {
    let refuse = true;
    const chats = mockBackend(() => (refuse ? { message: "Too many messages, please wait a moment.", code: "RATE_LIMITED", retryAfterMs: 400 } : null));
    const el = await mount();
    const errors: any[] = [];
    el.addEventListener("dewee:error", (e) => errors.push((e as CustomEvent).detail));
    const shadow = el.shadowRoot!;
    const send = shadow.querySelector<HTMLButtonElement>(".send")!;
    const cooldown = shadow.querySelector<HTMLElement>(".cooldown")!;
    const announcer = shadow.querySelector<HTMLElement>('[role="status"][aria-live="polite"].announcer')!;

    await el.send("hello");
    expect(errors).toEqual([{ message: "You're sending messages too quickly.", code: "RATE_LIMITED", retryAfterMs: 400 }]);
    // The refused message is handed back to the composer, but cannot be sent yet.
    expect(shadow.querySelector("textarea")!.value).toBe("hello");
    expect(send.disabled).toBe(true);
    expect(cooldown.hidden).toBe(false);
    expect(cooldown.textContent).toBe("You can send again in 1s");
    expect(announcer.textContent).toBe("Sending is paused. You can send again in 1 second.");

    refuse = false;
    await el.send("too soon");
    expect(chats).toHaveLength(1); // nothing is sent while cooling down

    await wait(500);
    expect(send.disabled).toBe(false);
    expect(cooldown.hidden).toBe(true);
    expect(announcer.textContent).toBe("You can send messages again.");
    await el.send("hello again");
    expect(chats).toHaveLength(2);
  });

  it("shows POLICY_DENIED next to the refused message, without a cooldown", async () => {
    mockBackend(() => ({ message: "This message can't be sent.", code: "POLICY_DENIED" }));
    const el = await mount();
    await el.send("a very long message");
    const shadow = el.shadowRoot!;
    const user = shadow.querySelector(".msg.user")!;
    expect(user.classList.contains("refused")).toBe(true);
    expect(user.querySelector(".refusal")?.textContent).toContain("This message can't be sent. Try shortening or rephrasing it.");
    expect(shadow.querySelectorAll(".msg.assistant:not([hidden])")).toHaveLength(0);
    expect(shadow.querySelector<HTMLElement>(".cooldown")!.hidden).toBe(true);
    expect(shadow.querySelector("textarea")!.value).toBe("a very long message");
    expect(shadow.querySelector<HTMLButtonElement>(".send")!.disabled).toBe(false);
    // A re-render (any attribute change) keeps the refusal next to the message.
    el.setAttribute("theme", "dark");
    expect(shadow.querySelector(".msg.user.refused .refusal")?.textContent).toContain("This message can't be sent.");
    expect(shadow.querySelectorAll(".msg.assistant:not([hidden])")).toHaveLength(0);
  });

  it("shows CHALLENGE_REQUIRED as a plain localized error, with no challenge UI", async () => {
    mockBackend(() => ({ message: "Verification is required to continue.", code: "CHALLENGE_REQUIRED" }));
    const el = await mount();
    await el.send("hi");
    const shadow = el.shadowRoot!;
    expect(shadow.querySelector(".msg.assistant.error")?.textContent).toContain("Extra verification is needed.");
    expect(document.querySelector('[slot="challenge"]')).toBeNull();
  });
});

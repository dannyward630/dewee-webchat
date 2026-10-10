// <dewee-chat> — framework-agnostic chat widget (Shadow DOM, zero dependencies).
import type { AgentInfo, ChatStreamEvent, HistoryMessage, PublicConfig, ToolCallView } from "../protocol";
import { ApiClient, ApiError } from "./api-client";
import { icons, pickStrings, type Strings } from "./i18n";
import { renderMarkdown } from "./markdown";
import { styles } from "./styles";

export interface DeweeChatConfig {
  /** Backend base URL (the server handler). Default: "/api/dewee". */
  endpoint: string;
  /** Agent key to talk to. Default: the backend's default agent. */
  agent?: string;
  title?: string;
  subtitle?: string;
  /** Welcome heading and text shown before the first message. */
  greeting?: string;
  intro?: string;
  placeholder?: string;
  /** Quick-reply prompts shown on the welcome screen. */
  suggestions?: string[];
  /** Image URL used for the header avatar (and launcher when `launcherAvatar`). */
  avatar?: string;
  launcherAvatar?: boolean;
  position?: "bottom-right" | "bottom-left";
  /** "floating" (launcher + popup) or "inline" (fills its container). */
  mode?: "floating" | "inline";
  theme?: "light" | "dark" | "auto";
  accentColor?: string;
  locale?: string;
  /** Show the model's reasoning stream. Default true. */
  showReasoning?: boolean;
  /** Show tool calls and their results. Default true. */
  showToolCalls?: boolean;
  /** Show an agent picker when the backend allows switching. Default true. */
  allowAgentSwitch?: boolean;
  /** Start opened. */
  open?: boolean;
  /** Remember the conversation across page loads. Default true. */
  persist?: boolean;
  hideBranding?: boolean;
  /** Bring-your-own gateway credentials (backend must enable allowClientCredentials). */
  gatewayUrl?: string;
  gatewayToken?: string;
  width?: string;
  height?: string;
  zIndex?: number;
}

interface ViewRefs {
  root: HTMLElement;
  trace: HTMLElement;
  md: HTMLElement;
  thinking?: HTMLDetailsElement;
  tools: Map<string, HTMLDetailsElement>;
}

interface ViewMessage extends HistoryMessage {
  status?: "streaming" | "done" | "error";
  startedAt?: number;
  thinkingMs?: number;
  view?: ViewRefs;
}

const BOOL_ATTRS = ["show-reasoning", "show-tool-calls", "allow-agent-switch", "open", "persist", "hide-branding", "launcher-avatar"];
const ATTRS = [
  "endpoint", "agent", "title", "subtitle", "greeting", "intro", "placeholder", "suggestions", "avatar", "position",
  "mode", "theme", "accent-color", "locale", "gateway-url", "gateway-token", "width", "height", "z-index", ...BOOL_ATTRS,
];

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const parseBool = (v: string | null) => v !== null && !/^(false|0|off|no)$/i.test(v);
const randomConversationId = () => {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[x & 63]).join("");
};
const prettyToolName = (n: string) => n.replace(/^mcp_[^_]+(?:_[^_]+)*?__/, "").replace(/_/g, " ");
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

let turnstileScript: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  return (turnstileScript ??= new Promise((resolve, reject) => {
    if ((window as any).turnstile) return resolve();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Turnstile"));
    document.head.appendChild(s);
  }));
}

export class DeweeChatElement extends HTMLElement {
  static get observedAttributes() { return ATTRS; }

  private root: ShadowRoot;
  private overrides: Partial<DeweeChatConfig> = {};
  private api: ApiClient | null = null;
  private apiKey = "";
  private server: PublicConfig | null = null;
  private agentId = "";
  private conversationId = "";
  private messages: ViewMessage[] = [];
  private running: AbortController | null = null;
  private activated = false;
  private strings: Strings = pickStrings();
  private mql: MediaQueryList | null = null;
  private els!: {
    launcher: HTMLButtonElement; panel: HTMLElement; log: HTMLElement; title: HTMLElement; subtitle: HTMLElement;
    status: HTMLElement; avatar: HTMLElement; select: HTMLSelectElement; input: HTMLTextAreaElement; send: HTMLButtonElement;
    newChat: HTMLButtonElement; close: HTMLButtonElement; foot: HTMLElement;
  };

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  // ---------- public API ----------

  /** Current effective configuration (attributes merged with `configure()` overrides). */
  get config(): DeweeChatConfig {
    const c: Record<string, unknown> = { endpoint: "/api/dewee" };
    for (const a of ATTRS) {
      const v = this.getAttribute(a);
      if (v === null) continue;
      if (BOOL_ATTRS.includes(a)) c[camel(a)] = parseBool(v);
      else if (a === "suggestions") c.suggestions = v.trim().startsWith("[") ? safeJson(v, []) : v.split("|").map((s) => s.trim()).filter(Boolean);
      else if (a === "z-index") c.zIndex = Number(v);
      else c[camel(a)] = v;
    }
    return { ...c, ...this.overrides } as DeweeChatConfig;
  }

  /** Updates configuration at runtime (wins over attributes). */
  configure(partial: Partial<DeweeChatConfig>): void {
    this.overrides = { ...this.overrides, ...partial };
    if (this.els) this.applyConfig(); // otherwise applied on connect
  }

  open(): void {
    if (this.config.mode === "inline") return;
    this.setAttribute("data-open", "");
    this.removeAttribute("data-unread");
    this.els.launcher.setAttribute("aria-expanded", "true");
    this.activate();
    setTimeout(() => this.els.input.focus(), 120);
    this.emit("dewee:open");
  }

  close(): void {
    if (this.config.mode === "inline") return;
    this.removeAttribute("data-open");
    this.els.launcher.setAttribute("aria-expanded", "false");
    this.emit("dewee:close");
  }

  toggle(): void {
    this.hasAttribute("data-open") ? this.close() : this.open();
  }

  /** Sends a message programmatically (opens the widget first). */
  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.running) return;
    if (this.config.mode !== "inline" && !this.hasAttribute("data-open")) this.open();
    await this.activate();
    this.els.input.value = "";
    this.autosize();
    this.pushMessage({ role: "user", content: message });
    const reply: ViewMessage = { role: "assistant", content: "", status: "streaming", startedAt: Date.now() };
    this.pushMessage(reply);
    this.setRunning(new AbortController());
    this.emit("dewee:send", { message, agent: this.agentId, conversationId: this.conversationId });
    try {
      await this.client().chat(
        { message, agent: this.agentId, conversationId: this.conversationId },
        (e) => this.onStreamEvent(reply, e),
        this.running!.signal,
      );
      if (reply.status === "streaming") reply.status = "done";
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        reply.status = "done";
        if (!reply.content) reply.content = `_${this.strings.stopped}_`;
      } else {
        reply.status = "error";
        this.showError(reply, e as Error);
      }
    } finally {
      this.finishThinking(reply);
      this.updateMessage(reply);
      this.setRunning(null);
      if (reply.status === "done") {
        this.emit("dewee:reply", { content: reply.content, agent: this.agentId, conversationId: this.conversationId });
        if (this.config.mode !== "inline" && !this.hasAttribute("data-open")) this.setAttribute("data-unread", "");
      }
    }
  }

  /** Stops the running reply. */
  stop(): void {
    this.running?.abort();
  }

  /** Starts a fresh conversation with the current agent. */
  newConversation(): void {
    this.stop();
    this.conversationId = randomConversationId();
    if (this.config.persist !== false) store.set(this.convKey(), this.conversationId);
    this.messages = [];
    this.renderLog();
    this.els.input.focus();
  }

  // ---------- lifecycle ----------

  connectedCallback(): void {
    if (!this.els) this.renderShell();
    this.applyConfig();
    if (this.config.mode === "inline" || this.config.open) {
      if (this.config.mode !== "inline") this.open();
      else this.activate();
    }
  }

  disconnectedCallback(): void {
    this.stop();
    this.mql?.removeEventListener("change", this.onScheme);
  }

  attributeChangedCallback(): void {
    if (this.els) this.applyConfig();
  }

  // ---------- internals ----------

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private client(): ApiClient {
    const c = this.config;
    const key = [c.endpoint, c.gatewayUrl, c.gatewayToken].join("|");
    if (!this.api || key !== this.apiKey) {
      this.apiKey = key;
      this.api = new ApiClient({
        endpoint: c.endpoint,
        gatewayUrl: c.gatewayUrl,
        gatewayToken: c.gatewayToken,
        turnstile: (siteKey) => this.challenge(siteKey),
      });
    }
    return this.api;
  }

  private convKey(): string {
    return `dewee-webchat:conv:${this.config.endpoint}:${this.config.gatewayUrl || ""}:${this.agentId}`;
  }

  private onScheme = () => this.applyTheme();

  private applyTheme() {
    const t = this.config.theme || "light";
    const dark = t === "dark" || (t === "auto" && !!this.mql?.matches);
    this.setAttribute("data-theme", dark ? "dark" : "light");
  }

  private applyConfig(): void {
    const c = this.config;
    this.strings = pickStrings(c.locale);
    const s = this.strings;
    this.setAttribute("data-position", c.position || "bottom-right");
    this.setAttribute("data-mode", c.mode || "floating");
    if (c.theme === "auto" && !this.mql) {
      this.mql = matchMedia("(prefers-color-scheme: dark)");
      this.mql.addEventListener("change", this.onScheme);
    }
    this.applyTheme();
    const setVar = (k: string, v?: string | number) => (v !== undefined && v !== "" ? this.style.setProperty(k, String(v)) : this.style.removeProperty(k));
    setVar("--dw-accent", c.accentColor);
    setVar("--dw-width", c.width);
    setVar("--dw-height", c.height);
    setVar("--dw-z", c.zIndex);

    const e = this.els;
    e.title.textContent = c.title || s.title;
    e.avatar.replaceChildren();
    if (c.avatar) {
      const img = document.createElement("img");
      img.src = c.avatar;
      img.alt = "";
      e.avatar.appendChild(img);
    } else e.avatar.textContent = (c.title || s.title).trim().charAt(0).toUpperCase();
    e.launcher.innerHTML = c.avatar && c.launcherAvatar ? "" : icons.chat;
    if (c.avatar && c.launcherAvatar) {
      const img = document.createElement("img");
      img.src = c.avatar;
      img.alt = "";
      e.launcher.appendChild(img);
    }
    e.launcher.insertAdjacentHTML("beforeend", `<span class="badge"></span>`);
    e.launcher.setAttribute("aria-label", s.open);
    e.close.setAttribute("aria-label", s.close);
    e.close.title = s.close;
    e.newChat.setAttribute("aria-label", s.newChat);
    e.newChat.title = s.newChat;
    e.input.placeholder = c.placeholder || s.placeholder;
    e.foot.hidden = !!c.hideBranding;
    e.foot.querySelector(".by")!.textContent = s.poweredBy + " ";
    this.renderSubtitle();
    this.updateSendButton();

    // Credentials or endpoint changed after activation: reload server config.
    if (this.activated && this.api && this.apiKey !== [c.endpoint, c.gatewayUrl, c.gatewayToken].join("|")) {
      this.activated = false;
      this.server = null;
      this.activate();
    } else if (this.activated && c.agent && c.agent !== this.agentId && this.server) {
      this.switchAgent(c.agent);
    } else if (this.activated) {
      this.renderLog();
    }
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <style>${styles}</style>
      <button class="launcher" part="launcher" aria-expanded="false" aria-haspopup="dialog"></button>
      <section class="panel" part="panel" role="dialog" aria-label="Chat">
        <header class="head" part="header">
          <div class="avatar"></div>
          <div class="who">
            <div class="title"></div>
            <div class="subtitle"><span class="dot"></span><span class="status"></span><select class="agent-select" hidden></select></div>
          </div>
          <button class="icon-btn new">${icons.newChat}</button>
          <button class="icon-btn close">${icons.close}</button>
        </header>
        <div class="log" part="log" role="log" aria-live="polite"></div>
        <div class="challenge"><slot name="challenge"></slot></div>
        <form class="composer" part="composer">
          <div class="box">
            <textarea rows="1" maxlength="4000"></textarea>
            <button class="send" type="submit"></button>
          </div>
          <div class="foot"><span><span class="by"></span><a href="https://dewee.sh" target="_blank" rel="noopener">dewee</a></span><span class="meta"></span></div>
        </form>
      </section>`;
    const $ = <T extends Element>(sel: string) => this.root.querySelector(sel) as T;
    this.els = {
      launcher: $(".launcher"), panel: $(".panel"), log: $(".log"), title: $(".title"), subtitle: $(".subtitle"),
      status: $(".status"), avatar: $(".avatar"), select: $(".agent-select"), input: $("textarea"), send: $(".send"),
      newChat: $(".new"), close: $(".close"), foot: $(".foot"),
    };
    const e = this.els;
    e.launcher.addEventListener("click", () => this.toggle());
    e.close.addEventListener("click", () => this.close());
    // Follow the stream until the visitor scrolls up; content growth alone fires no scroll event.
    e.log.addEventListener("scroll", () => { this.following = this.nearBottom(); }, { passive: true });
    e.newChat.addEventListener("click", () => this.newConversation());
    e.select.addEventListener("change", () => this.switchAgent(e.select.value));
    $<HTMLFormElement>("form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.running ? this.stop() : this.send(e.input.value);
    });
    e.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        if (!this.running) this.send(e.input.value);
      }
    });
    e.input.addEventListener("input", () => { this.autosize(); this.updateSendButton(); });
    e.panel.addEventListener("keydown", (ev) => { if (ev.key === "Escape") this.close(); });
  }

  private autosize() {
    const t = this.els.input;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 140) + "px";
  }

  private updateSendButton() {
    const b = this.els.send;
    b.innerHTML = this.running ? icons.stop : icons.send;
    b.setAttribute("aria-label", this.running ? this.strings.stop : this.strings.send);
    b.title = b.getAttribute("aria-label")!;
    b.disabled = !this.running && !this.els.input.value.trim();
  }

  private setRunning(ctrl: AbortController | null) {
    this.running = ctrl;
    this.updateSendButton();
  }

  private renderSubtitle() {
    const e = this.els;
    const c = this.config;
    const agents = this.server?.agents ?? [];
    const canSwitch = c.allowAgentSwitch !== false && !!this.server?.allowAgentSwitch && agents.length > 1;
    e.select.hidden = !canSwitch;
    e.status.hidden = canSwitch;
    if (canSwitch) {
      e.select.replaceChildren(...agents.map((a) => new Option(a.name || a.id, a.id, false, a.id === this.agentId)));
      e.select.setAttribute("aria-label", "Agent");
    }
    const current = agents.find((a) => a.id === this.agentId);
    e.status.textContent = c.subtitle || (current?.name && current.name !== c.title ? `${this.strings.online} · ${current.name}` : this.strings.online);
  }

  /** Loads backend config and the persisted conversation once. */
  private async activate(): Promise<void> {
    if (this.activated) return;
    this.activated = true;
    this.renderLog();
    try {
      this.server = await this.client().getConfig(true);
      this.els.input.maxLength = this.server.maxMessageLength;
      const wanted = this.config.agent;
      const known = (id?: string) => !!id && (this.server!.agents.length === 0 || this.server!.agents.some((a: AgentInfo) => a.id === id));
      this.agentId = known(wanted) ? wanted! : this.server.defaultAgent || this.server.agents[0]?.id || wanted || "";
      await this.loadConversation();
    } catch (e) {
      this.activated = false;
      this.renderLog();
      this.showError(null, e as Error);
    }
    this.renderSubtitle();
    this.emit("dewee:ready", { agent: this.agentId, config: this.server });
  }

  private async switchAgent(id: string) {
    if (id === this.agentId) return;
    this.stop();
    this.agentId = id;
    this.renderSubtitle();
    await this.loadConversation();
  }

  private async loadConversation() {
    const persist = this.config.persist !== false;
    const saved = persist ? store.get(this.convKey()) : null;
    this.conversationId = saved || randomConversationId();
    if (persist && !saved) store.set(this.convKey(), this.conversationId);
    this.messages = [];
    this.renderLog();
    if (!saved) return;
    try {
      const history = await this.client().history(this.agentId, this.conversationId);
      this.messages = history.map((m) => ({ ...m, status: "done" as const }));
      this.renderLog();
    } catch {
      /* history is a nicety: a fresh conversation still works */
    }
  }

  private renderLog() {
    const log = this.els.log;
    log.replaceChildren();
    if (!this.messages.length) log.appendChild(this.renderWelcome());
    for (const m of this.messages) log.appendChild(this.renderMessage(m));
    log.scrollTop = log.scrollHeight;
  }

  private renderWelcome(): HTMLElement {
    const c = this.config;
    const s = this.strings;
    const w = document.createElement("div");
    w.className = "welcome";
    const h = document.createElement("h2");
    h.textContent = c.greeting || s.greeting;
    const p = document.createElement("p");
    p.textContent = c.intro || s.greetingBody;
    w.append(h, p);
    if (c.suggestions?.length) {
      const list = document.createElement("div");
      list.className = "suggestions";
      for (const text of c.suggestions) {
        const b = document.createElement("button");
        b.className = "chip";
        b.type = "button";
        b.textContent = text;
        b.addEventListener("click", () => this.send(text));
        list.appendChild(b);
      }
      w.appendChild(list);
    }
    return w;
  }

  private pushMessage(m: ViewMessage) {
    if (!this.messages.length) this.els.log.replaceChildren();
    this.messages.push(m);
    this.els.log.appendChild(this.renderMessage(m));
    this.scrollToBottom(true);
  }

  private renderMessage(m: ViewMessage): HTMLElement {
    const root = document.createElement("div");
    root.className = `msg ${m.role}${m.status === "error" ? " error" : ""}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    root.appendChild(bubble);
    const trace = document.createElement("div");
    trace.className = "trace";
    const md = document.createElement("div");
    md.className = m.role === "assistant" ? "md" : "";
    if (m.role === "assistant") bubble.appendChild(trace);
    bubble.appendChild(md);
    m.view = { root, trace, md, tools: new Map() };
    this.updateMessage(m);
    return root;
  }

  private updateMessage(m: ViewMessage) {
    const v = m.view;
    if (!v) return;
    const c = this.config;
    if (m.role === "user") {
      v.md.textContent = m.content;
      return;
    }
    v.root.classList.toggle("error", m.status === "error");

    // reasoning
    if (c.showReasoning !== false && m.thinking) {
      if (!v.thinking) {
        v.thinking = document.createElement("details");
        v.thinking.className = "thinking";
        v.thinking.innerHTML = `<summary></summary><div class="thinking-body"></div>`;
        v.trace.prepend(v.thinking);
      }
      const streaming = m.status === "streaming" && !m.thinkingMs;
      const label = streaming ? this.strings.thinking : m.thinkingMs ? this.strings.thoughtFor(Math.max(1, Math.round(m.thinkingMs / 1000))) : this.strings.reasoning;
      const summary = v.thinking.querySelector("summary")!;
      summary.innerHTML = `${streaming ? '<span class="spin"></span>' : icons.brain}<span></span>${icons.down.replace("<svg", '<svg class="chev"')}`;
      summary.querySelector("span:not(.spin)")!.textContent = label;
      v.thinking.querySelector(".thinking-body")!.textContent = m.thinking;
    } else if (v.thinking) {
      v.thinking.remove();
      v.thinking = undefined;
    }

    // tools
    if (c.showToolCalls !== false) {
      for (const t of m.toolCalls ?? []) this.renderTool(v, t);
    } else {
      v.tools.forEach((d) => d.remove());
      v.tools.clear();
    }
    v.trace.hidden = !v.trace.childElementCount;

    // content
    const typing = m.status === "streaming" && !m.content;
    if (typing) {
      v.md.innerHTML = `<span class="typing" aria-label="${this.strings.thinking}"><i></i><i></i><i></i></span>`;
    } else {
      v.md.replaceChildren(renderMarkdown(document, m.content));
      v.md.classList.toggle("cursor", m.status === "streaming");
    }
  }

  private renderTool(v: ViewRefs, t: ToolCallView) {
    let d = v.tools.get(t.id);
    if (!d) {
      d = document.createElement("details");
      d.className = "tool";
      d.innerHTML = `<summary><span class="lead"></span><span class="tool-name"></span><span class="tool-state"></span>${icons.down.replace("<svg", '<svg class="chev"')}</summary><div class="tool-body"></div>`;
      v.tools.set(t.id, d);
      v.trace.appendChild(d);
    }
    d.dataset.status = t.status;
    d.querySelector(".lead")!.innerHTML = t.status === "running" ? '<span class="spin"></span>' : icons.tool;
    const name = d.querySelector(".tool-name")!;
    name.textContent = prettyToolName(t.name);
    name.setAttribute("title", t.name);
    d.querySelector(".tool-state")!.textContent =
      t.status === "running" ? this.strings.toolRunning : t.status === "error" ? this.strings.toolError : this.strings.toolDone;
    const body = d.querySelector(".tool-body")!;
    body.replaceChildren();
    const block = (label: string, value: unknown) => {
      if (value === undefined || value === null || value === "") return;
      const l = document.createElement("div");
      l.className = "label";
      l.textContent = label;
      const pre = document.createElement("pre");
      pre.textContent = typeof value === "string" ? tryPretty(value) : JSON.stringify(value, null, 2);
      body.append(l, pre);
    };
    block(this.strings.args, t.arguments);
    block(this.strings.result, t.result);
  }

  private onStreamEvent(m: ViewMessage, e: ChatStreamEvent) {
    switch (e.type) {
      case "start":
        if (e.conversationId && e.conversationId !== this.conversationId) {
          this.conversationId = e.conversationId;
          if (this.config.persist !== false) store.set(this.convKey(), e.conversationId);
        }
        break;
      case "thinking":
        m.thinking = (m.thinking || "") + e.text;
        break;
      case "delta":
        this.finishThinking(m);
        m.content += e.text;
        break;
      case "tool_call":
        this.finishThinking(m);
        (m.toolCalls ??= []).push({ id: e.id, name: e.name, arguments: e.arguments, status: "running" });
        break;
      case "tool_result": {
        const t = m.toolCalls?.find((x) => x.id === e.id) ?? (m.toolCalls ??= [])[m.toolCalls.push({ id: e.id, name: e.name, status: "running" }) - 1];
        t.status = e.isError ? "error" : "done";
        t.result = e.result;
        t.isError = e.isError;
        break;
      }
      case "done":
        this.finishThinking(m);
        if (e.content && e.content.length >= m.content.length) m.content = e.content;
        m.status = "done";
        break;
      case "error":
        m.status = "error";
        this.showError(m, new ApiError(e.message, 500, e.code));
        break;
    }
    this.scheduleUpdate(m);
  }

  private pendingFrame = 0;
  private following = true;
  private scheduleUpdate(m: ViewMessage) {
    if (this.pendingFrame) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = 0;
      this.updateMessage(m);
      if (this.following) this.scrollToBottom(true);
    });
  }

  private finishThinking(m: ViewMessage) {
    if (m.thinking && !m.thinkingMs && m.startedAt) m.thinkingMs = Date.now() - m.startedAt;
  }

  private nearBottom() {
    const l = this.els.log;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 96;
  }

  private scrollToBottom(force = false) {
    const l = this.els.log;
    if (force || this.nearBottom()) {
      l.scrollTop = l.scrollHeight;
      this.following = true;
    }
  }

  private showError(m: ViewMessage | null, err: Error) {
    const text = err.message || this.strings.errorGeneric;
    this.emit("dewee:error", { message: text, code: (err as ApiError).code });
    if (m) {
      m.content = m.content ? `${m.content}\n\n> ⚠️ ${text}` : `⚠️ ${text}`;
      m.status = "error";
      this.updateMessage(m);
      return;
    }
    const div = document.createElement("div");
    div.className = "msg error";
    div.innerHTML = `<div class="bubble"></div>`;
    div.firstElementChild!.textContent = `⚠️ ${text}`;
    this.els.log.appendChild(div);
  }

  /** Renders a Turnstile challenge in light DOM (slotted) and resolves with its token. */
  private async challenge(siteKey: string): Promise<string> {
    await loadTurnstile();
    const holder = document.createElement("div");
    holder.slot = "challenge";
    this.appendChild(holder);
    try {
      return await new Promise<string>((resolve, reject) => {
        (window as any).turnstile.render(holder, {
          sitekey: siteKey,
          appearance: "interaction-only",
          theme: this.getAttribute("data-theme") === "dark" ? "dark" : "light",
          callback: resolve,
          "error-callback": () => reject(new ApiError("Verification failed", 403, "turnstile_failed")),
        });
      });
    } finally {
      holder.remove();
    }
  }
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s); } catch { return fallback; }
}

function tryPretty(s: string): string {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return s;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return s; }
}

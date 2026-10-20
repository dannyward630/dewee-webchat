// Browser client for the dewee-webchat backend HTTP contract.
import {
  HEADER_GATEWAY_TOKEN,
  HEADER_GATEWAY_URL,
  type ChatRequestBody,
  type ChatStreamEvent,
  type HistoryMessage,
  type PublicConfig,
  type SessionResponse,
} from "../protocol";

export interface ApiClientOptions {
  /** Backend base URL, e.g. "/api/dewee" or "https://example.com/api/dewee". */
  endpoint: string;
  /** Bring-your-own gateway credentials (only if the backend allows it). */
  gatewayUrl?: string;
  gatewayToken?: string;
  /** Called when the backend requires a Turnstile challenge; must resolve to a token. */
  turnstile?: (siteKey: string) => Promise<string>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

export class ApiClient {
  private session: SessionResponse | null = null;
  private config: PublicConfig | null = null;
  private sessionPromise: Promise<SessionResponse> | null = null;

  constructor(private o: ApiClientOptions) {}

  private url(action: string, qs?: Record<string, string>): string {
    const base = this.o.endpoint.replace(/\/+$/, "");
    const q = qs ? "?" + new URLSearchParams(qs).toString() : "";
    return `${base}/${action}${q}`;
  }

  private get storageKey(): string {
    return `dewee-webchat:session:${this.o.endpoint}`;
  }

  private headers(auth = false): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.o.gatewayUrl && this.o.gatewayToken) {
      h[HEADER_GATEWAY_URL] = this.o.gatewayUrl;
      h[HEADER_GATEWAY_TOKEN] = this.o.gatewayToken;
    }
    if (auth && this.session) h.authorization = `Bearer ${this.session.token}`;
    return h;
  }

  private async parse<T>(res: Response): Promise<T> {
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body?.error?.message || `HTTP ${res.status}`, res.status, body?.error?.code);
    return body as T;
  }

  async getConfig(force = false): Promise<PublicConfig> {
    if (this.config && !force) return this.config;
    this.config = await this.parse<PublicConfig>(await fetch(this.url("config"), { headers: this.headers() }));
    return this.config;
  }

  /** Returns a valid visitor session, creating or refreshing it when needed. */
  ensureSession(): Promise<SessionResponse> {
    if (this.session && this.session.expiresAt - Date.now() > 86_400_000) return Promise.resolve(this.session);
    if (!this.session) {
      const saved = store.get(this.storageKey);
      if (saved) {
        try {
          const s = JSON.parse(saved) as SessionResponse;
          if (s.expiresAt - Date.now() > 86_400_000) return Promise.resolve((this.session = s));
          this.session = s; // close to expiry: refresh below, keeping the same visitor id
        } catch { /* corrupted entry */ }
      }
    }
    return (this.sessionPromise ??= this.createSession().finally(() => (this.sessionPromise = null)));
  }

  private async createSession(): Promise<SessionResponse> {
    const cfg = await this.getConfig();
    const body: Record<string, string> = {};
    if (this.session?.token) body.token = this.session.token;
    if (cfg.turnstileSiteKey) {
      if (!this.o.turnstile) throw new ApiError("Verification is required but no Turnstile handler is set", 403, "turnstile_required");
      body.turnstileToken = await this.o.turnstile(cfg.turnstileSiteKey);
    }
    const s = await this.parse<SessionResponse>(
      await fetch(this.url("session"), { method: "POST", headers: this.headers(), body: JSON.stringify(body) }),
    );
    this.session = s;
    store.set(this.storageKey, JSON.stringify(s));
    return s;
  }

  forgetSession(): void {
    this.session = null;
    store.del(this.storageKey);
  }

  async history(agent: string, conversationId: string): Promise<HistoryMessage[]> {
    await this.ensureSession();
    const res = await fetch(this.url("history", { agent, conversationId }), { headers: this.headers(true) });
    return (await this.parse<{ messages: HistoryMessage[] }>(res)).messages;
  }

  /** Sends a message and calls `onEvent` for every streamed event. Resolves when the run ends. */
  async chat(
    input: ChatRequestBody & { agent: string; conversationId: string },
    onEvent: (e: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureSession();
    let res = await fetch(this.url("chat"), { method: "POST", headers: this.headers(true), body: JSON.stringify(input), signal });
    if (res.status === 401) {
      this.forgetSession();
      await this.ensureSession();
      res = await fetch(this.url("chat"), { method: "POST", headers: this.headers(true), body: JSON.stringify(input), signal });
    }
    if (!res.ok || !res.body) await this.parse(res);

    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try { onEvent(JSON.parse(data) as ChatStreamEvent); } catch { /* malformed frame */ }
      }
    }
  }
}

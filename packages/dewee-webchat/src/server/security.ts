// Visitor tokens (HMAC-SHA256 via WebCrypto) and a small in-memory rate limiter.

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, k);
  }
  return k;
}

export interface VisitorClaims {
  /** Visitor id (random, 22 chars; derived from the principal for a signed-in user). */
  v: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Signed-in users only: the Dewee identity session token (one agent, chat only, short-lived). */
  ids?: string;
  /** Signed-in users only: the agent the identity session is bound to. */
  ida?: string;
}

/** Longest identity session token the gateway issues (matches the `@dewee/identity` limit). */
const MAX_IDENTITY_SESSION_LENGTH = 512;
const AGENT_CLAIM_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export async function signVisitorToken(secret: string, claims: VisitorClaims): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifyVisitorToken(secret: string, token: string): Promise<VisitorClaims | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as VisitorClaims;
    if (typeof claims.v !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(claims.v)) return null;
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    // An identity claim is all or nothing: a session token always travels with the agent it is bound to.
    if (claims.ids !== undefined || claims.ida !== undefined) {
      if (typeof claims.ids !== "string" || claims.ids === "" || claims.ids.length > MAX_IDENTITY_SESSION_LENGTH) return null;
      if (typeof claims.ida !== "string" || !AGENT_CLAIM_RE.test(claims.ida)) return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/**
 * Stable visitor id for a label (e.g. a Dewee principal id): HMAC(secret, label), 22 base64url chars.
 * A signed-in user keeps the same conversations on every device and page load without the id being guessable.
 */
export async function deriveVisitorId(secret: string, label: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`dewee-webchat:visitor:${label}`)));
  return b64url(mac.slice(0, 16));
}

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Returns true when the key may proceed. Implementations may be async (KV, DO, Redis…). */
export type RateLimiter = (key: string, bucket: "session" | "chat") => boolean | Promise<boolean>;

/**
 * Fixed-window in-memory limiter. Good enough for a single Node process; on serverless
 * runtimes each isolate keeps its own counters, so pass a shared limiter for hard limits.
 */
export function memoryRateLimiter(limits: { chat: [number, number]; session: [number, number] }): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return (key, bucket) => {
    const [max, windowMs] = limits[bucket];
    const id = `${bucket}:${key}`;
    const now = Date.now();
    const w = windows.get(id);
    if (!w || now - w.start >= windowMs) {
      windows.set(id, { start: now, count: 1 });
      if (windows.size > 10000) {
        for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
      }
      return true;
    }
    w.count++;
    return w.count <= max;
  };
}

export async function verifyTurnstile(secret: string, response: string, ip?: string): Promise<boolean> {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", response);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data: any = await res.json().catch(() => ({}));
  return data.success === true;
}

// Gateway admission refusals of `chat.send` (POLICY_DENIED, RATE_LIMITED, reserved CHALLENGE_REQUIRED)
// as typed errors for the browser. Keep in sync with admissionErrorEvent() in php/dewee-webchat.php.
import type { AdmissionErrorCode, ChatStreamEvent } from "../protocol";

/**
 * Fallback text per code. The gateway's own message is never forwarded, so no gateway or admin detail
 * reaches the browser; the widget shows its own localized copy for each code.
 */
const MESSAGES: Record<AdmissionErrorCode, string> = {
  POLICY_DENIED: "This message can't be sent.",
  RATE_LIMITED: "Too many messages, please wait a moment.",
  // Reserved for the gateway challenge protocol: no challenge context is defined or forwarded yet.
  CHALLENGE_REQUIRED: "Verification is required to continue.",
};

/** HTTP status of each code when the refusal happens before streaming starts. */
const STATUS: Record<AdmissionErrorCode, number> = { POLICY_DENIED: 403, RATE_LIMITED: 429, CHALLENGE_REQUIRED: 403 };

/** Cooldown when a `RATE_LIMITED` refusal carries no usable `retryAfterMs`. */
export const DEFAULT_RETRY_AFTER_MS = 5_000;
/** Upper bound of the cooldown passed to the browser, so a bogus value cannot lock the widget for long. */
export const MAX_RETRY_AFTER_MS = 600_000;

/** A positive whole number of milliseconds, defaulted and capped. */
export function normalizeRetryAfterMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.ceil(n), MAX_RETRY_AFTER_MS);
}

export type AdmissionErrorEvent = Extract<ChatStreamEvent, { type: "error" }>;

/** The SSE `error` event of an admission refusal. Only `RATE_LIMITED` carries `retryAfterMs`. */
export function admissionErrorEvent(code: AdmissionErrorCode, retryAfterMs?: unknown): AdmissionErrorEvent {
  return code === "RATE_LIMITED"
    ? { type: "error", message: MESSAGES[code], code, retryAfterMs: normalizeRetryAfterMs(retryAfterMs) }
    : { type: "error", message: MESSAGES[code], code };
}

/** Status, JSON body and headers of an admission refusal answered before streaming starts. */
export function admissionErrorResponse(code: AdmissionErrorCode, retryAfterMs?: unknown): {
  status: number;
  body: { error: { message: string; code: string; retryAfterMs?: number } };
  headers: Record<string, string>;
} {
  const { type: _type, ...error } = admissionErrorEvent(code, retryAfterMs);
  const headers: Record<string, string> = error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) } : {};
  return { status: STATUS[code], body: { error: error as { message: string; code: string; retryAfterMs?: number } }, headers };
}

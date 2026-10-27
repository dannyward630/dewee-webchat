// Browser-facing identity error table, shared by both transports so every backend answers the same
// typed errors (docs/http-contract.md, "Identity errors").
import type { IdentityErrorCode } from "../protocol";

/** HTTP status and fallback text of each identity error. The widget shows its own localized copy. */
export const IDENTITY_ERRORS: Record<IdentityErrorCode, { status: number; message: string; action: string }> = {
  IDENTITY_REQUIRED: { status: 401, message: "Sign in to continue.", action: "reauthenticate" },
  LINK_EXPIRED: { status: 401, message: "Your session expired.", action: "reauthenticate" },
  LINK_REVOKED: { status: 401, message: "Your access was revoked.", action: "reauthenticate" },
  IDENTITY_LINK_REQUIRED: { status: 403, message: "Link your account to continue.", action: "send_connect_link" },
  PERMISSION_DENIED: { status: 403, message: "You are not allowed to do this.", action: "contact_admin" },
  IDENTITY_CONFLICT: { status: 409, message: "This account is linked to another user.", action: "contact_admin" },
  SOURCE_UNAVAILABLE: { status: 503, message: "Your sign-in could not be checked. Try again later.", action: "retry_later" },
};

/** Identity errors after which a cached identity session is dropped. */
export const DEAD_SESSION_CODES = new Set(["IDENTITY_REQUIRED", "LINK_EXPIRED", "LINK_REVOKED"]);

// Startup choice between the "ccp" and "legacy-gateway" transports. Kept apart from the handler so
// the rule is easy to audit: one transport's credentials at a time, never a silent pick.
import type { DeweeHandlerOptions, DeweeTransport } from "./handler";

let legacyWarned = false;

/**
 * Picks the transport once, at startup. An explicit `transport` must match the options given; without
 * one, the options decide. Gateway and CCP options together are refused instead of guessed.
 */
export function resolveTransport(o: DeweeHandlerOptions): DeweeTransport {
  const refuse = (why: string): never => {
    throw new Error(`[dewee-webchat] ${why}`);
  };
  if (o.transport !== undefined && o.transport !== "ccp" && o.transport !== "legacy-gateway") refuse(`transport must be "ccp" or "legacy-gateway"`);
  const hasCcp = o.ccp !== undefined && o.ccp !== null && Object.values(o.ccp).some((v) => v !== undefined && v !== "");
  const gatewayOptions = (["gatewayUrl", "token", "tenantId"] as const).filter((k) => o[k] !== undefined && o[k] !== "");
  const transport: DeweeTransport = o.transport ?? (hasCcp ? "ccp" : "legacy-gateway");
  if (transport === "ccp") {
    if (!hasCcp) refuse('transport "ccp" needs ccp options (DEWEE_CCP_CHAT_URL, DEWEE_WEBCHAT_INTEGRATION_ID, DEWEE_WEBCHAT_INTEGRATION_SECRET)');
    if (gatewayOptions.length) {
      refuse(`both CCP and gateway options are set (${gatewayOptions.join(", ")}); remove the gateway ones (DEWEE_GATEWAY_URL, DEWEE_GATEWAY_TOKEN, DEWEE_TENANT_ID), or set transport "legacy-gateway" and remove the CCP ones`);
    }
    if (o.allowClientCredentials) refuse("allowClientCredentials does not apply to the ccp transport");
    if (o.agents !== undefined && !(Array.isArray(o.agents) && o.agents.length === 0)) refuse("agents does not apply to the ccp transport: choose the agents on the CCP Website chat page");
    if (o.defaultAgent) refuse("defaultAgent does not apply to the ccp transport: choose the default agent on the CCP Website chat page");
    if (!o.secret || new TextEncoder().encode(o.secret).length < 32) refuse("the ccp transport needs secret (DEWEE_WEBCHAT_SECRET), at least 32 bytes");
    return transport;
  }
  if (hasCcp) refuse('transport "legacy-gateway" is set together with ccp options; remove one of them');
  if (!legacyWarned) {
    legacyWarned = true;
    console.warn(
      '[dewee-webchat] transport "legacy-gateway" (a direct Gateway URL and token) is deprecated. Create a Website chat integration in CCP and switch to transport "ccp": https://github.com/nextlevelbuilder/dewee-webchat/blob/main/docs/migrating-to-ccp-transport.md',
    );
  }
  return transport;
}

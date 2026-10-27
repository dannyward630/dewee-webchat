# Migrating from a direct Gateway to a CCP Website chat integration

Until now the website backend connected straight to a Dewee Gateway over WebSocket with a Gateway
URL and an operator token (`transport: "legacy-gateway"`). That token can run any agent of the
tenant, so a leaked website config was a tenant-wide incident. The `ccp` transport replaces it with a
**Website chat integration** created in CCP (the Dewee control plane): a credential that can only
serve that one website chat, with its agents, allowed sites, sign-in mode and limits set in CCP.

The browser side does not change. The widget still talks only to your `/api/dewee/*` backend, and
the [HTTP contract](http-contract.md) is the same with both transports.

```
before:  browser ──▶ your backend ──WebSocket + gateway token──▶ Dewee Gateway
after:   browser ──▶ your backend ──HTTPS + SSE + integration secret──▶ CCP ingress ──▶ runtime
```

## 1. Create the integration in CCP

In CCP, open **Website chat** and create an integration (or run `dewee webchat-integrations create`):

1. **Agents**: the agents visitors may use, and the default one. With more than one, the widget
   shows its agent picker. This replaces `DEWEE_AGENTS` and `DEWEE_DEFAULT_AGENT`.
2. **Allowed sites**: the origins your pages are served from (for example `https://shop.example.com`).
   The backend forwards the visitor's `Origin`; CCP refuses other sites.
3. **Sign-in mode**: anonymous, signed-in optional or signed-in required. Signed-in modes need an
   identity application (see [Signed-in users](../packages/dewee-webchat/README.md#signed-in-users)).
4. **Reasoning and tool activity**: hidden unless you turn them on. Tool arguments and results are
   never sent to the browser.
5. Save. CCP shows the **integration secret once** (`dwc_…`), with the chat URL and integration id.

## 2. Change the backend configuration

| Before (legacy-gateway) | After (ccp) |
|---|---|
| `DEWEE_GATEWAY_URL` | remove; set `DEWEE_CCP_CHAT_URL` (`https://<ccp>/api/public/webchat/v1/wci_…`) |
| `DEWEE_GATEWAY_TOKEN` | remove; set `DEWEE_WEBCHAT_INTEGRATION_SECRET` (`dwc_…`, a secret) |
| `DEWEE_TENANT_ID` | remove (the integration belongs to one workspace) |
| `DEWEE_AGENTS`, `DEWEE_DEFAULT_AGENT` | remove; agents are chosen in CCP |
| `DEWEE_ALLOW_CLIENT_CREDENTIALS`, `DEWEE_CLIENT_CREDENTIAL_HOSTS` | remove; "bring your own gateway" exists only in legacy-gateway |
| (none) | add `DEWEE_WEBCHAT_INTEGRATION_ID` (`wci_…`) |
| `DEWEE_WEBCHAT_SECRET` | keep; at least 32 bytes is now required |
| `DEWEE_ALLOWED_ORIGINS`, `TURNSTILE_*`, `DEWEE_IDENTITY_*` | keep |

Optionally set `DEWEE_WEBCHAT_TRANSPORT=ccp` to make the choice explicit. In code:

```ts
createDeweeHandler({
  transport: "ccp",
  ccp: { chatUrl: process.env.DEWEE_CCP_CHAT_URL!, integrationId: process.env.DEWEE_WEBCHAT_INTEGRATION_ID!, integrationSecret: process.env.DEWEE_WEBCHAT_INTEGRATION_SECRET! },
  secret: process.env.DEWEE_WEBCHAT_SECRET!,
});
```

`optionsFromEnv(env)` reads all of these, so most sites only change their variables. On Cloudflare,
put the secret in `wrangler secret put DEWEE_WEBCHAT_INTEGRATION_SECRET` and the URL and id in
`vars`; delete the old gateway vars and the `DEWEE_GATEWAY_TOKEN` secret.

The handler refuses to start (Node) or answers `500 not_configured` and logs why (PHP) when:

- CCP and gateway settings are both present, or `transport` names one transport and the other's
  settings are set. It never guesses which origin should receive a credential.
- `DEWEE_CCP_CHAT_URL` is not https (plain http is allowed only to `localhost`), carries credentials,
  a query or a fragment, or does not end with the integration id.
- `agents`, `defaultAgent` or `allowClientCredentials` are set together with `ccp`.

## 3. What behaves differently

- **Agents.** `/config` lists the integration's agents. The `agent` a widget sends is forwarded and
  CCP decides; an agent outside the integration is `403 agent_not_allowed`.
- **Reasoning and tool calls** are hidden unless the integration shows them, whatever the widget's
  `showReasoning` / `showToolCalls` say. Tool calls show names only.
- **Errors** keep the browser contract's codes. A wrong, rotated-out or revoked integration secret is
  `500 not_configured` (the reason is in your server log), a disabled integration `503 unavailable`,
  a refused message `429 RATE_LIMITED` with `retryAfterMs` (or `POLICY_DENIED`), the same admission
  errors as the legacy gateway, so the widget shows its cooldown. CCP's messages are never forwarded.
- **History.** Conversations are stored per integration visitor at CCP. Conversations made through
  the legacy gateway do not appear after the switch; visitors keep their visitor id, but start a new
  history.
- **Conversation ids** shorter than 8 characters are replaced with a new id (CCP needs 8 to 64).
- **Signed-in users** (Node handler) work through CCP: the handler signs the partner assertion and
  CCP exchanges it, so `DEWEE_GATEWAY_TOKEN` is no longer needed for them either. The PHP backend has
  no signed-in mode with either transport.
- **Your own limits stay.** Turnstile, the per-visitor and per-IP rate limits, the message length
  cap and the origin check still run in your backend, before CCP is called.

## 4. Rotating the secret

Rotate in CCP (or `dewee webchat-integrations rotate <id>`). The previous secret keeps working for
the overlap you choose (24 hours by default), so deploy the new `DEWEE_WEBCHAT_INTEGRATION_SECRET`
within it. With no overlap the old secret fails at once.

## 5. Rolling back

The legacy transport is still in the package (deprecated; it logs one warning per process, and the
PHP backend at most once a day). To go back:

1. Remove `DEWEE_CCP_CHAT_URL`, `DEWEE_WEBCHAT_INTEGRATION_ID` and `DEWEE_WEBCHAT_INTEGRATION_SECRET`.
2. Restore `DEWEE_GATEWAY_URL`, `DEWEE_GATEWAY_TOKEN` and `DEWEE_AGENTS` (plus the optional ones you had).
3. Optionally set `DEWEE_WEBCHAT_TRANSPORT=legacy-gateway`.

Visitor tokens stay valid across the switch in both directions (the edge session they carry is
ignored by the legacy transport and replaced when needed by the ccp one).

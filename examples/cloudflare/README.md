# webchat.dewee.sh — playground (Cloudflare Workers)

The public playground and docs page for `dewee-webchat`. One Worker serves the static page from
`public/` and the widget backend on `/api/dewee/*`.

- `src/worker.ts` — routes `/api/dewee/*` to `createDeweeHandler(optionsFromEnv(env))`, using
  Workers rate limiting bindings (`CHAT_LIMITER`, `SESSION_LIMITER`) shared across isolates.
- `public/app.js` — playground controls → `element.configure()` → generated embed code. The
  generated server code uses the CCP Website chat variables.
- `wrangler.jsonc` — vars and the custom domain.

## Transport

This Worker is the one example that stays on `transport: "legacy-gateway"` (deprecated): its
"Use your own gateway" panel needs `DEWEE_ALLOW_CLIENT_CREDENTIALS=true`, which only the direct
Gateway transport supports. Keep that switch off on a real site, and use a CCP Website chat
integration instead (see the other examples and
[docs/migrating-to-ccp-transport.md](../../docs/migrating-to-ccp-transport.md)).

## Run

```bash
cp .dev.vars.example .dev.vars   # fill DEWEE_GATEWAY_TOKEN and DEWEE_WEBCHAT_SECRET
pnpm dev                          # http://localhost:8788
```

## Deploy

```bash
wrangler secret put DEWEE_GATEWAY_TOKEN
wrangler secret put DEWEE_WEBCHAT_SECRET
pnpm deploy
```

Outside this monorepo, replace `"dewee-webchat": "workspace:*"` with a published version.

# webchat.dewee.sh — playground (Cloudflare Workers)

The public playground and docs page for `dewee-webchat`. One Worker serves the static page from
`public/` and the widget backend on `/api/dewee/*`.

- `src/worker.ts` — routes `/api/dewee/*` to `createDeweeHandler(optionsFromEnv(env))`, using
  Workers rate limiting bindings (`CHAT_LIMITER`, `SESSION_LIMITER`) shared across isolates.
- `public/app.js` — playground controls → `element.configure()` → generated embed code.
- `wrangler.jsonc` — vars (`DEWEE_GATEWAY_URL`, `DEWEE_AGENTS`, …) and the custom domain.

`DEWEE_ALLOW_CLIENT_CREDENTIALS=true` lets visitors try their own gateway from the playground. Keep it
off on a real site.

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

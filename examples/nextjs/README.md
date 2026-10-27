# Next.js + dewee-webchat (Cloudflare Workers)

A Next.js App Router app with a floating Dewee chat widget, deployed to Cloudflare Workers with
[OpenNext](https://opennext.js.org/cloudflare). Live at <https://webchat-next.dewee.sh>.

- `app/api/dewee/[...path]/route.ts`: one `createDeweeHandler()` instance serving `GET`, `POST` and
  `OPTIONS` for `/api/dewee/{config,session,chat,history}`. Chat replies stream as SSE. The integration
  secret stays on the server.
- `app/chat-widget.tsx`: client component that renders `<DeweeChat>` from `dewee-webchat/react`.
- `app/page.tsx`: landing page.

The route handler reads its settings from the Workers env through `getCloudflareContext()`, with
`process.env` as a fallback. `initOpenNextCloudflareForDev()` in `next.config.ts` makes the same values
available under `next dev`.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `DEWEE_CCP_CHAT_URL` | `wrangler.jsonc` vars | CCP ingress URL from the CCP Website chat page |
| `DEWEE_WEBCHAT_INTEGRATION_ID` | `wrangler.jsonc` vars | `wci_…` integration id |
| `DEWEE_WEBCHAT_INTEGRATION_SECRET` | secret | `dwc_…` integration secret, server only |
| `DEWEE_WEBCHAT_SECRET` | secret | HMAC secret for visitor sessions (at least 32 random characters) |
| `DEWEE_ALLOWED_ORIGINS` | optional var | Other sites allowed to call this backend |

With a CCP Website chat integration (recommended) the agents, sign-in mode, limits and whether
reasoning and tool activity are shown are set in CCP, not here. The hosted demo still runs the
deprecated `legacy-gateway` transport; switch with the comment in `wrangler.jsonc` and
[docs/migrating-to-ccp-transport.md](../../docs/migrating-to-ccp-transport.md). The two transports'
variables cannot be mixed: the handler refuses to start instead of guessing.

Deprecated `legacy-gateway` transport (`DEWEE_WEBCHAT_TRANSPORT=legacy-gateway`):

| Variable | Where | Purpose |
|---|---|---|
| `DEWEE_GATEWAY_URL` | `wrangler.jsonc` vars | Gateway origin |
| `DEWEE_AGENTS` | `wrangler.jsonc` vars | Comma-separated allowlist of agent ids (first is the default) |
| `DEWEE_DEFAULT_AGENT` | `wrangler.jsonc` vars | Default agent |
| `DEWEE_GATEWAY_TOKEN` | secret | Gateway token or operator API key |

Locally, secrets go in `.dev.vars` (copy `.dev.vars.example`). Avoid `.env` files on Cloudflare (see
below). `.env.example` is only for hosting on plain Node with `next build && next start`.

## Develop

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in the secrets
pnpm dev                         # http://localhost:3000
pnpm preview                     # build the Worker and run it locally in workerd
```

## Deploy

1. Edit `wrangler.jsonc`: set `name` and `account_id`, and change or remove `routes` (custom domain)
   and `vars`.
2. Set the secrets once:

   ```sh
   pnpm wrangler secret put DEWEE_WEBCHAT_INTEGRATION_SECRET   # legacy-gateway: DEWEE_GATEWAY_TOKEN
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | pnpm wrangler secret put DEWEE_WEBCHAT_SECRET
   ```

3. Run `pnpm run deploy`. This runs `opennextjs-cloudflare build`, the two post-build steps below, and
   then `opennextjs-cloudflare deploy`.

### Post-build steps (`pnpm build:worker`)

- `scripts/strip-open-next-env.mjs`: OpenNext compiles every `.env*` file from the app and from a
  monorepo root into the Worker bundle. This step clears them, so that unrelated secrets cannot ship.
  Configure the Worker with `vars` and secrets instead.
- `scripts/patch-open-next-preview-props.mjs`: Next.js 16.4 loads `.next/server/preview-props.json`,
  which `@opennextjs/cloudflare` 1.20.10 does not inline yet
  ([opennextjs-cloudflare#1355](https://github.com/opennextjs/opennextjs-cloudflare/issues/1355)).
  The step adds the missing branch to the bundle, and it does nothing once OpenNext handles the file.
  Remove it after upgrading.

## Using this outside the monorepo

Replace `"dewee-webchat": "workspace:*"` in `package.json` with a published version, for example
`"dewee-webchat": "^0.1.0"`.

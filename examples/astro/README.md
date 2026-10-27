# Astro + dewee-webchat (Cloudflare Workers)

Live: https://webchat-astro.dewee.sh

An Astro site on Cloudflare Workers (`@astrojs/cloudflare`) with the Dewee chat widget:

- `src/pages/api/dewee/[...path].ts` is an on-demand catch-all route that hands every request to
  `createDeweeHandler(optionsFromEnv(env))` from `dewee-webchat/server`. The integration secret stays in
  the Worker; the browser only gets short-lived visitor tokens. Chat replies stream as SSE.
- `src/pages/index.astro` is a prerendered page that renders `<DeweeChat endpoint="/api/dewee" />`
  from `dewee-webchat/astro` in floating mode.

## Environment

Read with `import { env } from "cloudflare:workers"` (works in `astro dev`, `astro preview` and production).

| Name | Where | Notes |
|------|-------|-------|
| `DEWEE_CCP_CHAT_URL` | `wrangler.jsonc` `vars` | CCP ingress URL from the CCP Website chat page |
| `DEWEE_WEBCHAT_INTEGRATION_ID` | `wrangler.jsonc` `vars` | `wci_…` integration id |
| `DEWEE_WEBCHAT_INTEGRATION_SECRET` | secret | `dwc_…` integration secret, server only |
| `DEWEE_WEBCHAT_SECRET` | secret | >= 32 random chars, signs visitor tokens |

With a CCP Website chat integration (recommended) the agents, sign-in mode, limits and whether
reasoning and tool activity are shown are set in CCP, not here. The hosted demo still runs the
deprecated `legacy-gateway` transport; switch with the comment in `wrangler.jsonc` and
[docs/migrating-to-ccp-transport.md](../../docs/migrating-to-ccp-transport.md). The two transports'
variables cannot be mixed: the handler refuses to start instead of guessing.

Deprecated `legacy-gateway` transport (`DEWEE_WEBCHAT_TRANSPORT=legacy-gateway`):

| Name | Where | Notes |
|------|-------|-------|
| `DEWEE_GATEWAY_URL` | `wrangler.jsonc` `vars` | Gateway origin |
| `DEWEE_AGENTS` | `wrangler.jsonc` `vars` | Comma-separated agent keys; the first is the default |
| `DEWEE_DEFAULT_AGENT` | `wrangler.jsonc` `vars` | Optional |
| `DEWEE_GATEWAY_TOKEN` | secret | Gateway token or scoped operator key |

All options read by `optionsFromEnv` are listed in the package README.

## Develop

```sh
cp .dev.vars.example .dev.vars   # fill in the secrets
pnpm install
pnpm dev                         # generates Worker types, then http://localhost:4321 (runs in workerd, reads .dev.vars)
pnpm preview                     # production build served by workerd
```

## Deploy

Edit `name`, `account_id` and `routes` in `wrangler.jsonc`, then:

```sh
pnpm exec wrangler secret put DEWEE_WEBCHAT_INTEGRATION_SECRET   # legacy-gateway: DEWEE_GATEWAY_TOKEN
pnpm exec wrangler secret put DEWEE_WEBCHAT_SECRET
pnpm run deploy                  # wrangler types, astro build, wrangler deploy
```

`pnpm typecheck` runs `wrangler types` (gitignored `worker-configuration.d.ts`) and `tsc`.
The config sets `session: false` and `imageService: "passthrough"`, so the adapter does not need a
`SESSION` KV namespace or an `IMAGES` binding.

## Copying this example

Outside this monorepo, replace `"dewee-webchat": "workspace:*"` in `package.json` with a published
version, e.g. `"dewee-webchat": "^0.1.0"`.

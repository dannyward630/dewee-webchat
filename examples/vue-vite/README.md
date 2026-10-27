# Vue (Vite) + dewee-webchat on Cloudflare Workers

Live: https://webchat-vue.dewee.sh

A Vue 3 single-page app that embeds a Dewee AI agent chat with the `DeweeChat` component from
`dewee-webchat/vue`. One Cloudflare Worker (built with [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/))
serves the page as static assets and runs the chat backend under `/api/dewee/*`, so the integration
secret never reaches the browser.

The page also demonstrates:

- **Live props:** the `showReasoning` / `showToolCalls` toggles and the `theme` select re-configure the widget at runtime.
- **The ref API:** buttons call `open()`, `send(text)` and `newConversation()` exposed by the component, through a template `ref`.
- **Events:** `@ready`, `@open`, `@close`, `@send`, `@reply` and `@error` update the "Last event" line.

| File | Purpose |
|------|---------|
| `worker/index.ts` | Sends `/api/dewee/*` to `createDeweeHandler(optionsFromEnv(env))` and everything else to `env.ASSETS` |
| `src/App.vue` | Landing page and `<DeweeChat />` |
| `wrangler.jsonc` | Worker name, custom domain, SPA assets (`run_worker_first: ["/api/*"]`) and public vars |

## Environment

Public settings live in `vars` in `wrangler.jsonc`, secrets stay out of the config:

| Variable | Where | Meaning |
|----------|-------|---------|
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

| Variable | Where | Meaning |
|----------|-------|---------|
| `DEWEE_GATEWAY_URL` | `wrangler.jsonc` `vars` | e.g. `https://dewee.zuey.me` |
| `DEWEE_AGENTS` | `wrangler.jsonc` `vars` | `dewee-web-advisor,zuey-ai` (comma-separated allowlist; the first is the default) |
| `DEWEE_DEFAULT_AGENT` | `wrangler.jsonc` `vars` | `dewee-web-advisor` |
| `DEWEE_GATEWAY_TOKEN` | secret | Gateway token or scoped operator API key |

`optionsFromEnv` reads other optional variables as well (`DEWEE_ALLOWED_ORIGINS`, `TURNSTILE_SITE_KEY`, …);
see the package README.

## Develop

```sh
cp .dev.vars.example .dev.vars   # then fill in the secrets
pnpm install
pnpm dev                         # http://localhost:5174, the Worker runs in workerd
```

`pnpm typecheck` runs `vue-tsc --noEmit`; `pnpm preview` builds and serves the production output locally.

## Deploy

Set your own `account_id`, route `pattern` and `vars` in `wrangler.jsonc`, then:

```sh
pnpm exec wrangler secret put DEWEE_WEBCHAT_INTEGRATION_SECRET   # legacy-gateway: DEWEE_GATEWAY_TOKEN
pnpm exec wrangler secret put DEWEE_WEBCHAT_SECRET
pnpm run deploy                  # vite build && wrangler deploy
```

Use `pnpm run deploy`, because `pnpm deploy` is a built-in pnpm command. `vite build` writes
`dist/dewee_webchat_vue/wrangler.json` along with a redirect file, so a plain `wrangler deploy` picks up the
built Worker and assets automatically.

## Copying this example out of the monorepo

`package.json` depends on `"dewee-webchat": "workspace:*"`. Replace that with a published version
(for example `"dewee-webchat": "^0.1.0"`) before installing it outside this repository.

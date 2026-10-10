# dewee-webchat

Embeddable chat for [Dewee](https://dewee.sh) agents. Drop one tag on any site and visitors talk to your
agent, with streamed reasoning, tool calls, markdown, history and agent switching. Your gateway token
stays on your server.

**▶ Playground:** [webchat.dewee.sh](https://webchat.dewee.sh) · **npm:** [`dewee-webchat`](https://www.npmjs.com/package/dewee-webchat) ·
**CDN:** `https://webchat-cdn.dewee.sh/dewee-webchat@0.1.0/dewee-webchat.js`

```
browser <dewee-chat>  ──HTTPS + SSE──▶  your backend /api/dewee/*  ──WebSocket──▶  Dewee gateway
   (visitor token only)                   (holds the gateway token)                (agents, MCP, tools)
```

## Quick start

```bash
npm i dewee-webchat
```

1. Mount the backend handler at `/api/dewee/*` (Workers, Next.js, Astro, Node, Bun, Deno, or the PHP file).
2. Set `DEWEE_GATEWAY_URL`, `DEWEE_GATEWAY_TOKEN`, `DEWEE_WEBCHAT_SECRET`, `DEWEE_AGENTS`. See [`.env.example`](.env.example).
3. Add the widget:

```html
<script src="https://webchat-cdn.dewee.sh/dewee-webchat@0.1.0/dewee-webchat.js" data-endpoint="/api/dewee" defer></script>
```

Full options, framework snippets and the security model: [packages/dewee-webchat/README.md](packages/dewee-webchat/README.md).

## Live examples

All of them run on Cloudflare and share the same scoped demo key.

| Stack | Live | Source |
|---|---|---|
| Plain HTML + Worker (playground) | [webchat.dewee.sh](https://webchat.dewee.sh) | [examples/cloudflare](examples/cloudflare) |
| Next.js (App Router, OpenNext) | [webchat-next.dewee.sh](https://webchat-next.dewee.sh) | [examples/nextjs](examples/nextjs) |
| Astro | [webchat-astro.dewee.sh](https://webchat-astro.dewee.sh) | [examples/astro](examples/astro) |
| React + Vite | [webchat-react.dewee.sh](https://webchat-react.dewee.sh) | [examples/react-vite](examples/react-vite) |
| Vue + Vite | [webchat-vue.dewee.sh](https://webchat-vue.dewee.sh) | [examples/vue-vite](examples/vue-vite) |
| Node + Express | local | [examples/node-express](examples/node-express) |
| PHP (no Composer) | local | [examples/php](examples/php) · [php/](php) |

## Repository layout

| Path | |
|---|---|
| [`packages/dewee-webchat`](packages/dewee-webchat) | The npm package: web component, React/Vue/Astro wrappers, `dewee-webchat/server` handler |
| [`php/dewee-webchat.php`](php) | Single-file PHP backend with the same HTTP contract |
| [`cdn/`](cdn) | Worker that serves versioned bundles at `webchat-cdn.dewee.sh` |
| [`docs/http-contract.md`](docs/http-contract.md) | Wire format between the widget and any backend |
| [`examples/`](examples) | Runnable integrations |

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # packages/dewee-webchat/dist
```

Run the playground locally: copy `examples/cloudflare/.dev.vars.example` to `.dev.vars`, fill it in, then
`pnpm -C examples/cloudflare dev`.

Release: bump `packages/dewee-webchat/package.json`, `npm publish` from that folder, then
`node cdn/scripts/build-cdn.mjs && pnpm -C examples/cloudflare exec wrangler deploy --config ../../cdn/wrangler.jsonc` to add the version to the CDN.

## License

[MIT](LICENSE)

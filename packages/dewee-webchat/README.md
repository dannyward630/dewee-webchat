# dewee-webchat

Put your [Dewee](https://dewee.sh) agent on any website. A dependency-free chat widget that streams the
agent's **reasoning** and **tool calls**, plus a small backend handler that keeps your gateway token
off the browser.

**Playground:** [webchat.dewee.sh](https://webchat.dewee.sh) · **CDN:** [webchat-cdn.dewee.sh](https://webchat-cdn.dewee.sh) ·
**Source & examples:** [github.com/nextlevelbuilder/dewee-webchat](https://github.com/nextlevelbuilder/dewee-webchat)

```
browser <dewee-chat>  ──HTTPS + SSE──▶  your backend /api/dewee/*  ──WebSocket──▶  Dewee gateway
   (visitor token only)                   (holds the gateway token)                (agents, MCP, tools)
```

## 1. Add the backend

The handler is a standard `(Request) => Promise<Response>`, so it runs on Cloudflare Workers, Next.js,
Astro, Bun, Deno and Node (via `toNodeHandler`).

```ts
// Next.js: app/api/dewee/[...path]/route.ts
import { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";

export const dynamic = "force-dynamic";
const handler = createDeweeHandler(optionsFromEnv(process.env));
export { handler as GET, handler as POST, handler as OPTIONS };
```

```ts
// Express
import { createDeweeHandler, optionsFromEnv, toNodeHandler } from "dewee-webchat/server";
app.all("/api/dewee/*path", toNodeHandler(createDeweeHandler(optionsFromEnv(process.env))));
```

```ts
// Cloudflare Workers
let dewee;
export default {
  fetch(req, env) {
    if (new URL(req.url).pathname.startsWith("/api/dewee/")) return (dewee ??= createDeweeHandler(optionsFromEnv(env)))(req);
    return env.ASSETS.fetch(req);
  },
};
```

PHP? Use the single-file backend in [`php/`](https://github.com/nextlevelbuilder/dewee-webchat/tree/main/php).

### Environment

| Variable | |
|---|---|
| `DEWEE_GATEWAY_URL` | Gateway runtime origin, e.g. `https://gateway.example.com` |
| `DEWEE_GATEWAY_TOKEN` | Operator API key (`operator.read,operator.write`) or gateway token. **Server only.** |
| `DEWEE_WEBCHAT_SECRET` | 32+ random chars to sign visitor sessions (`openssl rand -base64 32`) |
| `DEWEE_AGENTS` | Allowlist, comma separated (`support,sales`) or `*` |
| `DEWEE_DEFAULT_AGENT` | Optional; defaults to the first allowed agent |
| `DEWEE_ALLOWED_ORIGINS` | Extra origins for cross-origin embedding (same origin always works) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Optional Cloudflare Turnstile check for new visitors |

Create a scoped key with the Dewee CLI: `dewee api-keys create --name "website chat" --scopes operator.read,operator.write`.

## 2. Add the widget

**Script tag** (no build step):

```html
<script
  src="https://webchat-cdn.dewee.sh/dewee-webchat@0.1.0/dewee-webchat.js"
  data-endpoint="/api/dewee"
  data-title="Support"
  data-suggestions="What do you do?|Pricing?"
  defer
></script>
```

**React / Next.js**

```tsx
"use client";
import { DeweeChat } from "dewee-webchat/react";

<DeweeChat endpoint="/api/dewee" title="Support" suggestions={["Pricing?"]} showReasoning={false} onReply={(e) => console.log(e.detail)} />;
```

**Vue**

```vue
<script setup>
import { DeweeChat } from "dewee-webchat/vue";
</script>
<template><DeweeChat endpoint="/api/dewee" :show-tool-calls="false" @reply="onReply" /></template>
```

**Astro**

```astro
---
import DeweeChat from "dewee-webchat/astro";
---
<DeweeChat endpoint="/api/dewee" title="Support" />
```

**Anything else**: `import { mount } from "dewee-webchat"; mount({ endpoint: "/api/dewee" })`, or write
`<dewee-chat endpoint="/api/dewee"></dewee-chat>` after importing `dewee-webchat`.

## Options

Attributes use kebab-case (`show-reasoning="false"`), `data-*` on the script tag, camelCase as props.

| Option | Default | |
|---|---|---|
| `endpoint` | `/api/dewee` | Backend base URL |
| `agent` | backend default | Agent key |
| `title`, `subtitle`, `greeting`, `intro`, `placeholder` | | Texts |
| `suggestions` | | Quick replies (`a|b` or JSON array as attribute) |
| `avatar`, `launcherAvatar` | | Image URL; also use it on the launcher |
| `mode` | `floating` | `floating` (bubble + panel) or `inline` (fills its container) |
| `position` | `bottom-right` | or `bottom-left` |
| `theme` | `light` | `light`, `dark`, `auto` |
| `accentColor` | `#5446e8` | Any CSS color |
| `locale` | page language | `en`, `vi` |
| `showReasoning` | `true` | Stream the model's thinking |
| `showToolCalls` | `true` | Show tool calls with arguments and results |
| `allowAgentSwitch` | `true` | Agent picker when the backend allows several |
| `persist` | `true` | Keep the conversation across page loads |
| `open`, `hideBranding`, `width`, `height`, `zIndex` | | |

Methods: `open()`, `close()`, `toggle()`, `send(text)`, `stop()`, `newConversation()`, `configure(partial)`.
Events: `dewee:ready`, `dewee:open`, `dewee:close`, `dewee:send`, `dewee:reply`, `dewee:error`.
CSS variables: `--dw-accent`, `--dw-font`, `--dw-radius`, `--dw-width`, `--dw-height`, `--dw-z`.

## Security model

- The gateway token never leaves your server. Browsers get an HMAC-signed visitor id.
- Each visitor gets its own gateway user (`webchat-<id>`) and session keys, so history is private to them.
- Only allowlisted agents are reachable; origin allowlist, rate limits (20 messages/min per visitor, 10
  new sessions/10 min per IP by default — pass `rateLimit` for a shared store), 4000-char messages,
  optional Turnstile.
- "Bring your own gateway" (`allowClientCredentials`) is off by default; when on, internal hosts are refused.

The wire format is documented in [docs/http-contract.md](https://github.com/nextlevelbuilder/dewee-webchat/blob/main/docs/http-contract.md).

## License

MIT © NextLevelBuilder

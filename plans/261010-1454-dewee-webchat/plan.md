# dewee-webchat — embeddable Dewee chat widget + secure backend

Status: in progress

## Outcome
A public repo `nextlevelbuilder/dewee-webchat` that lets any website add a Dewee agent chatbox
in minutes: a framework-agnostic widget, thin framework wrappers, and a backend handler that keeps
the gateway token server-side. Released on GitHub, npm and a Cloudflare-hosted CDN, with working
examples deployed to Cloudflare.

## Verified facts (probed live on 2026-10-10)
- Gateway runtime: `https://dewee.zuey.me` (`app.dewee.sh` is the control plane, no `/v1` or `/ws`).
- `/v1/chat/completions` stream is fake (one chunk at the end, no reasoning/tool events) → use WS `/ws`.
- WS flow: `connect {token,user_id}` → `chat.send {agentId,sessionKey,message,stream:true}`.
  Events arrive as `{type:"event",event:"agent",payload:{type, runId, payload}}` with
  `type ∈ run.started | thinking{content} | chunk{content} | tool.call{id,name,arguments}
  | tool.result{id,name,is_error,result} | run.completed{content,thinking} | run.failed`.
  `chat.history {agentId,sessionKey}` → `{messages:[{role,content,thinking,tool_calls,tool_call_id}]}`.
- Session key: `agent:{agent}:ws:direct:{conversationId}`; non-admin callers are ownership-checked by user_id.
- Website agent: `dewee-web-advisor` (deepseek flash, MCP `anymd`). `zuey-ai` has tool calls (anymd).

## Architecture
- `packages/dewee-webchat` (npm `dewee-webchat`):
  - `.` widget: `<dewee-chat>` web component (Shadow DOM, no deps) + `mount()`; IIFE build for CDN.
  - `./server`: `createDeweeHandler(options)` → `(Request) => Response` (Workers, Next, Astro, Bun, Deno)
    + `toNodeHandler()` for Express/Node http. Bridges WS events to SSE.
  - `./react`, `./vue`: thin wrappers. `./astro`: `DeweeChat.astro`.
- `php/dewee-webchat.php`: single-file PHP backend (same HTTP contract).
- Security: token never leaves server; HMAC-signed visitor tokens; per-visitor gateway user_id;
  agent allowlist; origin allowlist; rate limit; length limits; optional Turnstile; opt-in BYO keys.

## Phases
1. Core package (widget + server) + tests — 
2. Examples: cloudflare (playground), react-vite, vue-vite, nextjs, astro, node-express, php
3. Deploy to Cloudflare (`*.dewee.sh`), CDN worker
4. GitHub repo, npm publish, GitHub release
5. Blog draft (Duy style) → `D:\Notes\Goon\03-BLOG\Drafts`, publish on zuey.me "Knowledges"

## Acceptance
- Live demos stream reasoning + tool calls from a real agent; toggles work; agent switch works.
- `npm i dewee-webchat` works; CDN URL serves the IIFE; GitHub release exists.
- Article published with widgets and repo link.

# dewee-webchat — PHP backend

`dewee-webchat.php` is a single-file backend for the chat widget (PHP >= 8.1, `ext-openssl`, no
Composer). It implements the [HTTP contract](../docs/http-contract.md) and behaves like the Node
handler in `dewee-webchat/server`. The gateway token stays on your server.

## Install

Copy `dewee-webchat.php` into your project and create an endpoint, for example `api/dewee.php`:

```php
<?php
require __DIR__ . '/../lib/dewee-webchat.php';
DeweeWebchat::loadEnvFile(__DIR__ . '/../.env'); // optional; real env vars win
DeweeWebchat::handle();                          // or DeweeWebchat::handle([...options])
```

Point the widget at it: `<script src="https://webchat-cdn.dewee.sh/dewee-webchat@latest/dewee-webchat.js" data-endpoint="/api/dewee.php" defer></script>`.
Routes use the last path segment, so `/api/dewee.php/chat` (PATH_INFO) and a rewrite such as
`/api/dewee/chat → api/dewee.php` both work.

## Configuration

Same variables as `optionsFromEnv()` in the Node package:

| Variable | Meaning |
|---|---|
| `DEWEE_GATEWAY_URL` / `GOCLAW_GATEWAY_URL` | Gateway origin, e.g. `https://gateway.example.com` |
| `DEWEE_GATEWAY_TOKEN` / `GOCLAW_GATEWAY_TOKEN` | Gateway token or scoped operator API key |
| `DEWEE_WEBCHAT_SECRET` | HMAC secret for visitor tokens (>= 32 random chars) |
| `DEWEE_AGENTS` | Comma-separated allowlist (first = default), or `*` |
| `DEWEE_DEFAULT_AGENT`, `DEWEE_TENANT_ID`, `DEWEE_ALLOWED_ORIGINS` (csv or `*`) | Optional |
| `DEWEE_ALLOW_CLIENT_CREDENTIALS=true`, `DEWEE_CLIENT_CREDENTIAL_HOSTS` | Bring-your-own gateway (playgrounds only) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Require Cloudflare Turnstile for new sessions |

Array options use the TS names (`gatewayUrl`, `token`, `agents`, `allowedOrigins`, `rateLimit` =
`false` or `callable(string $key, string $bucket): bool`, `onChat`, `timeoutMs`, …). Rate limits
default to 20 messages/min per visitor+IP and 10 sessions/10 min per IP, kept in files under
`sys_get_temp_dir()`. Without a secret, a generated one is stored in the temp dir (set your own).

## Streaming (SSE) behind a web server

Each chat turn holds one PHP worker for the length of the reply (up to `timeoutMs`, default 180 s).

- **Nginx + PHP-FPM:** the response sends `X-Accel-Buffering: no`; also set `fastcgi_read_timeout 300s;`
  and keep `gzip` off for `text/event-stream`.
- **Apache:** use PHP-FPM with `flushpackets=on` (`ProxyPassMatch … flushpackets=on`), or mod_php.
  Exclude the endpoint from `mod_deflate` (`SetEnvIf Request_URI "^/api/dewee" no-gzip`).
- **php.ini:** `output_buffering` and `zlib.output_compression` are turned off at runtime; if your
  host forbids that, disable them for the endpoint.
- **PHP built-in server:** single-threaded, fine for local testing (`examples/php`).

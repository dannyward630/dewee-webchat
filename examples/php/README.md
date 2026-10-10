# PHP example

A page with the chat widget, backed by [`php/dewee-webchat.php`](../../php/README.md).

```
examples/php/
  index.php        page that loads the widget
  api/dewee.php    backend endpoint (/api/dewee.php/{config,session,chat,history})
  router.php       router for PHP's built-in server
  .env.example     configuration template
```

## Run locally

```sh
cp examples/php/.env.example examples/php/.env   # fill in gateway URL, token, secret, agents
php -S 127.0.0.1:8790 -t examples/php examples/php/router.php
```

Open http://127.0.0.1:8790. Requires PHP >= 8.1 with `extension=openssl` enabled in `php.ini`.

Under the built-in server the page uses the locally built bundle
(`packages/dewee-webchat/dist/dewee-webchat.js`, served as `/dewee-webchat.js`) when it exists;
otherwise, and on any other server, it loads `https://webchat-cdn.dewee.sh/dewee-webchat@latest/dewee-webchat.js`.

## Try the API with curl

```sh
B=http://127.0.0.1:8790/api/dewee.php
curl $B/config
TOKEN=$(curl -s -X POST $B/session | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -N -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"message":"Hi!","conversationId":"demo01"}' $B/chat
curl -H "authorization: Bearer $TOKEN" "$B/history?conversationId=demo01"
```

## Deploy

Upload the folder plus `php/dewee-webchat.php` (or adjust the `require` path in `api/dewee.php`),
set the variables as real environment variables instead of `.env`, and read the SSE notes in
[php/README.md](../../php/README.md#streaming-sse-behind-a-web-server).

// Serves /dewee-webchat@<version|latest>/<file> from the static tree stored under /v/<version>/,
// because static assets alone would redirect "@" to "%40".
const NAME = "dewee-webchat";
const VERSIONED = new RegExp(`^/${NAME}(?:@|%40)([^/]+)/(.+)$`);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(VERSIONED);
    if (!m && url.pathname !== `/${NAME}.js`) return env.ASSETS.fetch(request);

    const version = m ? decodeURIComponent(m[1]) : "latest";
    const file = m ? m[2] : `${NAME}.js`;
    if (!/^[\w.+-]+$/.test(version) || file.includes("..")) return new Response("Not found", { status: 404 });

    const res = await env.ASSETS.fetch(new Request(new URL(`/v/${version}/${file}`, url), request));
    if (!res.ok) return new Response("Not found", { status: 404, headers: { "access-control-allow-origin": "*" } });

    const headers = new Headers(res.headers);
    headers.set("access-control-allow-origin", "*");
    headers.set("cross-origin-resource-policy", "cross-origin");
    headers.set("x-content-type-options", "nosniff");
    headers.set("cache-control", version === "latest" ? "public, max-age=300, s-maxage=300" : "public, max-age=31536000, immutable");
    return new Response(res.body, { status: res.status, headers });
  },
};

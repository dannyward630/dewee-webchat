// Adapter for Node's http/Express/Fastify-style (req, res) handlers.
import type { IncomingMessage, ServerResponse } from "node:http";

type FetchHandler = (request: Request) => Promise<Response>;

/** Wraps a fetch-style handler for `http.createServer`, Express (`app.all("/api/dewee/*", ...)`), etc. */
export function toNodeHandler(handler: FetchHandler) {
  return async (req: IncomingMessage & { body?: unknown; originalUrl?: string }, res: ServerResponse): Promise<void> => {
    const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || ((req.socket as any).encrypted ? "https" : "http");
    const url = new URL(req.originalUrl || req.url || "/", `${proto}://${req.headers.host || "localhost"}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v != null) headers.set(k, v);
    }
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableFinished) abort.abort(); });

    let body: BodyInit | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Express body parsers may have consumed the stream already.
      if (req.body !== undefined) body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      else {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = Buffer.concat(chunks);
      }
    }
    const response = await handler(new Request(url, { method: req.method, headers, body, signal: abort.signal }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return void res.end();
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      /* client went away */
    } finally {
      res.end();
    }
  };
}

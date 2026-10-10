// Express backend for dewee-webchat: the gateway token stays in this process,
// the browser only talks to /api/dewee/*.
import express from "express";
import { createRequire } from "node:module";
import { createDeweeHandler, optionsFromEnv, toNodeHandler } from "dewee-webchat/server";

const app = express();
const dewee = toNodeHandler(createDeweeHandler(optionsFromEnv(process.env)));

app.all("/api/dewee/*path", dewee);

// Serve the widget bundle from node_modules (or use the CDN instead).
const require = createRequire(import.meta.url);
app.get("/dewee-webchat.js", (_req, res) => res.sendFile(require.resolve("dewee-webchat/cdn")));
app.use(express.static(new URL("./public", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")));

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => console.log(`dewee-webchat example on http://localhost:${port}`));

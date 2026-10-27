// Express backend for dewee-webchat: the integration secret stays in this process,
// the browser only talks to /api/dewee/*. Configure it with the CCP Website chat variables
// (DEWEE_CCP_CHAT_URL, DEWEE_WEBCHAT_INTEGRATION_ID, DEWEE_WEBCHAT_INTEGRATION_SECRET) and
// DEWEE_WEBCHAT_SECRET; see the package README.
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

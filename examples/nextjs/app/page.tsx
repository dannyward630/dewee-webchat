import { ChatWidget } from "./chat-widget";

const ROUTE_SNIPPET = `// app/api/dewee/[...path]/route.ts
import { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";

export const dynamic = "force-dynamic";
const dewee = createDeweeHandler(optionsFromEnv(process.env));
export { dewee as GET, dewee as POST, dewee as OPTIONS };`;

const COMPONENT_SNIPPET = `// app/chat-widget.tsx
"use client";
import { DeweeChat } from "dewee-webchat/react";

export function ChatWidget() {
  return <DeweeChat endpoint="/api/dewee" suggestions={["What is Dewee?"]} />;
}`;

export default function Home() {
  return (
    <main className="page">
      <p className="eyebrow">Example</p>
      <h1>Next.js + dewee-webchat</h1>
      <p className="lead">
        This App Router app mounts the <code>dewee-webchat</code> backend as one catch-all route handler and renders
        the floating chat widget with the React wrapper. The gateway token never leaves the server: the browser only
        gets a signed visitor session, and answers stream back over SSE. It runs on Cloudflare Workers via OpenNext.
      </p>

      <h2>1. Route handler</h2>
      <pre>
        <code>{ROUTE_SNIPPET}</code>
      </pre>

      <h2>2. Client component</h2>
      <pre>
        <code>{COMPONENT_SNIPPET}</code>
      </pre>

      <p className="hint">Open the chat bubble in the corner to try it.</p>

      <nav className="links">
        <a href="https://webchat.dewee.sh">Documentation</a>
        <a href="https://github.com/nextlevelbuilder/dewee-webchat/tree/main/examples/nextjs">Source on GitHub</a>
      </nav>

      <ChatWidget />
    </main>
  );
}

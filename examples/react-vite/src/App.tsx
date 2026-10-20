import { useMemo, useRef, useState } from "react";
import { DeweeChat, type DeweeChatElement, type PageAction } from "dewee-webchat/react";

type Theme = "light" | "dark" | "auto";
type View = "overview" | "runs" | "settings";
interface Run { id: string; name: string; status: "running" | "cancelled" | "done" }

const VIEWS: View[] = ["overview", "runs", "settings"];
const INITIAL_RUNS: Run[] = [
  { id: "run_a1", name: "Nightly build", status: "running" },
  { id: "run_b2", name: "Docs deploy", status: "running" },
  { id: "run_c3", name: "Data export", status: "done" },
];

const SAMPLE_QUESTION = "Đọc https://dewee.sh và tóm tắt 1 câu.";
const SUGGESTIONS = ["What is Dewee?", "Show me the runs page", "Cancel the nightly build", SAMPLE_QUESTION];
const REPO_URL = "https://github.com/nextlevelbuilder/dewee-webchat/tree/main/examples/react-vite";

const SNIPPET = `// worker/index.ts — the gateway token never leaves the Worker
import { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";

let dewee;
export default {
  fetch(req, env) {
    if (new URL(req.url).pathname.startsWith("/api/dewee/"))
      return (dewee ??= createDeweeHandler(optionsFromEnv(env)))(req);
    return env.ASSETS.fetch(req);
  },
};

// App.tsx
import { DeweeChat } from "dewee-webchat/react";

const chat = useRef(null);
<DeweeChat ref={chat} endpoint="/api/dewee" theme={theme}
  showReasoning={reasoning} showToolCalls={toolCalls}
  suggestions={["What is Dewee?"]} onReply={(e) => console.log(e.detail)} />
chat.current?.send("Hello!");`;

export function App() {
  const chat = useRef<DeweeChatElement>(null);
  const [showReasoning, setShowReasoning] = useState(true);
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [theme, setTheme] = useState<Theme>("auto");
  const [status, setStatus] = useState("none yet (the widget loads when first opened)");
  const [view, setView] = useState<View>("overview");
  const [runs, setRuns] = useState<Run[]>(INITIAL_RUNS);

  // Page actions the agent may call from chat. Navigation is an allowlist (enum), and the mutate
  // action only runs after the visitor approves it in the widget's confirm dialog.
  const actions = useMemo<PageAction[]>(
    () => [
      {
        name: "navigate",
        description: "Switch the demo dashboard to another view.",
        sensitivity: "navigate",
        parameters: { type: "object", properties: { view: { type: "string", enum: VIEWS } }, required: ["view"], additionalProperties: false },
        handler: ({ view }: { view: View }) => {
          setView(view);
          return { view };
        },
      },
      {
        name: "runs.cancel",
        description: "Cancel a running job on the demo dashboard by its id (see page context).",
        sensitivity: "mutate",
        parameters: { type: "object", properties: { id: { type: "string", pattern: "^run_[a-z0-9]+$" } }, required: ["id"], additionalProperties: false },
        handler: ({ id }: { id: string }) => {
          const run = runs.find((r) => r.id === id);
          if (!run) throw new Error(`No run ${id}`);
          if (run.status !== "running") return { id, status: run.status, changed: false };
          setRuns((all) => all.map((r) => (r.id === id ? { ...r, status: "cancelled" } : r)));
          return { id, status: "cancelled", changed: true };
        },
      },
    ],
    [runs],
  );

  return (
    <main>
      <span className="eyebrow">Example · Vite + Cloudflare Workers</span>
      <h1>
        React <span>+</span> dewee-webchat
      </h1>
      <p>
        A Dewee AI agent chat embedded in a React app with the <code>DeweeChat</code> component. A Cloudflare Worker
        serves this page as static assets and runs the chat backend under <code>/api/dewee</code>, so the gateway token
        never reaches the browser.
      </p>
      <p>Change the controls below and the floating widget updates live — props flow straight into the element.</p>
      <div className="links">
        <a href="https://webchat.dewee.sh">dewee-webchat docs →</a>
        <a href={REPO_URL}>Source on GitHub →</a>
      </div>

      <h2>Live props</h2>
      <div className="controls">
        <label>
          <input type="checkbox" checked={showReasoning} onChange={(e) => setShowReasoning(e.target.checked)} />
          showReasoning
        </label>
        <label>
          <input type="checkbox" checked={showToolCalls} onChange={(e) => setShowToolCalls(e.target.checked)} />
          showToolCalls
        </label>
        <label>
          theme
          <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="auto">auto</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </label>
      </div>
      <div className="buttons">
        <button type="button" onClick={() => chat.current?.open()}>
          Open chat
        </button>
        <button type="button" className="primary" onClick={() => void chat.current?.send(SAMPLE_QUESTION)}>
          Ask: “{SAMPLE_QUESTION}”
        </button>
        <button type="button" onClick={() => chat.current?.newConversation()}>
          New conversation
        </button>
      </div>
      <p className="status">
        Last event: <code>{status}</code>
      </p>

      <h2>Page actions</h2>
      <p>
        The agent can operate this demo dashboard: try “Show me the runs page” or “Cancel the nightly build”. Navigation
        runs directly; cancelling asks you first.
      </p>
      <div className="buttons" role="tablist">
        {VIEWS.map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "primary" : ""} onClick={() => setView(v)}>
            {v}
          </button>
        ))}
      </div>
      {view === "runs" ? (
        <ul className="runs">
          {runs.map((r) => (
            <li key={r.id}>
              <code>{r.id}</code> {r.name} — <strong>{r.status}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="status">Current view: {view}</p>
      )}

      <h2>Integration</h2>
      <pre>
        <code>{SNIPPET}</code>
      </pre>

      <footer>
        Built with <a href="https://webchat.dewee.sh">dewee-webchat</a> · React 19 · Vite · Cloudflare Workers
      </footer>

      <DeweeChat
        ref={chat}
        endpoint="/api/dewee"
        title="Dewee assistant"
        subtitle="React example"
        greeting="Hi there 👋"
        intro="Ask about Dewee, or how this React example is wired up."
        suggestions={SUGGESTIONS}
        accentColor="#5446e8"
        theme={theme}
        showReasoning={showReasoning}
        showToolCalls={showToolCalls}
        actions={actions}
        getPageContext={() => ({ view, runs })}
        onAction={(e) => setStatus(`action ${e.detail.phase}: ${e.detail.name}${e.detail.status ? ` (${e.detail.status})` : ""}`)}
        onReady={() => setStatus("ready")}
        onOpen={() => setStatus("open")}
        onClose={() => setStatus("close")}
        onSend={() => setStatus("send")}
        onReply={() => setStatus("reply")}
        onError={(e) => setStatus(`error: ${String((e.detail as { message?: string } | null)?.message ?? "unknown")}`)}
      />
    </main>
  );
}

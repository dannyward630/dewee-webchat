// Playground: form controls → live widget config → generated integration code.
const $ = (sel) => document.querySelector(sel);
const form = $("#controls");
const preview = $("#preview");
const floating = $("#floating");
const STORE_KEY = "dewee-webchat:playground";
const SWATCHES = ["#5446e8", "#0f766e", "#e11d48", "#ea580c", "#0369a1", "#1b1f4b"];
const DEFAULTS = { theme: "light", position: "bottom-right", accentColor: "#5446e8", showReasoning: true, showToolCalls: true, allowAgentSwitch: true, persist: true, hideBranding: false };

let version = "latest";
let byo = null; // { gatewayUrl, gatewayToken } kept in memory only

const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; } },
  set(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- form <-> config ----------

function readForm() {
  const f = form.elements;
  return {
    agent: f.agent.value || undefined,
    allowAgentSwitch: f.allowAgentSwitch.checked,
    showReasoning: f.showReasoning.checked,
    showToolCalls: f.showToolCalls.checked,
    persist: f.persist.checked,
    hideBranding: f.hideBranding.checked,
    title: f.title.value.trim() || undefined,
    subtitle: f.subtitle.value.trim() || undefined,
    greeting: f.greeting.value.trim() || undefined,
    suggestions: f.suggestions.value.split("\n").map((s) => s.trim()).filter(Boolean),
    theme: f.theme.value,
    locale: f.locale.value || undefined,
    accentColor: f.accentColor.value,
    position: f.position.value,
    floating: f.floating.checked,
  };
}

function restoreForm() {
  const saved = store.get();
  const f = form.elements;
  for (const [k, v] of Object.entries(saved)) {
    const input = f[k];
    if (!input || k === "gatewayToken") continue;
    if (input.type === "checkbox") input.checked = !!v;
    else if (k === "suggestions") input.value = (v || []).join("\n");
    else if (k !== "agent") input.value = v ?? "";
  }
  return saved;
}

function apply() {
  const c = readForm();
  const { floating: showFloating, ...config } = c;
  const creds = byo ?? { gatewayUrl: undefined, gatewayToken: undefined };
  preview.configure({ ...config, ...creds, mode: "inline" });
  $("#stage").dataset.theme = c.theme === "dark" ? "dark" : "light";
  if (showFloating) {
    floating.hidden = false;
    floating.configure({ ...config, ...creds, mode: "floating" });
  } else {
    floating.hidden = true;
    floating.close?.();
  }
  store.set(c);
  renderCode(c);
}

// ---------- agents ----------

async function loadAgents(selected) {
  const select = $("#agent-select");
  const headers = byo ? { "x-dewee-gateway-url": byo.gatewayUrl, "x-dewee-gateway-token": byo.gatewayToken } : {};
  const res = await fetch("/api/dewee/config", { headers });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  version = body.version || version;
  $("#version").textContent = `v${version}`;
  select.replaceChildren(
    ...body.agents.map((a) => {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.name ? `${a.name} (${a.id})` : a.id;
      return o;
    }),
  );
  const want = selected && body.agents.some((a) => a.id === selected) ? selected : body.defaultAgent;
  if (want) select.value = want;
  return body.agents;
}

// ---------- bring your own gateway ----------

const status = (text, kind = "") => {
  const el = $("#byo-status");
  el.textContent = text;
  el.className = `status ${kind}`;
};

$("#byo-apply").addEventListener("click", async () => {
  const url = form.elements.gatewayUrl.value.trim().replace(/\/+$/, "");
  const token = form.elements.gatewayToken.value.trim();
  if (!/^https:\/\//.test(url) || !token) return status("Enter an https:// gateway URL and an API key.", "err");
  const previous = byo;
  byo = { gatewayUrl: url, gatewayToken: token };
  status("Connecting…");
  try {
    const agents = await loadAgents();
    status(`Connected · ${agents.length} agent${agents.length === 1 ? "" : "s"} available.`, "ok");
    apply();
  } catch (e) {
    byo = previous;
    status(`Could not connect: ${e.message}`, "err");
  }
});

$("#byo-clear").addEventListener("click", async () => {
  byo = null;
  form.elements.gatewayToken.value = "";
  status("Using the demo gateway.");
  await loadAgents(readForm().agent).catch(() => {});
  apply();
});

// ---------- code generation ----------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const kebab = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const q = (s) => JSON.stringify(s);

/** Options that differ from widget defaults, in a stable order. */
function options(c) {
  const out = [];
  const add = (k, v) => out.push([k, v]);
  if (c.agent) add("agent", c.agent);
  if (c.title) add("title", c.title);
  if (c.subtitle) add("subtitle", c.subtitle);
  if (c.greeting) add("greeting", c.greeting);
  if (c.suggestions.length) add("suggestions", c.suggestions);
  for (const k of ["theme", "position", "accentColor"]) if (c[k] !== DEFAULTS[k]) add(k, c[k]);
  if (c.locale) add("locale", c.locale);
  for (const k of ["showReasoning", "showToolCalls", "allowAgentSwitch", "persist", "hideBranding"]) if (c[k] !== DEFAULTS[k]) add(k, c[k]);
  return out;
}

const TABS = {
  html: {
    label: "HTML / CDN",
    note: "Paste before </body>. The script only talks to your backend at data-endpoint — add one of the server tabs.",
    code(c) {
      const attrs = options(c).map(([k, v]) => {
        const val = Array.isArray(v) ? (v.some((s) => s.includes("|")) ? JSON.stringify(v) : v.join("|")) : String(v);
        return `  data-${kebab(k)}="${val.replace(/"/g, "&quot;")}"`;
      });
      return `<script\n  src="https://webchat-cdn.dewee.sh/dewee-webchat@${version}/dewee-webchat.js"\n  data-endpoint="/api/dewee"\n${attrs.join("\n")}${attrs.length ? "\n" : ""}  defer\n></script>`;
    },
  },
  react: {
    label: "React",
    note: "npm i dewee-webchat — works in Vite, Remix and Next.js client components.",
    code(c) {
      const props = options(c).map(([k, v]) => (typeof v === "string" ? `  ${k}=${q(v)}` : `  ${k}={${JSON.stringify(v)}}`));
      return `import { DeweeChat } from "dewee-webchat/react";\n\nexport function SupportChat() {\n  return (\n    <DeweeChat\n      endpoint="/api/dewee"\n${props.map((p) => "    " + p).join("\n")}\n    />\n  );\n}`;
    },
  },
  vue: {
    label: "Vue",
    note: "npm i dewee-webchat — props are reactive; listen with @reply, @error, @open…",
    code(c) {
      const props = options(c).map(([k, v]) => (typeof v === "string" ? `  ${kebab(k)}=${q(v)}` : `  :${kebab(k)}='${JSON.stringify(v)}'`));
      return `<script setup lang="ts">\nimport { DeweeChat } from "dewee-webchat/vue";\n</script>\n\n<template>\n  <DeweeChat\n    endpoint="/api/dewee"\n${props.map((p) => "  " + p).join("\n")}\n  />\n</template>`;
    },
  },
  astro: {
    label: "Astro",
    note: "Pair it with an API route at src/pages/api/dewee/[...path].ts (see the Workers tab).",
    code(c) {
      const props = options(c).map(([k, v]) => (typeof v === "string" ? `  ${k}=${q(v)}` : `  ${k}={${JSON.stringify(v)}}`));
      return `---\nimport DeweeChat from "dewee-webchat/astro";\n---\n\n<DeweeChat\n  endpoint="/api/dewee"\n${props.join("\n")}\n/>`;
    },
  },
  next: {
    label: "Next.js route",
    note: "app/api/dewee/[...path]/route.ts — set the env vars in .env.local or your host's secrets.",
    code(c) {
      return `// app/api/dewee/[...path]/route.ts\nimport { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";\n\nexport const dynamic = "force-dynamic";\n\nconst handler = createDeweeHandler(optionsFromEnv(process.env));\nexport { handler as GET, handler as POST, handler as OPTIONS };\n\n// .env.local\n// DEWEE_GATEWAY_URL=https://your-gateway.example.com\n// DEWEE_GATEWAY_TOKEN=…          (operator API key, server only)\n// DEWEE_WEBCHAT_SECRET=…         (openssl rand -base64 32)\n// DEWEE_AGENTS=${c.agent || "your-agent"}`;
    },
  },
  workers: {
    label: "Cloudflare Workers",
    note: "Secrets: wrangler secret put DEWEE_GATEWAY_TOKEN, then DEWEE_WEBCHAT_SECRET.",
    code(c) {
      return `// src/worker.ts\nimport { createDeweeHandler, optionsFromEnv } from "dewee-webchat/server";\n\nlet dewee;\nexport default {\n  fetch(req, env) {\n    if (new URL(req.url).pathname.startsWith("/api/dewee/")) {\n      dewee ??= createDeweeHandler(optionsFromEnv(env));\n      return dewee(req);\n    }\n    return env.ASSETS.fetch(req);\n  },\n};\n\n// wrangler.jsonc → "vars": { "DEWEE_GATEWAY_URL": "https://your-gateway.example.com", "DEWEE_AGENTS": "${c.agent || "your-agent"}" }`;
    },
  },
  express: {
    label: "Express",
    note: "Node 20+. Also works with node:http, Fastify (raw req/res) and Bun/Deno (pass the handler directly).",
    code(c) {
      return `import express from "express";\nimport { createDeweeHandler, optionsFromEnv, toNodeHandler } from "dewee-webchat/server";\n\nconst app = express();\napp.all("/api/dewee/*path", toNodeHandler(createDeweeHandler(optionsFromEnv(process.env))));\napp.listen(3000);\n\n// DEWEE_GATEWAY_URL, DEWEE_GATEWAY_TOKEN, DEWEE_WEBCHAT_SECRET, DEWEE_AGENTS=${c.agent || "your-agent"}`;
    },
  },
  php: {
    label: "PHP",
    note: "One file, no Composer. Download php/dewee-webchat.php from the GitHub release.",
    code(c) {
      return `<?php\n// api/dewee.php  →  served as /api/dewee.php/{config|session|chat|history}\nrequire __DIR__ . '/../lib/dewee-webchat.php';\n\nDeweeWebchat::loadEnvFile(__DIR__ . '/../.env'); // optional; real env vars win\nDeweeWebchat::handle(['agents' => ['${c.agent || "your-agent"}']]);\n\n// .env → DEWEE_GATEWAY_URL, DEWEE_GATEWAY_TOKEN, DEWEE_WEBCHAT_SECRET\n// Widget: data-endpoint="/api/dewee.php"`;
    },
  },
};
let tab = "html";

// One pass over the raw code so inserted markup is never re-matched.
const TOKEN = /(\/\/[^\n]*|<!--[\s\S]*?-->)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(import|from|export|const|let|return|function|default|require|new)\b/g;
function highlight(code) {
  let out = "";
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    out += esc(code.slice(last, m.index));
    const cls = m[1] ? "tok-c" : m[2] ? "tok-s" : "tok-k";
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

function renderCode(c = readForm()) {
  const t = TABS[tab];
  const code = t.code(c);
  $("#code-out").innerHTML = highlight(code);
  $("#code-out").dataset.raw = code;
  $("#code-note").textContent = t.note;
}

function renderTabs() {
  const bar = $("#code-tabs");
  bar.replaceChildren(
    ...Object.entries(TABS).map(([id, t]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.role = "tab";
      b.textContent = t.label;
      b.setAttribute("aria-selected", String(id === tab));
      b.addEventListener("click", () => {
        tab = id;
        renderTabs();
        renderCode();
      });
      return b;
    }),
  );
}

// ---------- misc ----------

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const label = btn.querySelector("span") ?? btn;
    const old = label.textContent;
    label.textContent = "Copied";
    setTimeout(() => (label.textContent = old), 1400);
  } catch { /* clipboard blocked: the text is still selectable */ }
}
document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => copy(b.dataset.copy, b)));
$("#copy-code").addEventListener("click", (e) => copy($("#code-out").dataset.raw, e.currentTarget));

$("#swatches").replaceChildren(
  ...SWATCHES.map((hex) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.background = hex;
    b.title = hex;
    b.addEventListener("click", () => {
      form.elements.accentColor.value = hex;
      apply();
    });
    return b;
  }),
);

let timer;
form.addEventListener("input", (e) => {
  if (e.target.name === "gatewayUrl" || e.target.name === "gatewayToken") return;
  clearTimeout(timer);
  timer = setTimeout(apply, e.target.tagName === "TEXTAREA" || e.target.type === "text" ? 250 : 0);
});
form.addEventListener("submit", (e) => e.preventDefault());

// ---------- boot ----------

await customElements.whenDefined("dewee-chat");
const saved = restoreForm();
renderTabs();
try {
  await loadAgents(saved.agent);
} catch (e) {
  status(`Demo gateway unavailable: ${e.message}`, "err");
}
apply();

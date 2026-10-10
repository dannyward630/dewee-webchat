// CDN/IIFE entry: <script src=".../dewee-webchat.js" data-endpoint="/api/dewee" defer></script>
// auto-mounts a floating widget configured by data-* attributes. Without data-endpoint it
// only registers <dewee-chat> and exposes window.DeweeWebchat.
import * as api from "./index";

const script = document.currentScript as HTMLScriptElement | null;
const ds = script?.dataset;
if (ds && ds.endpoint && ds.autoMount !== "false") {
  const boot = () => {
    const el = document.createElement("dewee-chat");
    for (const [k, v] of Object.entries(ds)) {
      if (k === "autoMount" || v === undefined) continue;
      el.setAttribute(k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), v);
    }
    document.body.appendChild(el);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}

(window as any).DeweeWebchat = api;

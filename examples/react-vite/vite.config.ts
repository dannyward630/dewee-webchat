import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// cloudflare() runs worker/index.ts inside workerd during `vite dev`, so /api/dewee works locally too.
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});

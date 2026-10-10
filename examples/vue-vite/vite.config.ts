import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { cloudflare } from "@cloudflare/vite-plugin";

// cloudflare() runs worker/index.ts inside workerd during `vite dev`, so /api/dewee works locally too.
export default defineConfig({
  plugins: [vue(), cloudflare()],
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
});

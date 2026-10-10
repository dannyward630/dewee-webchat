// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "server",
  site: "https://webchat-astro.dewee.sh",
  // No Astro sessions or image transforms needed: skips the SESSION KV and IMAGES bindings.
  session: false,
  adapter: cloudflare({ imageService: "passthrough" }),
});

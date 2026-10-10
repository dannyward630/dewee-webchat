// See https://opennext.js.org/cloudflare/get-started — no incremental cache is needed:
// the page is static and the API route is dynamic.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});

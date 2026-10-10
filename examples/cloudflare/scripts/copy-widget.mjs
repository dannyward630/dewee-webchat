// Copies the freshly built widget bundle next to the page so the playground always runs the
// workspace version (the embed snippets it generates point at the public CDN).
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
copyFileSync(require.resolve("dewee-webchat/cdn"), new URL("../public/dewee-webchat.js", import.meta.url));
console.log("public/dewee-webchat.js updated");

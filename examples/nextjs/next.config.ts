import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {};

export default nextConfig;

// Lets `next dev` expose wrangler vars / .dev.vars through getCloudflareContext().
initOpenNextCloudflareForDev();

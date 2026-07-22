import { defineCloudflareConfig } from "@opennextjs/cloudflare";
const config = { ...defineCloudflareConfig(), buildCommand: "npm run build:next" };
export default config;

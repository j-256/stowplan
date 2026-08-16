import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Makes getCloudflareContext() and local Wrangler bindings available to
// `next dev`. OpenNext treats this as a no-op for production builds
const localPersistencePath =
  process.env.STOWPLAN_WRANGLER_PERSIST_PATH;
initOpenNextCloudflareForDev(
  localPersistencePath
    ? { persist: { path: localPersistencePath } }
    : undefined,
);

function liveRelayConnectSources(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  let relay: URL;
  try {
    relay = new URL(value);
  } catch {
    throw new Error("LIVE_RELAY_URL must be a valid absolute URL");
  }
  const localHttp = relay.protocol === "http:" &&
    (relay.hostname === "127.0.0.1" || relay.hostname === "localhost");
  if (
    (relay.protocol !== "https:" && !localHttp) ||
    relay.username ||
    relay.password ||
    relay.search ||
    relay.hash ||
    (relay.pathname !== "/" && relay.pathname !== "")
  ) {
    throw new Error(
      "LIVE_RELAY_URL must be an HTTPS origin or a local HTTP origin",
    );
  }
  const websocket = new URL(relay.origin);
  websocket.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
  return [relay.origin, websocket.origin];
}

const connectSources = [
  "'self'",
  ...liveRelayConnectSources(process.env.LIVE_RELAY_URL),
];

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src ${connectSources.join(" ")}`,
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      { source: "/", headers: securityHeaders },
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/guest/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;

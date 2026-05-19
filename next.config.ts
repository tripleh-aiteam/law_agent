import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  typedRoutes: true,
  // Allow ngrok tunnels (and any LAN preview) to load HMR/dev resources.
  // Without this Next.js blocks cross-origin requests from ngrok-free.dev /
  // ngrok-free.app, which breaks WebSocket-driven interactivity in dev mode.
  allowedDevOrigins: [
    "*.ngrok-free.dev",
    "*.ngrok-free.app",
    "*.ngrok.io",
    "*.ngrok.app",
    "192.168.0.2",
  ],
};

export default withNextIntl(nextConfig);

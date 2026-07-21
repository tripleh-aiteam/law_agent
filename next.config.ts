import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  typedRoutes: true,
  // Self-hosted on the firm's server via Docker. "standalone" emits a
  // minimal server bundle + only the node_modules actually reached, so the
  // runtime image stays small instead of shipping the whole dependency tree.
  output: "standalone",
  // @huggingface/transformers loads ONNX runtime binaries at runtime. Next
  // must NOT try to bundle those — leave the package external so it resolves
  // from node_modules inside the container. (On Vercel this package blew the
  // 250MB function limit, which is why embeddings were on the AI Gateway;
  // that limit does not exist on our own server.)
  serverExternalPackages: ["@huggingface/transformers", "pg"],
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

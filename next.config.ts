import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  typedRoutes: true,
  // transformers.js ships native ONNX runtime — must be loaded as an external
  // by Next's bundler instead of being inlined into the function output.
  serverExternalPackages: ["@huggingface/transformers"],
};

export default withNextIntl(nextConfig);

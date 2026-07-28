import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@hair-simo/ui", "@hair-simo/core", "@hair-simo/db", "@hair-simo/i18n"],
  serverExternalPackages: [
    "firebase-admin",
    "googleapis",
    "@google-cloud/pubsub",
    "@hair-simo/gcp",
  ],
};

export default nextConfig;

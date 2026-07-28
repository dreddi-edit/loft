import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@hair-simo/ui", "@hair-simo/core", "@hair-simo/db", "@hair-simo/ai", "@hair-simo/i18n"],
  serverExternalPackages: [
    "@google-cloud/vertexai",
    "@google-cloud/speech",
    "@google-cloud/text-to-speech",
    "@google-cloud/pubsub",
    "@google-cloud/tasks",
    "firebase-admin",
    "googleapis",
    "@hair-simo/gcp",
  ],
};

export default nextConfig;

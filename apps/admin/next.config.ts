import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

loadEnvConfig(path.join(__dirname, "../.."));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@hair-simo/ui", "@hair-simo/core", "@hair-simo/db", "@hair-simo/i18n", "@hair-simo/gcp"],
  serverExternalPackages: ["firebase-admin", "googleapis"],
};

export default nextConfig;

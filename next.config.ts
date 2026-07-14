import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"],
};

export default nextConfig;

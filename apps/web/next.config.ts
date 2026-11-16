import type { NextConfig } from "next";

// `next dev` only serves its scripts to pages opened at "localhost". Opening the game at
// 127.0.0.1 or a LAN address (e.g. from a phone) left it stuck on the loading screen, so
// allow loopback and private-network hosts. Extra hosts: POSTMARK_DEV_ORIGINS=a.test,b.test
const devOrigins = [
  "127.0.0.1",
  "[::1]",
  "*.local",
  "10.*.*.*",
  "192.168.*.*",
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*.*`),
  ...(process.env.POSTMARK_DEV_ORIGINS?.split(",").map((h) => h.trim()).filter(Boolean) ?? []),
];

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
  // Don't write an AGENTS.md into the app on every `next dev`.
  agentRules: false,
  transpilePackages: ["@postmark/game-core", "@postmark/globe"],
  async headers() {
    return [
      {
        // Baked geo data changes only when the pipeline is re-run.
        source: "/geo/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
    ];
  },
};

export default nextConfig;

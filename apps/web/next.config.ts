import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

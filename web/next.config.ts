import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        // NBA.com's own player-headshot CDN -- unofficial (not a public
        // documented API), but widely used by convention. Missing photos
        // (mostly obscure/historical role players) resolve to a generic
        // silhouette placeholder server-side, not a broken image, so no
        // client-side onError fallback is needed here.
        protocol: "https",
        hostname: "cdn.nba.com",
        pathname: "/headshots/**",
      },
    ],
  },
};

export default nextConfig;

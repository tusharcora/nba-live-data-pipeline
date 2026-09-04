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
      {
        // ESPN's team-logo CDN -- NBA.com doesn't expose one keyed by the
        // 3-letter abbreviation this app already has (only by numeric
        // team_id, which isn't in this app's data), so this uses ESPN's
        // instead. Every code was checked directly against the CDN before
        // use (see teamLogoUrlFromAbbreviation's comment in
        // app/explorer/page.tsx).
        protocol: "https",
        hostname: "a.espncdn.com",
        pathname: "/i/teamlogos/nba/**",
      },
    ],
  },
};

export default nextConfig;

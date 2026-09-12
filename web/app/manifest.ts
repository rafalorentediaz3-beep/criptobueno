import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Robinhood Chain launchpad",
    short_name: "Launchpad",
    description:
      "Launch a fixed-supply token straight into a permanently locked Uniswap V3 position.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [{ src: "/logo.webp", sizes: "any", type: "image/webp" }],
  };
}

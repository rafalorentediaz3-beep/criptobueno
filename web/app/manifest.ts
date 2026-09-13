import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ass.family",
    short_name: "ass.family",
    description:
      "Launch a fixed-supply token straight into a permanently locked Uniswap V3 position.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [{ src: "/header-logo.png", sizes: "any", type: "image/png" }],
  };
}

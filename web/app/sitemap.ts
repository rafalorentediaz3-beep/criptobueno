import type { MetadataRoute } from "next";

const BASE = "https://potato.fm";

export const revalidate = 3600;

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: BASE,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${BASE}/create`,
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      url: `${BASE}/analytics`,
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      url: `${BASE}/terms`,
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      url: `${BASE}/privacy`,
      changeFrequency: "daily",
      priority: 0.6,
    },
  ];
}

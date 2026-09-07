export const dynamic = "force-static";

export async function GET() {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml",
    },
  });
}
    /* feed unavailable — static routes still ship */
  }

  return [...staticRoutes, ...tokens];
}

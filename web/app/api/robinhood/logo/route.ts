import { NextRequest } from "next/server";

export const runtime = "edge";
export const revalidate = 86400;

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) {
    return new Response("Invalid stock symbol", { status: 400 });
  }

  const upstream = await fetch(
    `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`,
    {
      headers: { accept: "image/png,image/*;q=0.8,*/*;q=0.1" },
      next: { revalidate: 86400 },
    },
  );
  if (!upstream.ok) return new Response("Logo not found", { status: 404 });

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return new Response("Invalid logo response", { status: 502 });

  return new Response(upstream.body, {
    headers: {
      "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

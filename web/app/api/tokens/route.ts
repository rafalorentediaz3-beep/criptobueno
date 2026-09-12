import { NextResponse } from "next/server";
import { loadFeed } from "@/lib/tokenFeed";

/**
 * Server-side, cached Discover feed. The scan + cache live in `@/lib/tokenFeed`
 * so the token page's metadata and OG image share the same one-scan-per-TTL feed.
 *
 * Cache briefly at the shared edge so a cold Railway process or full chain scan
 * never sits in the critical path for every first-time visitor. The server feed
 * still refreshes in the background and new launches propagate within seconds.
 */

export const runtime = "nodejs";

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=10, stale-while-revalidate=300",
};

export async function GET() {
  // loadFeed soft-degrades on RPC failure (last good payload, or unavailable),
  // so we always return HTTP 200 and the UI degrades gracefully.
  const payload = await loadFeed();
  return NextResponse.json(payload, { headers: CACHE_HEADERS });
}

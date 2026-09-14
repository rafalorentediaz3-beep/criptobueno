import { NextRequest, NextResponse } from "next/server";
import { ROBINHOOD_TOKENIZED_STOCKS } from "@/lib/stocks";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get("search")?.trim().toLowerCase() ?? "";
  const stocks = ROBINHOOD_TOKENIZED_STOCKS
    .filter((item) => !search || `${item.symbol} ${item.name}`.toLowerCase().includes(search))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  return NextResponse.json(
    { stocks },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=3600" } },
  );
}

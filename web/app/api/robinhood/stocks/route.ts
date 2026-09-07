import { NextRequest, NextResponse } from "next/server";
import type { RobinhoodStock } from "@/lib/stocks";

export const runtime = "edge";
export const revalidate = 3600;

type RobinhoodInstrument = {
  name?: string;
  simple_name?: string | null;
  symbol?: string;
  type?: string;
  state?: string;
  tradeable?: boolean;
};

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams.get("search")?.trim().toLowerCase() ?? "";
  const instruments: RobinhoodInstrument[] = [];
  const exactSymbol = search && /^[a-z0-9.-]{1,8}$/i.test(search) ? `&symbol=${encodeURIComponent(search.toUpperCase())}` : "";
  let url =
    `https://api.robinhood.com/instruments/?state=active&tradeable=true&paginate=false${exactSymbol}`;

  for (let page = 0; page < 5 && url; page += 1) {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!response.ok) {
      return NextResponse.json({ error: "Robinhood stock catalogue unavailable" }, { status: 502 });
    }
    const data = (await response.json()) as {
      next?: string | null;
      results?: RobinhoodInstrument[];
    };
    instruments.push(...(data.results ?? []));
    url = data.next ?? "";
  }

  const stocks: RobinhoodStock[] = instruments
    .filter((item) => item.symbol && item.name && item.state === "active" && item.tradeable)
    .filter((item) => item.type === "stock" || item.type === "etp")
    .map((item) => {
      const symbol = item.symbol!.toUpperCase();
      return {
        symbol,
        name: item.simple_name || item.name!,
        type: item.type!,
        // Robinhood supplies the canonical symbol/name catalogue. FMP's public
        // symbol endpoint provides the issuer logo, including many OTC symbols
        // that do not exist in the large-cap logo catalogues.
        imageUrl: `/api/robinhood/logo?symbol=${encodeURIComponent(symbol)}`,
      };
    })
    .filter((item) => !search || `${item.symbol} ${item.name}`.toLowerCase().includes(search))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .slice(0, 250);

  return NextResponse.json({ stocks }, { headers: { "Cache-Control": "public, max-age=3600" } });
}

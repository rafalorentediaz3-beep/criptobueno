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

const ORIGINAL_BRAND_LOGOS: Record<string, string> = {
  ETH: "/stock-logos-original/ETH.svg",
  NVDA: "/stock-logos-original/NVDA.svg",
  SPCX: "/stock-logos-original/SPCX.svg",
  GOOGL: "/stock-logos-original/GOOGL.svg",
  TSLA: "/stock-logos-original/TSLA.svg",
  AAPL: "/stock-logos-original/AAPL.svg",
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
        // Logos are checked into the app so the launch selector never depends
        // on a browser reaching a third-party CDN.
        imageUrl:
          ORIGINAL_BRAND_LOGOS[symbol] ??
          `/api/robinhood/logo?symbol=${encodeURIComponent(symbol)}&v=5`,
      };
    })
    .filter((item) => !search || `${item.symbol} ${item.name}`.toLowerCase().includes(search))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .slice(0, 250);

  if (!search || "eth ethereum ether".includes(search)) {
    stocks.unshift({
      symbol: "ETH",
      name: "Ether",
      type: "crypto",
      imageUrl: ORIGINAL_BRAND_LOGOS.ETH,
    });
  }

  return NextResponse.json(
    { stocks },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
  );
}

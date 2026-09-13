"use client";

import { Activity } from "lucide-react";
import type { Address } from "viem";
import { useTokenHolders } from "@/lib/events";
import { bpsToPercent, formatUsd } from "@/lib/format";
import { useEthUsdPrice } from "@/lib/price";
import { usePoolVolume24h } from "@/lib/volume";

export function StatsCard({
  token,
  pool,
  chainId,
  marketCapEth,
  onCurve = false,
  progressBps = 0n,
  volume24Usd: initialVolume24Usd,
  isV4 = false,
  startBlock,
  variant = "card",
}: {
  token: Address;
  /** Live Uniswap pool address, used to look up 24h volume. */
  pool?: Address;
  /** Chain id, used to resolve the GeckoTerminal network for the volume lookup. */
  chainId: number;
  /** fully-diluted valuation in ETH (float) */
  marketCapEth: number;
  /** True while the token is in the pre-migration bonding-curve phase. */
  onCurve?: boolean;
  /** Curve progress toward the fill/migration price, 0–10000 bps (only when onCurve). */
  progressBps?: bigint;
  /** Feed snapshot shown immediately while the per-pool request refreshes. */
  volume24Usd?: number;
  isV4?: boolean;
  startBlock?: bigint;
  /** "card": sidebar box with heading. "strip": horizontal row for the page top. */
  variant?: "card" | "strip";
}) {
  // Disabled observer: reads the shared cache after the user explicitly loads
  // the Holders tab, without starting the expensive history scan itself.
  const { holders, unavailable: holdersUnavailable } = useTokenHolders(
    token,
    isV4 ? "v4" : undefined,
    false,
    startBlock,
  );
  const { usd: ethUsd } = useEthUsdPrice();
  const liveVolume24Usd = usePoolVolume24h(chainId, pool);
  const volume24Usd = liveVolume24Usd ?? initialVolume24Usd ?? 0;

  const marketCapUsd = ethUsd !== null ? marketCapEth * ethUsd : null;

  const rows: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: "Market Cap",
      // USD headline; fall back to the ETH-denominated FDV if the feed is down.
      value:
        marketCapEth <= 0
          ? "…"
          : marketCapUsd !== null
            ? formatUsd(marketCapUsd)
            : `${marketCapEth.toLocaleString("en-US", { maximumFractionDigits: 2 })} ETH`,
    },
    {
      label: "Volume 24h",
      value: volume24Usd > 0 ? formatUsd(volume24Usd) : "$0",
    },
    {
      label: "Holders",
      value: holdersUnavailable ? "n/a" : holders.length > 0 ? holders.length.toString() : "—",
    },
  ];

  // Horizontal strip (exchange-style): one row of stats above the chart.
  if (variant === "strip") {
    return (
      <div className="card grid grid-cols-3 sm:divide-x sm:divide-neutral-800/70">
        {rows.map((row) => (
          <div key={row.label} className="px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              {row.label}
            </p>
            <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-neutral-100 sm:text-[26px]">
              {row.value}
            </p>
            {row.sub && (
              <p className="mt-0.5 font-mono text-[10px] tabular-nums text-neutral-600">{row.sub}</p>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 font-bold text-neutral-100">
        <Activity className="h-4 w-4 text-amber-500" />
        Stats
      </h3>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              {row.label}
            </p>
            <p className="mt-1 font-mono text-xl font-bold tabular-nums text-neutral-100">{row.value}</p>
            {row.sub && (
              <p className="mt-0.5 font-mono text-[10px] tabular-nums text-neutral-500">{row.sub}</p>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-neutral-600">
        {onCurve
          ? `Live on Uniswap · ${bpsToPercent(progressBps)} of the curve sold toward bond.`
          : "Price & market cap from the Uniswap V3 pool. Live on Uniswap."}
      </p>
    </div>
  );
}

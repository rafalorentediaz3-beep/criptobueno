"use client";

import { CandlestickChart, ExternalLink, Sprout } from "lucide-react";
import { useState } from "react";
import { decodeEventLog, parseAbiItem } from "viem";
import type { Address, Hex } from "viem";
import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { usePad } from "@/lib/hooks";
import {
  GECKOTERMINAL_NETWORKS,
  ZERO_ADDRESS,
  geckoTerminalPoolUrl,
  uniswapSwapUrl,
} from "@/lib/config";
import { bpsToPercent } from "@/lib/format";
import { useGeckoIndexed } from "@/lib/useGeckoIndexed";
import { ProgressBar } from "@/components/ProgressBar";
import { priceWethPerToken, tokenIsToken0 } from "@/lib/pool";
import { V4_POOL_MANAGER_ADDRESSES } from "@/lib/config";

const v4SwapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
);

/**
 * Price chart for a PotatoPad token. Every token — curve or direct — trades on a
 * real Uniswap V3 pool from block one, so we always embed the GeckoTerminal pool
 * chart (falling back to a "trades on Uniswap" placeholder on networks GT doesn't
 * index yet). Curve tokens additionally get a bonding-curve progress bar UNDER the
 * chart: pre-bond it climbs toward 100%, and once bonded it reads full / locked.
 */
export function TokenChart({
  token,
  pool,
  poolId,
  priceWeth = 0,
  isCurve = false,
  isV4 = false,
  bonded = false,
  progressBps = 0n,
}: {
  token: Address;
  pool: Address;
  poolId?: Hex;
  /** Current WETH price, refreshed by the parent pool query. */
  priceWeth?: number;
  /** True when this token launched on the bonding-curve pad. */
  isCurve?: boolean;
  /** True when this token trades through a Uniswap V4 PoolManager pool. */
  isV4?: boolean;
  /** True once the curve bonded (LP permanently locked). */
  bonded?: boolean;
  /** Curve progress toward bond, 0–10000 bps (100% once bonded). */
  progressBps?: bigint;
}) {
  const { chainId } = usePad();
  const client = usePublicClient();
  const [range, setRange] = useState<"1H" | "6H" | "1D">("1D");
  const hasPool = pool !== ZERO_ADDRESS && !isV4;
  // Only embed once GeckoTerminal has actually indexed the pool; a brand-new
  // pool would otherwise render GT's own 404 inside the iframe. Flips to the
  // chart automatically once GT catches up (the hook polls while missing).
  const geckoStatus = useGeckoIndexed(
    GECKOTERMINAL_NETWORKS[chainId],
    hasPool ? pool : undefined,
  );
  const embedUrl =
    hasPool && geckoStatus === "indexed" ? geckoTerminalPoolUrl(chainId, pool) : undefined;
  const indexing = hasPool && geckoStatus === "missing";
  // A bonded curve is 100% by definition, regardless of the live pool tick.
  const barBps = bonded ? 10_000n : progressBps;
  const v4Manager = V4_POOL_MANAGER_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  const v4HistoryQuery = useQuery({
    queryKey: ["v4-chart", chainId, poolId, range],
    enabled: isV4 && !!poolId && !!client,
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!client || !poolId) return [];
      const latest = await client.getBlockNumber();
      // Robinhood Chain produces a block roughly every ~0.1s (~10/s), not the
      // ~3s of most L2s/L1s a naive guess would assume — using that wrong
      // assumption made "1D" cover only ~48 real minutes and miss all swaps.
      const blocks = range === "1H" ? 36_000n : range === "6H" ? 216_000n : 864_000n;
      const logs = await client.getLogs({
        address: v4Manager,
        event: v4SwapEvent,
        args: { id: poolId },
        fromBlock: latest > blocks ? latest - blocks : 0n,
        toBlock: latest,
      });
      return logs
        .map((log) => {
          const decoded = decodeEventLog({ abi: [v4SwapEvent], data: log.data, topics: log.topics });
          return {
            block: log.blockNumber ?? 0n,
            price: priceWethPerToken(
              decoded.args.sqrtPriceX96,
              tokenIsToken0(token, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
            ),
          };
        })
        .filter((point) => point.price > 0);
    },
  });
  const v4Points = v4HistoryQuery.data ?? [];
  const chartPrices = v4Points.length > 0 ? v4Points.map((p) => p.price) : priceWeth > 0 ? [priceWeth] : [];
  const chartMin = Math.min(...chartPrices);
  const chartMax = Math.max(...chartPrices);
  const chartPath = chartPrices
    .map((value, index) => {
      const x = chartPrices.length === 1 ? 50 : (index / (chartPrices.length - 1)) * 100;
      const y = chartMax === chartMin ? 50 : 92 - ((value - chartMin) / (chartMax - chartMin)) * 84;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <section className="card p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-neutral-100">
          <CandlestickChart className="h-4 w-4 text-amber-500" />
          Price Chart
        </h2>
        {embedUrl && (
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">
            data by GeckoTerminal
          </span>
        )}
      </div>

      {embedUrl ? (
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <iframe
            title="GeckoTerminal pool chart"
            src={embedUrl}
            className="h-[420px] w-full"
            // Warm-tint the GeckoTerminal embed so its default palette reads on the
            // amber/potato theme (dark bg + sepia/hue-shift toward amber).
            style={{
              filter: "brightness(1) saturate(0.7) sepia(0.7) contrast(1.6) hue-rotate(-19deg)",
            }}
            frameBorder="0"
            allow="clipboard-write"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="flex h-56 flex-col items-center justify-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950 text-center">
          {indexing && (
            <>
              <CandlestickChart className="h-8 w-8 text-amber-500/60" aria-hidden />
              <p className="max-w-xs text-sm text-neutral-400">
                Fresh launch — GeckoTerminal is still indexing this pool. The chart appears here automatically within a few minutes. It's already live and tradable.
              </p>
            </>
          )}
          {isV4 && (
            <div className="w-full max-w-3xl rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-left shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-sm text-amber-400">
                  {priceWeth > 0 ? `${priceWeth.toFixed(12)} WETH` : "Loading price…"}
                </span>
                <div className="flex gap-1">
                  {(["1H", "6H", "1D"] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setRange(item)}
                      className={`rounded px-2 py-1 text-[10px] ${range === item ? "bg-amber-500 text-black" : "bg-neutral-800 text-neutral-400"}`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
              <svg viewBox="0 0 100 100" className="h-44 w-full" role="img" aria-label="V4 price chart">
                <path d="M 0 92 H 100 M 0 50 H 100 M 0 8 H 100" stroke="#27272a" strokeWidth="0.5" />
                {chartPath && <path d={chartPath} fill="none" stroke="#f2b90f" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
              </svg>
            </div>
          )}
          {!isV4 && !indexing && (
            <p className="max-w-xs text-sm text-neutral-400">
              This token trades live on Uniswap V3. A price chart isn't indexed on this network yet.
            </p>
          )}
          <a
            href={uniswapSwapUrl(token, chainId)}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary px-3 py-1.5 text-xs"
          >
            Trade on Uniswap
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      {/* Bonding-curve progress — shown for every curve token, bonded or not. */}
      {isCurve && (
        <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-500">
              <Sprout className="h-3.5 w-3.5" />
              Bonding curve
            </span>
            <span className="text-[11px] font-medium text-neutral-400">
              {bonded ? "🎓 Bonded · LP locked" : "🌱 Bonding"}
            </span>
          </div>
          <ProgressBar bps={barBps} label={bpsToPercent(barBps)} />
          <p className="mt-2 text-[11px] text-neutral-600">
            {bonded
              ? "The curve filled and bonded — 100% of supply is a permanently locked Uniswap V3 position. Swap fees split 50/50 creator / treasury."
              : "It trades on Uniswap now; every buy walks the price up the curve. At 100% it bonds and the position stays locked forever."}
          </p>
        </div>
      )}
    </section>
  );
}

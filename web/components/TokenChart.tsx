"use client";

import { CandlestickChart, ExternalLink, Sprout } from "lucide-react";
import { useMemo, useState } from "react";
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
  const [interval, setIntervalOption] = useState<"Total" | "5m" | "15m">("Total");
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
  // Fixed, generous lookback so switching between Total/5m/15m never needs a
  // refetch — only the client-side bucketing below changes with `interval`.
  const FETCH_BLOCKS = 5_000_000n;
  const v4HistoryQuery = useQuery({
    queryKey: ["v4-chart", chainId, poolId],
    enabled: isV4 && !!poolId && !!client,
    // Poll every second so the candles feel truly live, like a real trading terminal.
    refetchInterval: 1_000,
    queryFn: async () => {
      if (!client || !poolId) return { points: [], latestTs: 0 };
      const latest = await client.getBlockNumber();
      const logs = await client.getLogs({
        address: v4Manager,
        event: v4SwapEvent,
        args: { id: poolId },
        fromBlock: latest > FETCH_BLOCKS ? latest - FETCH_BLOCKS : 0n,
        toBlock: latest,
      });
      const uniqueBlocks = Array.from(new Set(logs.map((log) => log.blockNumber ?? 0n)));
      const blockEntries = await Promise.all(
        uniqueBlocks.map(async (blockNumber) => {
          const block = await client.getBlock({ blockNumber });
          return [blockNumber, Number(block.timestamp)] as const;
        }),
      );
      const timestampByBlock = new Map(blockEntries);
      const latestBlock = await client.getBlock({ blockNumber: latest });
      const points = logs
        .map((log) => {
          const decoded = decodeEventLog({ abi: [v4SwapEvent], data: log.data, topics: log.topics });
          return {
            timestamp: timestampByBlock.get(log.blockNumber ?? 0n) ?? 0,
            price: priceWethPerToken(
              decoded.args.sqrtPriceX96,
              tokenIsToken0(token, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
            ),
          };
        })
        .filter((point) => point.price > 0)
        .sort((a, b) => a.timestamp - b.timestamp);
      return { points, latestTs: Number(latestBlock.timestamp) };
    },
  });
  const v4Points = v4HistoryQuery.data?.points ?? [];
  const latestTs = v4HistoryQuery.data?.latestTs ?? 0;

  // Bucket raw swap prices into fixed-width candles (Axiom/TradingView style):
  // open/close/high/low per bucket, green when it closed up, red when down.
  // Empty buckets (no trade that slice) carry the previous close forward flat,
  // so the chart reads as one continuous series instead of gaps.
  // "Total" spreads every trade evenly across the whole history; "5m"/"15m"
  // use real wall-clock candle widths over a trailing window, like a normal
  // trading terminal timeframe switch.
  const CANDLE_COUNT = 36;
  const VISIBLE_CANDLES = 48;
  const candles = useMemo(() => {
    type Candle = { open: number; high: number; low: number; close: number };
    if (v4Points.length === 0) return [] as Candle[];
    type Bucket = { open?: number; high: number; low: number; close?: number };
    let bucketCount: number;
    let bucketIndex: (timestamp: number) => number;
    if (interval === "Total") {
      const minTs = v4Points[0].timestamp;
      const maxTs = v4Points[v4Points.length - 1].timestamp;
      const span = Math.max(maxTs - minTs, 1);
      bucketCount = CANDLE_COUNT;
      bucketIndex = (ts) => Math.min(CANDLE_COUNT - 1, Math.max(0, Math.floor(((ts - minTs) / span) * CANDLE_COUNT)));
    } else {
      const intervalSeconds = interval === "5m" ? 300 : 900;
      const windowStart = latestTs - VISIBLE_CANDLES * intervalSeconds;
      bucketCount = VISIBLE_CANDLES;
      bucketIndex = (ts) => Math.min(VISIBLE_CANDLES - 1, Math.max(0, Math.floor((ts - windowStart) / intervalSeconds)));
    }
    const buckets: Bucket[] = Array.from({ length: bucketCount }, () => ({ high: -Infinity, low: Infinity }));
    for (const point of v4Points) {
      const idx = bucketIndex(point.timestamp);
      const bucket = buckets[idx];
      if (bucket.open === undefined) bucket.open = point.price;
      bucket.close = point.price;
      bucket.high = Math.max(bucket.high, point.price);
      bucket.low = Math.min(bucket.low, point.price);
    }
    let lastClose: number | undefined;
    const filled = buckets.map((bucket) => {
      if (bucket.open === undefined) {
        if (lastClose === undefined) return null;
        return { open: lastClose, high: lastClose, low: lastClose, close: lastClose };
      }
      lastClose = bucket.close;
      return { open: bucket.open, high: bucket.high, low: bucket.low, close: bucket.close! };
    });
    // Drop the leading gap before the first real trade in range.
    const firstReal = filled.findIndex((c) => c !== null);
    return firstReal === -1 ? [] : (filled.slice(firstReal) as Candle[]);
  }, [v4Points, interval, latestTs]);

  const candleMin = candles.length > 0 ? Math.min(...candles.map((c) => c.low)) : 0;
  const candleMax = candles.length > 0 ? Math.max(...candles.map((c) => c.high)) : 0;

  return (
    <section className="card p-4 pt-5 sm:p-6 sm:pt-6">
      <div className="mb-5 flex items-center justify-between">
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
      ) : isV4 ? (
        <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
          <div className="mb-2 flex items-center justify-end gap-1">
            {(["Total", "5m", "15m"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setIntervalOption(item)}
                className={`rounded px-2 py-1 text-[10px] ${interval === item ? "bg-amber-500 text-black" : "bg-neutral-800 text-neutral-400"}`}
              >
                {item}
              </button>
            ))}
          </div>
          {candles.length > 0 ? (
            <svg viewBox="0 0 100 100" className="h-64 w-full" role="img" aria-label="V4 candlestick chart">
              <path d="M 0 92 H 100 M 0 50 H 100 M 0 8 H 100" stroke="#27272a" strokeWidth="0.3" />
              {candles.map((candle, index) => {
                const slot = 100 / candles.length;
                const cx = slot * (index + 0.5);
                const bodyWidth = slot * 0.6;
                const scale = (value: number) =>
                  candleMax === candleMin ? 50 : 92 - ((value - candleMin) / (candleMax - candleMin)) * 84;
                const up = candle.close >= candle.open;
                const color = up ? "#22c55e" : "#ef4444";
                const yOpen = scale(candle.open);
                const yClose = scale(candle.close);
                const bodyTop = Math.min(yOpen, yClose);
                const bodyHeight = Math.max(Math.abs(yOpen - yClose), 0.6);
                return (
                  <g key={index}>
                    <line
                      x1={cx}
                      x2={cx}
                      y1={scale(candle.high)}
                      y2={scale(candle.low)}
                      stroke={color}
                      strokeWidth="0.4"
                    />
                    <rect
                      x={cx - bodyWidth / 2}
                      y={bodyTop}
                      width={bodyWidth}
                      height={bodyHeight}
                      fill={color}
                    />
                  </g>
                );
              })}
            </svg>
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-neutral-500">
              Waiting for the first trade…
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-56 flex-col items-center justify-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950 text-center">
          {indexing ? (
            <>
              <CandlestickChart className="h-8 w-8 text-amber-500/60" aria-hidden />
              <p className="max-w-xs text-sm text-neutral-400">
                Fresh launch — GeckoTerminal is still indexing this pool. The chart appears here automatically within a few minutes. It's already live and tradable.
              </p>
            </>
          ) : (
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

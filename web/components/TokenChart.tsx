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
  const { chainId, weth } = usePad();
  const client = usePublicClient();
  const [interval, setIntervalOption] = useState<"Total" | "5m" | "15m" | "1H" | "1D" | "1W">("Total");
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
    queryKey: ["v4-chart", chainId, poolId, weth],
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
            price: priceWethPerToken(decoded.args.sqrtPriceX96, tokenIsToken0(token, weth)),
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
  type Candle = { open: number; high: number; low: number; close: number };

  // Full-resolution candle series: for "Total" this is the whole history
  // squashed into CANDLE_COUNT buckets (no panning needed, you already see
  // everything). For "5m"/"15m" this is the *entire* trade history bucketed
  // at that real candle width — panning below just slides a viewing window
  // over it, Axiom-style, so scrolling left reveals older candles instead of
  // re-fetching anything.
  const { fullCandles, fullTimestamps } = useMemo(() => {
    if (v4Points.length === 0) return { fullCandles: [] as Candle[], fullTimestamps: [] as number[] };
    type Bucket = { open?: number; high: number; low: number; close?: number };
    const minTs = v4Points[0].timestamp;
    const maxTs = v4Points[v4Points.length - 1].timestamp;
    let bucketCount: number;
    let bucketWidth: number;
    let anchor: number;
    if (interval === "Total") {
      const span = Math.max(maxTs - minTs, 1);
      bucketCount = CANDLE_COUNT;
      bucketWidth = span / CANDLE_COUNT;
      anchor = minTs;
    } else {
      bucketWidth =
        interval === "5m" ? 300 : interval === "15m" ? 900 : interval === "1H" ? 3_600 : interval === "1D" ? 86_400 : 604_800;
      anchor = minTs;
      bucketCount = Math.max(VISIBLE_CANDLES, Math.floor((maxTs - minTs) / bucketWidth) + 1);
    }
    const bucketIndex = (ts: number) =>
      Math.min(bucketCount - 1, Math.max(0, Math.floor((ts - anchor) / bucketWidth)));
    const buckets: Bucket[] = Array.from({ length: bucketCount }, () => ({ high: -Infinity, low: Infinity }));
    for (const point of v4Points) {
      const bucket = buckets[bucketIndex(point.timestamp)];
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
    const firstReal = filled.findIndex((c) => c !== null);
    if (firstReal === -1) return { fullCandles: [] as Candle[], fullTimestamps: [] as number[] };
    const trimmed = filled.slice(firstReal) as Candle[];
    const timestamps = trimmed.map((_, i) => anchor + (firstReal + i + 0.5) * bucketWidth);
    return { fullCandles: trimmed, fullTimestamps: timestamps };
  }, [v4Points, interval]);

  // Pan offset in candles, counted back from the live edge (0 = latest).
  // Reset whenever the interval changes so switching timeframes always
  // starts at the live edge.
  const [panOffset, setPanOffset] = useState(0);
  const canPanForTimeframe = interval !== "Total";
  const maxPanOffset = canPanForTimeframe ? Math.max(0, fullCandles.length - VISIBLE_CANDLES) : 0;
  const clampedPan = Math.min(panOffset, maxPanOffset);
  const windowSize = canPanForTimeframe ? VISIBLE_CANDLES : fullCandles.length;
  const windowStart = Math.max(0, fullCandles.length - windowSize - clampedPan);
  const candles = fullCandles.slice(windowStart, windowStart + windowSize);
  const candleTimestamps = fullTimestamps.slice(windowStart, windowStart + windowSize);
  const atLiveEdge = clampedPan === 0;
  const atOldestEdge = clampedPan >= maxPanOffset;
  const panBack = () => setPanOffset((p) => Math.min(maxPanOffset, p + Math.round(VISIBLE_CANDLES / 2)));
  const panForward = () => setPanOffset((p) => Math.max(0, p - Math.round(VISIBLE_CANDLES / 2)));
  const goLive = () => setPanOffset(0);

  const rawCandleMin = candles.length > 0 ? Math.min(...candles.map((c) => c.low)) : 0;
  const rawCandleMax = candles.length > 0 ? Math.max(...candles.map((c) => c.high)) : 0;

  // Vertical (price / market-cap) zoom: 1 = fit the visible range exactly;
  // >1 narrows the range around its midpoint so candles read taller/bigger;
  // <1 widens it so candles read shorter/smaller — same idea as Axiom's
  // scroll-to-zoom on the price axis, exposed here as +/- buttons.
  const [zoomY, setZoomY] = useState(1);
  const zoomIn = () => setZoomY((z) => Math.min(8, z * 1.4));
  const zoomOut = () => setZoomY((z) => Math.max(0.25, z / 1.4));
  const zoomReset = () => setZoomY(1);
  const rawSpan = Math.max(rawCandleMax - rawCandleMin, rawCandleMax * 0.0005, 1e-18);
  const mid = (rawCandleMax + rawCandleMin) / 2;
  const half = rawSpan / 2 / zoomY;
  const candleMin = mid - half;
  const candleMax = mid + half;

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const hoverCandle = hoverIndex !== null ? candles[hoverIndex] : undefined;
  const formatPrice = (value: number) => `${value.toFixed(12)} WETH`;
  // Short axis label for a compact price tick, e.g. "0.0000000030".
  const formatAxisPrice = (value: number) => value.toFixed(10);
  const formatTime = (ts: number) => {
    if (ts <= 0) return "";
    const date = new Date(ts * 1000);
    if (interval === "1D" || interval === "1W" || interval === "Total") {
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  // 4 evenly spaced price ticks from top (high) to bottom (low) of the visible range.
  const priceTicks = useMemo(() => {
    if (candles.length === 0) return [] as number[];
    const steps = 4;
    return Array.from({ length: steps + 1 }, (_, i) => candleMax - (i / steps) * (candleMax - candleMin));
  }, [candleMin, candleMax, candles.length]);

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
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm text-amber-400">
                {hoverCandle ? formatPrice(hoverCandle.close) : priceWeth > 0 ? formatPrice(priceWeth) : "Loading price…"}
              </span>
              {/* Legend so the colors are self-explanatory without hovering. */}
              <span className="hidden items-center gap-3 text-[10px] text-neutral-500 sm:flex">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-sm bg-emerald-500" /> Price up
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-sm bg-rose-500" /> Price down
                </span>
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1">
              {/* Timeframe switch — same idea as Axiom's row of candle widths. */}
              <div className="flex gap-1">
                {(["Total", "5m", "15m", "1H", "1D", "1W"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setIntervalOption(item);
                      setPanOffset(0);
                    }}
                    className={`rounded px-2 py-1 text-[10px] ${interval === item ? "bg-amber-500 text-black" : "bg-neutral-800 text-neutral-400"}`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              {/* Pan controls: scroll back through history / jump back to live,
                  like dragging Axiom's chart left and right. */}
              <div className="flex items-center gap-1 border-l border-neutral-800 pl-1">
                <button
                  type="button"
                  onClick={panBack}
                  disabled={!canPanForTimeframe || atOldestEdge}
                  title="Older candles"
                  className="rounded bg-neutral-800 px-1.5 py-1 text-[10px] text-neutral-400 disabled:opacity-30"
                >
                  ◀
                </button>
                <button
                  type="button"
                  onClick={goLive}
                  disabled={!canPanForTimeframe || atLiveEdge}
                  title="Jump to live"
                  className="rounded bg-neutral-800 px-1.5 py-1 text-[9px] uppercase text-neutral-400 disabled:opacity-30"
                >
                  Live
                </button>
                <button
                  type="button"
                  onClick={panForward}
                  disabled={!canPanForTimeframe || atLiveEdge}
                  title="Newer candles"
                  className="rounded bg-neutral-800 px-1.5 py-1 text-[10px] text-neutral-400 disabled:opacity-30"
                >
                  ▶
                </button>
              </div>
              {/* Vertical zoom: squeeze/stretch the price (market cap) axis so
                  candles read bigger or smaller, same as scrolling on Axiom's
                  price axis. */}
              <div className="flex items-center gap-1 border-l border-neutral-800 pl-1">
                <button
                  type="button"
                  onClick={zoomOut}
                  title="Zoom out price axis"
                  className="rounded bg-neutral-800 px-1.5 py-1 text-[11px] text-neutral-400"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={zoomReset}
                  title="Reset zoom"
                  className="rounded bg-neutral-800 px-1.5 py-1 text-[9px] uppercase text-neutral-400"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={zoomIn}
                  title="Zoom in price axis"
                  className="rounded bg-neutral-800 px-1.5 py-1 text-[11px] text-neutral-400"
                >
                  +
                </button>
              </div>
            </div>
          </div>
          {candles.length > 0 ? (
            <div className="flex gap-2">
              {/* Y axis: price scale (WETH per token), high at top / low at bottom. */}
              <div className="flex w-24 flex-col justify-between py-1 text-right font-mono text-[9px] leading-none text-neutral-500">
                {priceTicks.map((tick, i) => (
                  <span key={i}>{formatAxisPrice(tick)}</span>
                ))}
              </div>
              <div className="min-w-0 flex-1">
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="h-64 w-full"
                  role="img"
                  aria-label="V4 candlestick chart: price in WETH over time, green candles closed higher, red closed lower"
                  onMouseLeave={() => setHoverIndex(null)}
                >
                  <defs>
                    <linearGradient id="chart-grid-fade" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3f3f46" stopOpacity="0.5" />
                      <stop offset="100%" stopColor="#3f3f46" stopOpacity="0.15" />
                    </linearGradient>
                  </defs>
                  {/* Horizontal gridlines aligned with the price ticks on the left. */}
                  {priceTicks.map((_, i) => (
                    <line
                      key={i}
                      x1="0"
                      x2="100"
                      y1={(i / (priceTicks.length - 1)) * 92 + 4}
                      y2={(i / (priceTicks.length - 1)) * 92 + 4}
                      stroke="url(#chart-grid-fade)"
                      strokeWidth="0.3"
                    />
                  ))}
                  {candles.map((candle, index) => {
                    const slot = 100 / candles.length;
                    const cx = slot * (index + 0.5);
                    const bodyWidth = slot * 0.55;
                    const scale = (value: number) =>
                      candleMax === candleMin ? 50 : 96 - ((value - candleMin) / (candleMax - candleMin)) * 88;
                    const up = candle.close >= candle.open;
                    const color = up ? "#10b981" : "#f43f5e";
                    const yOpen = scale(candle.open);
                    const yClose = scale(candle.close);
                    const bodyTop = Math.min(yOpen, yClose);
                    const bodyHeight = Math.max(Math.abs(yOpen - yClose), 0.8);
                    const isHovered = hoverIndex === index;
                    return (
                      <g
                        key={index}
                        onMouseEnter={() => setHoverIndex(index)}
                        onClick={() => setHoverIndex(index)}
                        className="cursor-pointer"
                        style={{ opacity: hoverIndex === null || isHovered ? 1 : 0.55 }}
                      >
                        {/* Wide invisible hit target so hovering/tapping anywhere in the
                            candle's slot selects it, not just the thin wick/body. */}
                        <rect x={cx - slot / 2} y={0} width={slot} height={100} fill="transparent" />
                        {isHovered && (
                          <line x1={cx} x2={cx} y1={0} y2={100} stroke="#71717a" strokeWidth="0.25" strokeDasharray="1.5,1.5" />
                        )}
                        <line
                          x1={cx}
                          x2={cx}
                          y1={scale(candle.high)}
                          y2={scale(candle.low)}
                          stroke={color}
                          strokeWidth="0.5"
                          strokeLinecap="round"
                        />
                        <rect
                          x={cx - bodyWidth / 2}
                          y={bodyTop}
                          width={bodyWidth}
                          height={bodyHeight}
                          rx={bodyWidth * 0.25}
                          fill={color}
                        />
                      </g>
                    );
                  })}
                </svg>
                {/* X axis: real clock time under a spread of candles. */}
                <div className="mt-1 flex justify-between font-mono text-[9px] text-neutral-500">
                  {candleTimestamps
                    .filter((_, i) => i % Math.max(1, Math.floor(candles.length / 6)) === 0)
                    .map((ts, i) => (
                      <span key={i}>{formatTime(ts)}</span>
                    ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-neutral-500">
              Waiting for the first trade…
            </div>
          )}
          {hoverCandle && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-neutral-400">
              <span>O {formatPrice(hoverCandle.open)}</span>
              <span>H {formatPrice(hoverCandle.high)}</span>
              <span>L {formatPrice(hoverCandle.low)}</span>
              <span>C {formatPrice(hoverCandle.close)}</span>
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

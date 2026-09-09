"use client";

import { CandlestickChart, ExternalLink, Sprout } from "lucide-react";
import { useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { usePublicClient } from "wagmi";
import { usePad } from "@/lib/hooks";
import {
  GECKOTERMINAL_NETWORKS,
  ZERO_ADDRESS,
  geckoTerminalPoolUrl,
  uniswapSwapUrl,
} from "@/lib/config";
import { bpsToPercent, formatUsd } from "@/lib/format";
import { useGeckoIndexed } from "@/lib/useGeckoIndexed";
import { useEthUsdPrice } from "@/lib/price";
import { useV4SwapHistory } from "@/lib/useV4SwapHistory";
import { ProgressBar } from "@/components/ProgressBar";
import { TOTAL_SUPPLY_WHOLE } from "@/lib/pool";

/**
 * Price chart for a PotatoPad token. Every token — curve or direct — trades on a
 * real Uniswap V3 pool from block one, so we always embed the GeckoTerminal pool
 * chart (falling back to a "trades on Uniswap" placeholder on networks GT doesn't
 * index yet). Curve tokens additionally get a bonding-curve progress bar UNDER the
 * chart: pre-bond it climbs toward 100%, and once bonded it reads full / locked.
 *
 * V4 tokens instead get a self-hosted live area chart (styled after Axiom /
 * pump.fun-style launchpad charts): a big market-cap number up top, a
 * timeframe switcher, a crosshair tooltip on hover, and pan/zoom controls so
 * you can scroll back through history and stretch the price axis.
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
  const [interval, setIntervalOption] = useState<"Total" | "5m" | "15m" | "1H" | "1D" | "1W">("Total");
  // How often the chart re-polls the chain for new swaps — selectable like
  // Axiom's refresh cadence, not tied to the candle timeframe above.
  const REFRESH_OPTIONS = { "15s": 15_000, "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 } as const;
  const [refreshLabel, setRefreshLabel] = useState<keyof typeof REFRESH_OPTIONS>("15s");
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

  const v4HistoryQuery = useV4SwapHistory(token, poolId, isV4 && !!client, REFRESH_OPTIONS[refreshLabel]);
  const v4Points = v4HistoryQuery.data?.points ?? [];
  const { usd: ethUsd } = useEthUsdPrice();

  // Bucket raw swap prices into fixed-width candles: open/close/high/low per
  // bucket. Empty buckets (no trade that slice) carry the previous close
  // forward flat, so the chart reads as one continuous series instead of
  // gaps. "Total" spreads every trade evenly across the whole history;
  // "5m"/"15m"/"1H"/"1D"/"1W" use real wall-clock candle widths, like a
  // normal trading terminal timeframe switch.
  const CANDLE_COUNT = 36;
  const VISIBLE_CANDLES = 48;
  type Candle = { open: number; high: number; low: number; close: number };

  // Full-resolution candle series: for "Total" this is the whole history
  // squashed into CANDLE_COUNT buckets (no panning needed, you already see
  // everything). For the real-width timeframes this is the *entire* trade
  // history bucketed at that width — panning below just slides a viewing
  // window over it, Axiom-style, so scrolling left reveals older candles
  // instead of re-fetching anything.
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
      // Safety cap: however wide the real span turns out to be, never try to
      // allocate more than this many buckets — a bad timestamp shouldn't be
      // able to freeze the tab by requesting millions of empty buckets.
      const MAX_BUCKETS = 20_000;
      bucketCount = Math.min(MAX_BUCKETS, Math.max(VISIBLE_CANDLES, Math.floor((maxTs - minTs) / bucketWidth) + 1));
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
  // >1 narrows the range around its midpoint so the line reads taller/bigger;
  // <1 widens it so it reads shorter/smaller — same idea as Axiom's
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
  const hoverTs = hoverIndex !== null ? candleTimestamps[hoverIndex] : undefined;

  const marketCap = (p: number) => p * TOTAL_SUPPLY_WHOLE;
  const formatBigUsd = (ethAmount: number) => (ethUsd ? formatUsd(ethAmount * ethUsd) : `${ethAmount.toFixed(8)} WETH`);
  const formatDateTime = (ts: number) =>
    ts && ts > 0
      ? new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
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

  // Trend color for the whole line/area, like most launchpad charts: green if
  // the visible window is up overall, red if down — not per-segment.
  const trendUp = candles.length > 1 ? candles[candles.length - 1].close >= candles[0].open : true;
  const lineColor = trendUp ? "#22c55e" : "#f43f5e";

  const scaleY = (value: number) =>
    candleMax === candleMin ? 50 : 96 - ((value - candleMin) / (candleMax - candleMin)) * 88;
  const linePoints = candles.map((candle, index) => {
    const slot = 100 / candles.length;
    return { x: slot * (index + 0.5), y: scaleY(candle.close) };
  });
  const linePath = linePoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaPath =
    linePoints.length > 0
      ? `${linePath} L ${linePoints[linePoints.length - 1].x} 100 L ${linePoints[0].x} 100 Z`
      : "";

  const displayPrice = hoverCandle ? hoverCandle.close : priceWeth;
  const displayTs = hoverCandle ? hoverTs : v4HistoryQuery.data?.latestTs;

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
        <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-4">
          {/* Big headline number, pump.fun/Axiom style: market cap (USD when we
              have a spot price, WETH otherwise) with a timestamp underneath. */}
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-mono text-2xl font-semibold text-neutral-50">
                {displayPrice > 0 ? formatBigUsd(marketCap(displayPrice)) : "Loading…"}
              </div>
              <div className="mt-0.5 text-[11px] text-neutral-500">
                {displayTs ? formatDateTime(displayTs) : "\u00A0"}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1">
              {/* Timeframe switch — same idea as Axiom's row of candle widths. */}
              <div className="flex gap-0.5 rounded-full bg-neutral-900 p-0.5">
                {(["Total", "5m", "15m", "1H", "1D", "1W"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setIntervalOption(item);
                      setPanOffset(0);
                    }}
                    className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors ${interval === item ? "bg-amber-500 text-black" : "text-neutral-400 hover:text-neutral-200"}`}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {candles.length > 0 ? (
            <div className="flex gap-2">
              {/* Y axis: price scale (market cap), high at top / low at bottom. */}
              <div className="flex w-20 flex-col justify-between py-1 text-right font-mono text-[9px] leading-none text-neutral-500">
                {priceTicks.map((tick, i) => (
                  <span key={i}>{formatBigUsd(marketCap(tick))}</span>
                ))}
              </div>
              <div className="relative min-w-0 flex-1">
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="h-64 w-full cursor-crosshair"
                  role="img"
                  aria-label="V4 area chart: market cap over time, green when the visible window is up, red when down"
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                    setHoverIndex(Math.min(candles.length - 1, Math.floor(pct * candles.length)));
                  }}
                  onMouseLeave={() => setHoverIndex(null)}
                >
                  <defs>
                    <linearGradient id="chart-grid-fade" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3f3f46" stopOpacity="0.5" />
                      <stop offset="100%" stopColor="#3f3f46" stopOpacity="0.15" />
                    </linearGradient>
                    <linearGradient id="chart-area-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={lineColor} stopOpacity="0.35" />
                      <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
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
                      strokeDasharray="1.5,1.5"
                    />
                  ))}
                  {areaPath && <path d={areaPath} fill="url(#chart-area-fill)" stroke="none" />}
                  {linePath && (
                    <path d={linePath} fill="none" stroke={lineColor} strokeWidth="0.8" strokeLinejoin="round" strokeLinecap="round" />
                  )}
                  {hoverIndex !== null && linePoints[hoverIndex] && (
                    <>
                      <line
                        x1={linePoints[hoverIndex].x}
                        x2={linePoints[hoverIndex].x}
                        y1={4}
                        y2={96}
                        stroke="#71717a"
                        strokeWidth="0.3"
                        strokeDasharray="1.5,1.5"
                      />
                      <circle cx={linePoints[hoverIndex].x} cy={linePoints[hoverIndex].y} r="1.2" fill={lineColor} />
                    </>
                  )}
                  {/* Live pulse dot at the latest point when looking at the live edge. */}
                  {atLiveEdge && linePoints.length > 0 && (
                    <circle
                      cx={linePoints[linePoints.length - 1].x}
                      cy={linePoints[linePoints.length - 1].y}
                      r="1"
                      fill={lineColor}
                    />
                  )}
                </svg>
                {/* Floating crosshair tooltip, positioned above the hovered point. */}
                {hoverIndex !== null && hoverCandle && linePoints[hoverIndex] && (
                  <div
                    className="pointer-events-none absolute top-1 -translate-x-1/2 rounded-md bg-neutral-800 px-2 py-1 text-[10px] shadow-lg"
                    style={{ left: `${linePoints[hoverIndex].x}%` }}
                  >
                    <div className="font-semibold text-neutral-100">{formatBigUsd(marketCap(hoverCandle.close))}</div>
                    <div className="text-neutral-400">{formatDateTime(candleTimestamps[hoverIndex])}</div>
                  </div>
                )}
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

          {/* Secondary controls row: refresh cadence, history pan, price zoom —
              kept compact/subtle below the chart so the headline number and
              timeframe pills stay the visual focus, like a real terminal. */}
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-neutral-800 pt-2 text-[10px] text-neutral-500">
            <div className="flex items-center gap-1">
              <span className="uppercase text-neutral-600">Refresh</span>
              {(Object.keys(REFRESH_OPTIONS) as Array<keyof typeof REFRESH_OPTIONS>).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setRefreshLabel(item)}
                  className={`rounded px-1.5 py-0.5 ${refreshLabel === item ? "bg-amber-500 text-black" : "bg-neutral-800 text-neutral-400"}`}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 border-l border-neutral-800 pl-3">
              <button
                type="button"
                onClick={panBack}
                disabled={!canPanForTimeframe || atOldestEdge}
                title="Older history"
                className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400 disabled:opacity-30"
              >
                ◀
              </button>
              <button
                type="button"
                onClick={goLive}
                disabled={!canPanForTimeframe || atLiveEdge}
                title="Jump to live"
                className="rounded bg-neutral-800 px-1.5 py-0.5 uppercase text-neutral-400 disabled:opacity-30"
              >
                Live
              </button>
              <button
                type="button"
                onClick={panForward}
                disabled={!canPanForTimeframe || atLiveEdge}
                title="Newer history"
                className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400 disabled:opacity-30"
              >
                ▶
              </button>
            </div>
            <div className="flex items-center gap-1 border-l border-neutral-800 pl-3">
              <span className="uppercase text-neutral-600">Zoom</span>
              <button type="button" onClick={zoomOut} title="Zoom out" className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">
                −
              </button>
              <button type="button" onClick={zoomReset} title="Reset zoom" className="rounded bg-neutral-800 px-1.5 py-0.5 uppercase text-neutral-400">
                Reset
              </button>
              <button type="button" onClick={zoomIn} title="Zoom in" className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">
                +
              </button>
            </div>
            <span className="ml-auto flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${trendUp ? "bg-emerald-500" : "bg-rose-500"}`} />
              {trendUp ? "Up" : "Down"} this window
            </span>
          </div>
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

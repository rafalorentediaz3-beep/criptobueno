"use client";

import Link from "next/link";
import { memo } from "react";
import { type Address } from "viem";
import { formatUsd, timeAgo } from "@/lib/format";
import { useEthUsdPrice } from "@/lib/price";
import { TokenAvatar } from "@/components/TokenAvatar";

export interface TokenRow {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  /** The planter's profile name. Falls back to their short address when absent. */
  creatorName?: string;
  pool: Address;
  /** WETH per whole token (float); null when price is unknown / failed. */
  priceWeth: number | null;
  /** fully-diluted valuation in ETH; null when price unknown. */
  marketCapEth: number | null;
  /** TokenCreated block timestamp (unix seconds); undefined if history unavailable */
  createdAt?: number;
  /** launch image URL / ipfs hash from TokenCreated (optional) */
  imageURI?: string;
  /** Ancient (pre-existing Robinhood) token — renders USD stats + an Ancient badge. */
  ancient?: boolean;
  /** Ancient market cap (USD) from GeckoTerminal. */
  marketCapUsd?: number;
  /** 24h volume (USD) from GeckoTerminal / feed. */
  volume24Usd?: number;
  /** Launched on the bonding-curve pad. */
  curve?: boolean;
  /** A curve token that has bonded (position locked into the fee locker). */
  bonded?: boolean;
  /** Curve progress toward the bond price, 0–10000 bps (only for pre-bond curve tokens). */
  curveProgressBps?: bigint;
  /** unix ms of the latest live-observed buy (pool Swap watch) — drives the
   *  "Recent buys" recency sort and the card's buy flash. */
  lastBuyAt?: number;
}

const cardShell =
  "group card-enter relative flex flex-col overflow-hidden rounded-[28px] bg-neutral-900/40 ring-1 ring-white/[0.07] backdrop-blur-sm transition-all duration-300 ease-out hover:-translate-y-1.5 hover:bg-neutral-900/80 hover:shadow-[0_20px_60px_-25px_rgba(0,0,0,0.7)] hover:ring-white/[0.14]";

/** Small rounded-pill badge used for the top-of-image tags (Ancient / Graduated / time). */
const badge =
  "rounded-full bg-black/55 px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-wider text-neutral-200 backdrop-blur-md";

/** A buy observed within this window renders the flash + "bought" chip. */
const BUY_FLASH_WINDOW_MS = 10_000;

function TokenCardImpl({
  row,
  /** When true, omit the planter profile link (e.g. already on that profile). */
  hideCreatorLink = false,
}: {
  row: TokenRow;
  hideCreatorLink?: boolean;
}) {
  const { usd: ethUsd } = useEthUsdPrice();

  const mcapUsd = row.ancient
    ? (row.marketCapUsd ?? 0)
    : ethUsd !== null && row.marketCapEth != null && row.marketCapEth > 0
      ? row.marketCapEth * ethUsd
      : 0;
  const mc = mcapUsd > 0 ? formatUsd(mcapUsd) : "—";

  // ── Ancient card: image, name, MC + 24h VOL, Ancient tag ──
  if (row.ancient) {
    const vol = row.volume24Usd && row.volume24Usd > 0 ? formatUsd(row.volume24Usd) : "—";
    return (
      <Link href={`/token/${row.address}`} className={cardShell} data-flip-key={row.address}>
        <div className="relative m-3 mb-0 overflow-hidden rounded-[20px]">
          <TokenAvatar address={row.address} symbol={row.symbol} imageURI={row.imageURI} fill />
          <span className={`absolute left-2 top-2 ${badge}`}>Ancient</span>
        </div>
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="space-y-1">
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-neutral-100">
              {row.name || row.symbol}
            </h3>
            <div className="font-mono text-[11px] uppercase tracking-wider text-neutral-500">
              ${row.symbol}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-white/5 pt-2.5 font-mono text-[13px]">
            <span className="text-neutral-100">
              {mc} <span className="text-[10px] font-normal text-neutral-500">MC</span>
            </span>
            <span className="text-neutral-500">
              {vol} <span className="text-[10px] font-normal text-neutral-600">VOL</span>
            </span>
          </div>
        </div>
      </Link>
    );
  }

  // ── PotatoPad card: sibling token + creator destinations (no nested anchors) ──
  // Bonding-curve progress is shown ONLY for a curve token that hasn't bonded yet.
  // Direct-pad coins have no curve at all, and a bonded coin is already done —
  // neither shows a bonding progress bar.
  // A curve that reached 100% shows as migrated whether or not the on-chain
  // bond() latch has fired yet: the keeper (scripts/bond-keeper.ts) latches
  // crossings within seconds, so surfacing the in-between state to users is
  // noise. Pre-100% curves keep the progress bar.
  const migrated =
    !!row.curve && (row.bonded || Number(row.curveProgressBps ?? 0n) >= 10_000);
  const onCurve = !!row.curve && !migrated;
  const progress = onCurve ? Math.max(0, Math.min(100, Number(row.curveProgressBps ?? 0n) / 100)) : 0;
  // Keyed by the buy timestamp: a fresh buy remounts the flash/chip so the
  // (self-limiting) animations replay on back-to-back buys.
  const freshBuy =
    row.lastBuyAt !== undefined && Date.now() - row.lastBuyAt < BUY_FLASH_WINDOW_MS;

  return (
    <article className={cardShell} data-flip-key={row.address}>
      {freshBuy && <span key={`ring-${row.lastBuyAt}`} aria-hidden className="buy-flash-ring" />}
      <Link
        href={`/token/${row.address}`}
        className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/60"
      >
        <div className="relative m-3 mb-0 overflow-hidden rounded-[20px]">
          <TokenAvatar address={row.address} symbol={row.symbol} imageURI={row.imageURI} fill />
          {/* Only migration earns a badge; a bonding curve is already told by its
              progress bar, and "Live" said nothing at all. */}
          {migrated && (
            <span className={`absolute left-2 top-2 ${badge} bg-amber-400/90 text-neutral-900`}>
              Graduated
            </span>
          )}
          {row.createdAt !== undefined && row.createdAt > 0 && (
            <span className={`absolute right-2 top-2 ${badge} normal-case tracking-normal`}>
              {timeAgo(row.createdAt)}
            </span>
          )}
          {freshBuy && (
            <span key={`chip-${row.lastBuyAt}`} aria-hidden className="buy-chip">
              bought
            </span>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-3 p-4 pb-3.5">
          <div className="space-y-1">
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-neutral-100">
              {row.name}
            </h3>
            <div className="font-mono text-[11px] uppercase tracking-wider text-neutral-500">
              ${row.symbol}
            </div>
          </div>
          <div className="mt-auto flex flex-col gap-2 border-t border-white/5 pt-2.5">
            <div className="flex items-center justify-between font-mono text-[13px]">
              <span className="text-neutral-100">
                {mc} <span className="text-[10px] font-normal text-neutral-500">MC</span>
              </span>
              {onCurve && (
                <span className="tabular-nums text-neutral-500">{progress.toFixed(0)}%</span>
              )}
            </div>
            {/* Pre-bond curve token: show the bonding progress as a slim, minimal line. */}
            {onCurve && (
              <div className="h-[4px] w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-amber-400 transition-[width] duration-500"
                  style={{ width: `${Math.max(2, progress)}%` }}
                />
              </div>
            )}
          </div>
        </div>
      </Link>
    </article>
  );
}

/**
 * Discover renders dozens of these per tab/sort switch and per periodic price
 * refetch (pool reads every 60s, buy-watch every 10s). Most of those ticks
 * leave any given card's own fields unchanged (its price/volume/etc. didn't
 * move), so a field-level comparison — instead of the default shallow prop
 * check — skips re-rendering (and re-measuring, for the FLIP grid animation)
 * cards whose visible data is identical, which is what made sort/tab clicks
 * and typing in search feel laggy on a full grid.
 */
function rowsEqual(a: TokenRow, b: TokenRow): boolean {
  return (
    a.address === b.address &&
    a.name === b.name &&
    a.symbol === b.symbol &&
    a.creator === b.creator &&
    a.creatorName === b.creatorName &&
    a.pool === b.pool &&
    a.priceWeth === b.priceWeth &&
    a.marketCapEth === b.marketCapEth &&
    a.createdAt === b.createdAt &&
    a.imageURI === b.imageURI &&
    a.ancient === b.ancient &&
    a.marketCapUsd === b.marketCapUsd &&
    a.volume24Usd === b.volume24Usd &&
    a.curve === b.curve &&
    a.bonded === b.bonded &&
    a.curveProgressBps === b.curveProgressBps &&
    a.lastBuyAt === b.lastBuyAt
  );
}

export const TokenCard = memo(
  TokenCardImpl,
  (prev, next) =>
    prev.hideCreatorLink === next.hideCreatorLink && rowsEqual(prev.row, next.row),
);

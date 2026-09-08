"use client";

import { Hourglass, Search, Sprout } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useReadContracts } from "wagmi";
import { potatoCurvePadAbi } from "@/lib/abi";
import { WETH_ADDRESSES, ZERO_ADDRESS, isMigrated } from "@/lib/config";
import { useAncientTokens } from "@/lib/ancient";
import { useRecentBuys } from "@/lib/buys";
import { useLaunchActivity } from "@/lib/events";
import { usePad } from "@/lib/hooks";
import {
  priceWethPerToken,
  tokenIsToken0,
  uniswapV3PoolAbi,
  TOTAL_SUPPLY_WHOLE,
} from "@/lib/pool";
import { ANALYTICS_CHAIN_ID } from "@/lib/robinhoodPublicClient";
import { useProfiles } from "@/lib/profile/useProfile";
import { useFlipGrid } from "@/lib/useFlip";
import { NotDeployed } from "@/components/NotDeployed";
import { useSearch } from "@/components/SearchContext";
import { TokenCard, type TokenRow } from "@/components/TokenCard";

/** Discover feed is Robinhood-pinned; price with RH WETH, not wallet-chain WETH. */
const RH_WETH = WETH_ADDRESSES[ANALYTICS_CHAIN_ID] ?? ZERO_ADDRESS;

type TabId = "growing" | "ancient";
type SortId = "recent" | "new" | "old" | "mcap";

const TABS: { id: TabId; label: string }[] = [
  { id: "growing", label: "Growing" },
  { id: "ancient", label: "Ancients" },
];
const SORTS: { id: SortId; label: string }[] = [
  { id: "recent", label: "Recent buys" },
  { id: "new", label: "Newest" },
  { id: "old", label: "Oldest" },
  { id: "mcap", label: "Market Cap" },
];

type Slot0 = readonly [bigint, number, number, number, number, number, boolean];

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900">
      <div className="skeleton aspect-square w-full rounded-none" />
      <div className="space-y-2 p-4">
        <div className="skeleton h-3 w-2/3" />
        <div className="skeleton h-3 w-1/2" />
      </div>
    </div>
  );
}

export default function DiscoverPage() {
  // `weth` is intentionally NOT taken from usePad: the feed is Robinhood-pinned,
  // so pricing uses RH_WETH rather than the connected wallet's chain WETH.
  const { chainId, curvePad, isDeployed } = usePad();
  const { query, setQuery } = useSearch();
  const [tab, setTab] = useState<TabId>("growing");
  const [sort, setSort] = useState<SortId>("recent");
  const isAncientTab = tab === "ancient";

  // PotatoPad launches — span ALL pads (curve + direct/legacy). Robinhood-pinned.
  const { creations, unavailable: launchUnavailable, isLoading: launchLoading } =
    useLaunchActivity();
  // Pre-existing Robinhood "ancient" runners (Noxa etc.), served by /api/ancient.
  const {
    tokens: ancientTokens,
    unavailable: ancientUnavailable,
    isLoading: ancientLoading,
  } = useAncientTokens();

  // Pass 1: curve metadata (curves + progress) for every creation. Non-curve
  // tokens return zeros (allowFailure) — harmless. 2 reads per token, index-aligned
  // so creation i is at [2i, 2i+1].
  const hasCurve = curvePad !== ZERO_ADDRESS && creations.some((c) => c.kind === "curve");
  const curveContracts = useMemo(
    () =>
      creations.flatMap((c) => [
        { address: curvePad, abi: potatoCurvePadAbi, functionName: "curves", args: [c.token] },
        { address: curvePad, abi: potatoCurvePadAbi, functionName: "curveProgressBps", args: [c.token] },
      ]),
    [creations, curvePad],
  );
  const { data: curveReads } = useReadContracts({
    contracts: curveContracts as never[],
    allowFailure: true,
    query: { enabled: isDeployed && hasCurve },
  });

  // The Uniswap pool to price each token from. Curve tokens (single-sided-v3) have
  // a live pool from block one — pre- AND post-migration — so use curves().pool;
  // direct tokens use their own pool from the creation event.
  const effectivePools = useMemo<Address[]>(
    () =>
      creations.map((c, i) => {
        if (c.kind === "curve") {
          const cv = curveReads?.[2 * i]?.result as
            | readonly [Address, Address, bigint, bigint, boolean]
            | undefined;
          return cv?.[1] ?? c.pool ?? ZERO_ADDRESS;
        }
        return c.pool ?? ZERO_ADDRESS;
      }),
    [creations, curveReads],
  );

  // Pass 2: pool slot0 for each effective pool, index-aligned to `creations`.
  // Priced with RH_WETH so a wallet on another chain doesn't mis-price RH pools.
  const poolContracts = useMemo(
    () =>
      effectivePools.map((address) => ({
        address,
        abi: uniswapV3PoolAbi,
        functionName: "slot0" as const,
        chainId: ANALYTICS_CHAIN_ID,
      })),
    [effectivePools],
  );

  const { data: poolReads, refetch: refetchPoolReads } = useReadContracts({
    contracts: poolContracts as never[],
    allowFailure: true,
    query: {
      enabled: isDeployed && effectivePools.some((p) => p !== ZERO_ADDRESS),
      // These ~39 pool reads multiply per visitor. Hold them 60s and don't refetch on
      // every window focus, to cut proxy/RPC load.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  });

  // Live buys: ONE Swap filter spans every pool (constant RPC cost). A buy
  // bumps its token to the front of "Recent buys" and refreshes pool prices
  // right away instead of on the slow 60s cadence.
  const buyPairs = useMemo(
    () =>
      creations
        .map((c, i) => ({ token: c.token, pool: effectivePools[i] ?? ZERO_ADDRESS }))
        .filter((p) => p.pool !== ZERO_ADDRESS),
    [creations, effectivePools],
  );
  const { lastBuyAt } = useRecentBuys(buyPairs, () => {
    void refetchPoolReads();
  });

  const creatorAddresses = useMemo(() => creations.map((c) => c.creator), [creations]);
  // ONE batched request resolves every planter name on this page, never one per card.
  const { data: creatorProfiles } = useProfiles(creatorAddresses);

  const padRows = useMemo<TokenRow[]>(
    () =>
      creations.map((c, i) => {
        const isCurveTok = c.kind === "curve";
        const cv = curveReads?.[2 * i]?.result as
          | readonly [Address, Address, bigint, boolean]
          | undefined;
        const curveProg = curveReads?.[2 * i + 1]?.result as bigint | undefined;
        const bonded = isCurveTok ? isMigrated(c.token, cv?.[3] ?? false) : true;
        const onCurve = isCurveTok && !bonded;

        // Curve tokens have a live pool from block one, so every token prices
        // from its pool's slot0 — continuous across migration.
        const slot0 = poolReads?.[i]?.result as Slot0 | undefined;
        const sqrtPriceX96 = slot0?.[0];
        // Failed / missing slot0 → null (never coerce unknown price to 0 ETH).
        let priceWeth: number | null = null;
        if (sqrtPriceX96 !== undefined && sqrtPriceX96 > 0n) {
          const p = priceWethPerToken(sqrtPriceX96, tokenIsToken0(c.token, RH_WETH));
          priceWeth = Number.isFinite(p) && p > 0 ? p : null;
        }
        return {
          address: c.token,
          name: c.name,
          symbol: c.symbol,
          creator: c.creator,
          creatorName: creatorProfiles?.[c.creator.toLowerCase()]?.username,
          // Curve tokens price from curves().pool; direct tokens from the event pool.
          pool: effectivePools[i],
          priceWeth,
          marketCapEth: priceWeth != null ? priceWeth * TOTAL_SUPPLY_WHOLE : null,
          createdAt: c.timestamp,
          imageURI: c.imageURI,
          volume24Usd: c.volume24Usd,
          lastBuyAt: lastBuyAt(c.token),
          curve: isCurveTok,
          bonded,
          curveProgressBps: onCurve ? (curveProg ?? 0n) : undefined,
        };
      }),
    [creations, curveReads, poolReads, effectivePools, creatorProfiles, lastBuyAt],
  );

  const ancientRows = useMemo<TokenRow[]>(
    () =>
      ancientTokens.map((t) => ({
        address: t.address,
        name: t.name,
        symbol: t.symbol,
        creator: ZERO_ADDRESS,
        pool: t.tradePool,
        priceWeth: null,
        marketCapEth: null,
        imageURI: t.imageUrl,
        ancient: true,
        marketCapUsd: t.fdvUsd,
        volume24Usd: t.volume24Usd,
      })),
    [ancientTokens],
  );

  const activeRows = isAncientTab ? ancientRows : padRows;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = activeRows;
    if (q) {
      const isAddressQuery = q.startsWith("0x");
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.symbol.toLowerCase().includes(q) ||
          (isAddressQuery && r.address.toLowerCase().startsWith(q)),
      );
    }
    if (isAncientTab) {
      return [...list].sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
    }
    switch (sort) {
      case "recent":
        // Live buys first (most recent wins); tokens with no observed buy keep
        // the 24h-volume order so first paint matches the previous behavior.
        return [...list].sort((a, b) => {
          const ba = a.lastBuyAt ?? 0;
          const bb = b.lastBuyAt ?? 0;
          if (bb !== ba) return bb - ba;
          return (b.volume24Usd ?? 0) - (a.volume24Usd ?? 0);
        });
      case "new":
        return [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      case "old":
        return [...list].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      case "mcap":
        // Null FDVs sort last (unknown ≠ zero).
        return [...list].sort((a, b) => (b.marketCapEth ?? -1) - (a.marketCapEth ?? -1));
      default:
        return list;
    }
  }, [activeRows, query, sort, isAncientTab]);

  // FLIP reorder animation: whenever the visible order changes (a live buy
  // bumping a card, a sort switch, a new launch), moved cards glide instead of
  // jumping. Keys are token addresses — stable across re-sorts.
  const visibleOrderKey = useMemo(() => visible.map((r) => r.address).join(","), [visible]);
  const gridRef = useFlipGrid<HTMLDivElement>(visibleOrderKey);

  if (!isDeployed) {
    return <NotDeployed chainId={chainId} />;
  }

  // Treat a soft-degraded scan (unavailable) as "still loading", not "empty", so a
  // transient RPC / cold-cache blip never flashes the empty state.
  const loading = isAncientTab
    ? (ancientLoading || ancientUnavailable) && ancientTokens.length === 0
    : (launchLoading || launchUnavailable) && creations.length === 0;

  const segBase =
    "rounded-full px-3.5 py-2 text-xs font-semibold tracking-tight transition-all";

  return (
    <div className="space-y-6">
      {/* Unified header + controls */}
      <div className="relative hidden md:block">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          type="search"
          aria-label="Search coins by name or symbol"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tokens"
          className="w-full rounded-full border border-neutral-800 bg-neutral-900 py-3.5 pl-11 pr-4 text-sm text-neutral-100 shadow-sm outline-none placeholder:text-neutral-500 focus:border-neutral-700 focus:ring-4 focus:ring-white/5"
        />
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-full border border-white/10 bg-white/5 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_24px_-18px_rgba(0,0,0,0.6)] backdrop-blur-xl">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`${segBase} ${
                  tab === t.id
                    ? "bg-neutral-800 text-neutral-100 shadow-[0_5px_14px_-8px_rgba(0,0,0,0.8)]"
                    : "text-neutral-500 hover:bg-white/10 hover:text-neutral-100"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {!isAncientTab && (
            <div className="flex flex-wrap gap-1 rounded-full border border-white/10 bg-white/5 p-1.5 font-mono shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_24px_-18px_rgba(0,0,0,0.6)] backdrop-blur-xl">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSort(s.id)}
                  className={`rounded-full px-3.5 py-2 text-[11px] transition-all ${
                  sort === s.id ? "bg-lime-500/20 text-lime-300 shadow-sm ring-1 ring-lime-500/30" : "text-neutral-500 hover:bg-white/10 hover:text-neutral-100"
                  }`}
                >
                  {s.id === "recent" && (
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-lime-500 align-middle" />
                  )}
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Mobile search — the header search bar is desktop-only (md:block). */}
      <div className="relative md:hidden">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
        <input
          type="search"
          aria-label="Search coins by name or symbol"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tokens"
          className="w-full rounded-full border border-neutral-800 bg-neutral-900 py-3 pl-11 pr-4 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-neutral-700 focus:ring-4 focus:ring-white/5"
        />
      </div>

      {/* Container panel: amber accent for Growing, stone-gray for Ancients */}
      <div
        className={`rounded-[28px] border bg-neutral-900 p-5 sm:p-7 ${
          isAncientTab
            ? "border-neutral-800 shadow-[0_18px_60px_-35px_rgba(0,0,0,0.5)]"
            : "border-lime-900/60 bg-gradient-to-br from-lime-950/40 via-neutral-900 to-neutral-900 shadow-[0_18px_60px_-35px_rgba(132,204,22,0.25)]"
        }`}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-neutral-100 sm:text-3xl">
              {isAncientTab ? "Ancient Heritage" : "Growing"}
              <span className="ml-2 inline-flex rounded-full bg-lime-500/20 px-2.5 py-1 align-middle text-xs font-medium text-lime-300">
                {activeRows.length}
              </span>
            </h1>
            <p className="mt-2 text-sm text-neutral-500">
              {isAncientTab ? "Verified legacy runners from Robinhood." : "Tokens still climbing toward graduation on Robinhood Chain."}
            </p>
          </div>
          <Link href="/create" className="hidden shrink-0 items-center gap-2 rounded-full bg-[linear-gradient(180deg,#ffd84a_0%,#f2b90f_48%,#d88a05_100%)] px-4 py-2.5 text-sm font-semibold text-[#3a2100] shadow-[inset_0_1px_0_rgba(255,255,218,0.7),0_4px_14px_-8px_rgba(180,108,0,0.9)] transition-all hover:brightness-110 sm:inline-flex">
            <span className="text-lg leading-none">+</span> Create
          </Link>
        </div>
        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : activeRows.length === 0 ? (
          <div className="mx-auto max-w-lg px-6 py-12 text-center">
            {isAncientTab ? (
              <>
                <Hourglass className="mx-auto h-10 w-10 text-amber-500/70" aria-hidden />
                <h2 className="mt-4 text-lg font-bold text-neutral-100">No ancient tokens yet</h2>
                <p className="mt-2 text-sm text-neutral-500">
                  Couldn&apos;t load the pre-existing Robinhood runners right now. Try again in a
                  moment.
                </p>
              </>
            ) : (
              <>
                <Sprout className="mx-auto h-10 w-10 text-green-500/70" aria-hidden />
                <h2 className="mt-4 text-lg font-bold text-neutral-100">Nothing planted yet</h2>
                <p className="mt-2 text-sm text-neutral-500">
                  Be the first to plant a coin. It launches straight onto Uniswap V3, live from the
                  first block.
                </p>
                <Link href="/create" className="btn-primary mt-5">
                  Plant the first coin
                </Link>
              </>
            )}
          </div>
        ) : visible.length === 0 ? (
          <div className="mx-auto max-w-lg px-6 py-12 text-center">
            <h2 className="text-lg font-bold text-neutral-100">No coins match</h2>
            <p className="mt-2 text-sm text-neutral-500">
              {query.trim()
                ? `Nothing matches “${query.trim()}” in this patch of the field.`
                : "Nothing in this patch of the field yet."}
            </p>
          </div>
        ) : (
          <div ref={gridRef} className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {visible.map((row) => (
              <TokenCard key={row.address} row={row} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

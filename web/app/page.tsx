"use client";

import { Heart, Hourglass, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { useReadContracts } from "wagmi";
import { potatoCurvePadAbi, potatoV4PadAbi } from "@/lib/abi";
import { V4_POOL_MANAGER_ADDRESSES, WETH_ADDRESSES, ZERO_ADDRESS, isMigrated } from "@/lib/config";
import { useAncientTokens } from "@/lib/ancient";
import { useRecentBuys } from "@/lib/buys";
import { useLaunchActivity } from "@/lib/events";
import { usePad } from "@/lib/hooks";
import {
  priceWethPerToken,
  tokenIsToken0,
  uniswapV3PoolAbi,
  uniswapV4PoolManagerAbi,
  v4PoolStateSlot,
  v4SqrtPriceFromSlot,
  TOTAL_SUPPLY_WHOLE,
} from "@/lib/pool";
import { ANALYTICS_CHAIN_ID } from "@/lib/robinhoodPublicClient";
import { useProfiles } from "@/lib/profile/useProfile";
import { useFlipGrid } from "@/lib/useFlip";
import { useEthUsdPrice } from "@/lib/price";
import { NotDeployed } from "@/components/NotDeployed";
import { useSearch } from "@/components/SearchContext";
import { TokenCard, type TokenRow } from "@/components/TokenCard";
import { TokenCarousel } from "@/components/TokenCarousel";

/** Discover feed is Robinhood-pinned; price with RH WETH, not wallet-chain WETH. */
const RH_WETH = WETH_ADDRESSES[ANALYTICS_CHAIN_ID] ?? ZERO_ADDRESS;

type TabId = "growing" | "ancient";
type SortId = "recent" | "new" | "old" | "mcap";

const TABS: { id: TabId; label: string }[] = [
  { id: "growing", label: "Coins" },
  { id: "ancient", label: "Ancients" },
];
const SORTS: { id: SortId; label: string }[] = [
  { id: "mcap", label: "Market Cap" },
  { id: "new", label: "Newest" },
  { id: "old", label: "Oldest" },
];

type Slot0 = readonly [bigint, number, number, number, number, number, boolean];

interface CachedMarketCap {
  eth: number;
  usd?: number;
  updatedAt: number;
}

const MARKET_CAP_CACHE_KEY = "potatopad:market-caps:v2";
const MARKET_CAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readMarketCapCache(): Record<string, CachedMarketCap> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MARKET_CAP_CACHE_KEY) ?? "{}") as Record<
      string,
      CachedMarketCap
    >;
    const cutoff = Date.now() - MARKET_CAP_CACHE_TTL_MS;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, value]) =>
          Number.isFinite(value?.eth) && value.eth > 0 && value.updatedAt >= cutoff,
      ),
    );
  } catch {
    return {};
  }
}

export default function DiscoverPage() {
  // `weth` is intentionally NOT taken from usePad: the feed is Robinhood-pinned,
  // so pricing uses RH_WETH rather than the connected wallet's chain WETH.
  const { chainId, curvePad, isDeployed } = usePad();
  const { query, setQuery } = useSearch();
  const [tab, setTab] = useState<TabId>("growing");
  const [sort, setSort] = useState<SortId>("mcap");
  const [cachedMarketCaps, setCachedMarketCaps] = useState<Record<string, CachedMarketCap>>({});
  const isAncientTab = tab === "ancient";
  const { usd: ethUsd } = useEthUsdPrice();

  useEffect(() => {
    setCachedMarketCaps(readMarketCapCache());
  }, []);

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

  // Direct-to-v4 launches have no pool contract address at all — v4 pools are
  // singleton-managed and identified by a bytes32 PoolId. Resolve each v4
  // creation's PoolId from the pad THAT LAUNCHED IT (c.pad) first (pass 1b) —
  // several superseded v4 pads remain live read-only (see legacyPads in
  // config.ts), so this can't use a single "current v4 pad" address — then
  // read that pool's packed Slot0 word straight off the PoolManager via
  // `extsload` (pass 2b). Same index-alignment trick as the curve reads: call
  // for every creation (harmless no-op for non-v4 kinds under allowFailure) so
  // array indices stay aligned to `creations` without a second bookkeeping pass.
  const v4Manager = V4_POOL_MANAGER_ADDRESSES[ANALYTICS_CHAIN_ID] ?? ZERO_ADDRESS;
  const hasV4 = v4Manager !== ZERO_ADDRESS && creations.some((c) => c.kind === "v4");
  const v4TokenReadIndexes = useMemo(
    () =>
      creations
        .map((c, i) => (c.kind === "v4" && !c.poolId ? i : -1))
        .filter((i) => i >= 0),
    [creations],
  );
  const v4TokenContracts = useMemo(
    () =>
      v4TokenReadIndexes.map((i) => ({
        address: creations[i].pad,
        abi: potatoV4PadAbi,
        functionName: "v4Tokens" as const,
        args: [creations[i].token],
      })),
    [creations, v4TokenReadIndexes],
  );
  const { data: v4TokenReads } = useReadContracts({
    contracts: v4TokenContracts as never[],
    allowFailure: true,
    query: { enabled: isDeployed && hasV4 && v4TokenContracts.length > 0 },
  });
  const resolvedV4PoolIds = useMemo(() => {
    const map = new Map<number, Hex>();
    v4TokenReadIndexes.forEach((creationIndex, readIndex) => {
      const info = v4TokenReads?.[readIndex]?.result as
        | readonly [Address, Hex, bigint, number]
        | undefined;
      if (info?.[0] && info[0] !== ZERO_ADDRESS) map.set(creationIndex, info[1]);
    });
    return map;
  }, [v4TokenReadIndexes, v4TokenReads]);

  // v4Tokens() => (creator, poolId, lpTokenId, feeTier); poolId undefined when
  // the creation isn't (yet) resolved as a v4 token — that read is skipped below.
  const ZERO_POOL_ID = `0x${"0".repeat(64)}` as Hex;
  const v4PoolIds = useMemo<(Hex | undefined)[]>(
    () =>
      creations.map((c, i) => {
        if (c.kind !== "v4") return undefined;
        return c.poolId ?? resolvedV4PoolIds.get(i);
      }),
    [creations, resolvedV4PoolIds],
  );
  const v4StateReadIndexes = useMemo(
    () => v4PoolIds.map((poolId, i) => (poolId ? i : -1)).filter((i) => i >= 0),
    [v4PoolIds],
  );
  const v4StateContracts = useMemo(
    () =>
      v4StateReadIndexes.map((i) => ({
        address: v4Manager,
        abi: uniswapV4PoolManagerAbi,
        functionName: "extsload" as const,
        args: [v4PoolStateSlot(v4PoolIds[i] ?? ZERO_POOL_ID)],
        chainId: ANALYTICS_CHAIN_ID,
      })),
    [v4PoolIds, v4StateReadIndexes, v4Manager],
  );
  const { data: v4StateReads } = useReadContracts({
    contracts: v4StateContracts as never[],
    allowFailure: true,
    query: { enabled: hasV4 && v4StateContracts.length > 0 },
  });
  const v4StateByCreationIndex = useMemo(() => {
    const map = new Map<number, Hex>();
    v4StateReadIndexes.forEach((creationIndex, readIndex) => {
      const stateWord = v4StateReads?.[readIndex]?.result as Hex | undefined;
      if (stateWord) map.set(creationIndex, stateWord);
    });
    return map;
  }, [v4StateReadIndexes, v4StateReads]);

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
  // V4 pools are resolved separately from their PoolManager state below.
  const poolReadIndexes = useMemo(
    () =>
      effectivePools
        .map((address, i) => (creations[i]?.kind !== "v4" && address !== ZERO_ADDRESS ? i : -1))
        .filter((i) => i >= 0),
    [creations, effectivePools],
  );
  const poolContracts = useMemo(
    () =>
      poolReadIndexes.map((i) => ({
        address: effectivePools[i],
        abi: uniswapV3PoolAbi,
        functionName: "slot0" as const,
        chainId: ANALYTICS_CHAIN_ID,
      })),
    [effectivePools, poolReadIndexes],
  );

  const { data: poolReads, refetch: refetchPoolReads } = useReadContracts({
    contracts: poolContracts as never[],
    allowFailure: true,
    query: {
      enabled: isDeployed && poolContracts.length > 0,
      // These ~39 pool reads multiply per visitor. Hold them 60s and don't refetch on
      // every window focus, to cut proxy/RPC load.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  });
  const poolSlot0ByCreationIndex = useMemo(() => {
    const map = new Map<number, Slot0>();
    poolReadIndexes.forEach((creationIndex, readIndex) => {
      const slot0 = poolReads?.[readIndex]?.result as Slot0 | undefined;
      if (slot0) map.set(creationIndex, slot0);
    });
    return map;
  }, [poolReadIndexes, poolReads]);

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

        // Curve and direct tokens have a live Uniswap V3 pool from block one,
        // so they price off its slot0. v4 launches have no pool contract at
        // all — their price comes from the PoolManager's packed Slot0 word
        // (read via extsload against the resolved PoolId) instead.
        let sqrtPriceX96: bigint | undefined;
        if (c.kind === "v4") {
          const stateWord = v4StateByCreationIndex.get(i);
          sqrtPriceX96 = v4SqrtPriceFromSlot(stateWord);
        } else {
          const slot0 = poolSlot0ByCreationIndex.get(i);
          sqrtPriceX96 = slot0?.[0];
        }
        const cached = cachedMarketCaps[c.token.toLowerCase()];
        const quoteToken = c.quoteToken ?? RH_WETH;
        const isWethQuote = quoteToken.toLowerCase() === RH_WETH.toLowerCase();
        // Failed / missing live price falls back to the last valid snapshot so
        // returning visitors never wait on the RPC before seeing an FDV.
        let priceWeth: number | null = null;
        if (sqrtPriceX96 !== undefined && sqrtPriceX96 > 0n) {
          const priceQuote = priceWethPerToken(sqrtPriceX96, tokenIsToken0(c.token, quoteToken));
          if (isWethQuote) priceWeth = Number.isFinite(priceQuote) && priceQuote > 0 ? priceQuote : null;
        }
        const marketCapEth =
          isWethQuote && priceWeth != null
            ? priceWeth * TOTAL_SUPPLY_WHOLE
            : isWethQuote && c.marketCapEth > 0
              ? c.marketCapEth
              : isWethQuote ? (cached?.eth ?? null) : null;
        const marketCapUsd =
          c.marketCapUsd > 0
            ? c.marketCapUsd
            : isWethQuote && ethUsd !== null && marketCapEth != null
              ? marketCapEth * ethUsd
              : isWethQuote
                ? cached?.usd
                : undefined;
        return {
          address: c.token,
          name: c.name,
          symbol: c.symbol,
          creator: c.creator,
          creatorName: creatorProfiles?.[c.creator.toLowerCase()]?.username,
          // Curve tokens price from curves().pool; direct tokens from the event pool.
          pool: effectivePools[i],
          priceWeth: priceWeth ?? (marketCapEth ? marketCapEth / TOTAL_SUPPLY_WHOLE : null),
          marketCapEth,
          marketCapUsd,
          createdAt: c.timestamp,
          imageURI: c.imageURI,
          website: c.website,
          twitter: c.twitter,
          telegram: c.telegram,
          volume24Usd: c.volume24Usd,
          lastBuyAt: lastBuyAt(c.token),
          curve: isCurveTok,
          bonded,
          curveProgressBps: onCurve ? (curveProg ?? 0n) : undefined,
        };
      }),
    [
      creations,
      curveReads,
      poolSlot0ByCreationIndex,
      v4StateByCreationIndex,
      effectivePools,
      creatorProfiles,
      cachedMarketCaps,
      ethUsd,
      lastBuyAt,
    ],
  );

  useEffect(() => {
    if (padRows.length === 0) return;
    const now = Date.now();
    const next: Record<string, CachedMarketCap> = {};
    for (const row of padRows) {
      if (row.marketCapEth == null || !Number.isFinite(row.marketCapEth) || row.marketCapEth <= 0) {
        continue;
      }
      next[row.address.toLowerCase()] = {
        eth: row.marketCapEth,
        usd: row.marketCapUsd,
        updatedAt: now,
      };
    }
    if (Object.keys(next).length === 0) return;
    try {
      window.localStorage.setItem(MARKET_CAP_CACHE_KEY, JSON.stringify(next));
    } catch {
      // Storage is an acceleration only; live reads remain the source of truth.
    }
  }, [padRows]);

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
    // Keep the discover feed focused on launches with both core social links.
    let list = activeRows.filter(
      (row) => Boolean(row.twitter?.trim()) && Boolean(row.website?.trim()),
    );
    if (q) {
      const isAddressQuery = q.startsWith("0x");
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.symbol.toLowerCase().includes(q) ||
          (isAddressQuery && r.address.toLowerCase().startsWith(q)),
      );
    }
    list = Array.from(
      list
        .reduce((unique, row) => {
          const key = row.address.toLowerCase();
          if (!unique.has(key)) unique.set(key, row);
          return unique;
        }, new Map<string, TokenRow>())
        .values(),
    );
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
        return [...list].sort((a, b) => {
          if (a.marketCapEth != null || b.marketCapEth != null) {
            return (b.marketCapEth ?? -1) - (a.marketCapEth ?? -1);
          }
          return (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1);
        });
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
    <div className="space-y-12">
      {/* Unified header + controls */}
      <div className="space-y-5 sm:space-y-6">
        <p
          className="hot-tagline text-center text-xl font-normal italic leading-none sm:text-2xl"
          style={{ fontFamily: 'Didot, "Bodoni MT", "Bodoni 72", Georgia, serif' }}
        >
          hot ideas born here.
        </p>

        <div className="relative hidden md:block">
          <Search className="pointer-events-none absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-neutral-600" />
          <input
            type="search"
            aria-label="Search coins by name or symbol"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tokens"
            style={{ colorScheme: "light" }}
            className="relative w-full appearance-none rounded-full border border-white/70 bg-white/60 py-3.5 pl-11 pr-4 text-sm font-medium text-neutral-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-18px_42px_rgba(255,255,255,0.18),0_16px_36px_-24px_rgba(15,23,42,0.65)] outline-none backdrop-blur-2xl backdrop-saturate-150 placeholder:font-semibold placeholder:text-neutral-600 focus:border-white focus:ring-4 focus:ring-white/20"
          />
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
      </div>

      <div
        className={
          isAncientTab
            ? "rounded-[28px] border border-neutral-800 bg-neutral-900 p-5 sm:p-7 shadow-[0_18px_60px_-35px_rgba(0,0,0,0.5)]"
            : "relative left-1/2 w-[calc(100vw-2rem)] max-w-[1560px] -translate-x-1/2 sm:w-[94vw]"
        }
      >
        <div className="mb-6 grid items-center gap-4 sm:grid-cols-[1fr_auto_1fr]">
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-neutral-100 sm:text-3xl">
              {isAncientTab ? (
                "Ancient Heritage"
              ) : (
                <span
                  className="font-normal italic"
                  style={{ fontFamily: 'Didot, "Bodoni MT", "Bodoni 72", Georgia, serif' }}
                >
                  Coins
                </span>
              )}
              {isAncientTab ? (
                <span
                  suppressHydrationWarning
                  className="ml-2 inline-flex rounded-full bg-[linear-gradient(180deg,#ffd84a_0%,#f2b90f_48%,#d88a05_100%)] px-2.5 py-1 align-middle text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,218,0.7),0_4px_10px_-6px_rgba(180,108,0,0.9)]"
                >
                  {activeRows.length}
                </span>
              ) : (
                <span
                  suppressHydrationWarning
                  className="ml-2 inline-flex items-center gap-1 rounded-full bg-[linear-gradient(180deg,#ff8fc7_0%,#ff4f9e_48%,#e6197a_100%)] px-2.5 py-1 align-middle text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,220,235,0.7),0_4px_10px_-6px_rgba(200,10,110,0.9)]"
                >
                  <Heart className="h-3 w-3 fill-white" aria-hidden />
                  {activeRows.length}
                </span>
              )}
            </h1>
            {isAncientTab && (
              <p className="mt-2 text-sm text-neutral-500">Verified legacy runners from Robinhood.</p>
            )}
          </div>
          {!isAncientTab && (
            <div className="flex w-fit flex-wrap gap-1 rounded-full border border-white/10 bg-white/5 p-1.5 font-mono shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_24px_-18px_rgba(0,0,0,0.6)] backdrop-blur-xl sm:justify-self-center">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSort(s.id)}
                  className={`rounded-full px-3.5 py-2 text-[11px] transition-all ${
                  sort === s.id ? "bg-[linear-gradient(180deg,#ffd84a_0%,#f2b90f_48%,#d88a05_100%)] text-white shadow-[inset_0_1px_0_rgba(255,255,218,0.7),0_4px_14px_-8px_rgba(180,108,0,0.9)]" : "text-neutral-500 hover:bg-white/10 hover:text-neutral-100"
                  }`}
                >
                  {s.id === "recent" && (
                    <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${sort === s.id ? "bg-white" : "bg-amber-500"}`} />
                  )}
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <Link href="/create" className="hidden shrink-0 items-center gap-2 rounded-full bg-neutral-800 px-4 py-2.5 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-700 sm:inline-flex sm:justify-self-end">
            <span className="text-lg leading-none">+</span> Create
          </Link>
        </div>
        {loading ? (
          <div className="min-h-[420px]" aria-busy="true" aria-live="polite" />
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
                <h2 className="text-lg font-bold text-neutral-100">Create the first hot token</h2>
                <Link href="/create" className="btn-primary mt-5">
                  Create token
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
        ) : !isAncientTab ? (
          <TokenCarousel rows={visible} />
        ) : (
          <div ref={gridRef} className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map((row) => (
              <TokenCard key={row.address} row={row} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

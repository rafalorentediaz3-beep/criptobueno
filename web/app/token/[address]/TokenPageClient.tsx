"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { useReadContract } from "wagmi";
import { potatoTokenAbi } from "@/lib/abi";
import { ZERO_ADDRESS } from "@/lib/config";
import { useAncientTokens } from "@/lib/ancient";
import { useLaunchActivity } from "@/lib/events";
import { usePad, useTokenPad } from "@/lib/hooks";
import { useCurveStats, usePoolStats } from "@/lib/pool";
import { formatUsd } from "@/lib/format";
import { HarvestCard } from "@/components/HarvestCard";
import { BondCard } from "@/components/BondCard";
import { HolderRewardsCard } from "@/components/HolderRewardsCard";
import { NotDeployed } from "@/components/NotDeployed";
import { TokenChart } from "@/components/TokenChart";
import { TokenTraders } from "@/components/TokenTraders";
import { LineSkeleton } from "@/components/Skeletons";
import { StatsCard } from "@/components/StatsCard";
import { TokenHeaderCard } from "@/components/TokenHeaderCard";
import { TradeWidget } from "@/components/TradeWidget";

export default function TokenPageClient() {
  const params = useParams<{ address: string }>();
  const raw = params?.address ?? "";
  const valid = isAddress(raw);
  const token = valid ? getAddress(raw) : undefined;

  const { chainId, isDeployed } = usePad();

  // Start from the server-resolved launch snapshot, then verify it on-chain in
  // the background. Navigation no longer waits for every historical pad read.
  // Reuse Discover's in-memory/local snapshot, but never start the expensive
  // all-token history scan from a detail page. A cold direct URL resolves only
  // this token through the batched contract reads below.
  const { creationByToken } = useLaunchActivity({ live: false, fetchFeed: false });
  const creation = token ? creationByToken.get(token.toLowerCase()) : undefined;
  const resolved = useTokenPad(
    token,
    creation
      ? {
          kind: creation.kind,
          pad: creation.pad,
          creator: creation.creator,
          pool: creation.pool,
          poolId: creation.poolId,
          feeTier: creation.feeTier,
          lpTokenId: creation.lpTokenId,
        }
      : undefined,
  );
  const isCurve = resolved.kind === "curve";
  const isV4 = resolved.kind === "v4";
  // Do not issue curve-pad reads for V4/direct tokens.
  const curve = useCurveStats(isCurve ? token : undefined);
  // If no pad claims it, it may be a pre-existing "ancient" Robinhood token.
  const { byAddress: ancientByAddress, isLoading: ancientLoading } = useAncientTokens({
    enabled: !creation && !resolved.isLoading && !resolved.resolved,
  });
  const ancient = token ? ancientByAddress.get(token.toLowerCase()) : undefined;

  const onCurve = isCurve && !resolved.bonded; // pre-bond curve phase (still trades on Uniswap)
  const isAncient = !resolved.resolved && !!ancient;
  const creator = resolved.creator;
  const lpTokenId = resolved.lpTokenId;
  // Effective Uniswap pool: curve and direct tokens both have a live pool from
  // creation; ancient tokens use their pre-existing trade pool.
  const pool = isAncient && ancient ? ancient.tradePool : resolved.pool;

  // The launch/ancient feeds already carry these labels. Only hit the token
  // contract when a direct URL arrives before either feed has identified it.
  const queryToken = token ?? ZERO_ADDRESS;
  const knownName = creation?.name?.trim() || ancient?.name?.trim();
  const knownSymbol = creation?.symbol?.trim() || ancient?.symbol?.trim();
  const needsTokenMetadata = !knownName || !knownSymbol;
  const nameRead = useReadContract({
    address: queryToken,
    abi: potatoTokenAbi,
    functionName: "name",
    query: {
      enabled: isDeployed && !!token && needsTokenMetadata,
      retry: 2,
      staleTime: 5 * 60_000,
    },
  });
  const symbolRead = useReadContract({
    address: queryToken,
    abi: potatoTokenAbi,
    functionName: "symbol",
    query: {
      enabled: isDeployed && !!token && needsTokenMetadata,
      retry: 2,
      staleTime: 5 * 60_000,
    },
  });

  const readName = nameRead.data as string | undefined;
  const readSymbol = symbolRead.data as string | undefined;
  const name = knownName || readName?.trim();
  const symbol = knownSymbol || readSymbol?.trim();

  // Price / market cap / liquidity from the Uniswap pool. Curve tokens have a
  // live pool from block one, so this is continuous across migration; {curve}
  // only supplies the migration flag + progress for the curve UI.
  const poolStats = usePoolStats(
    token,
    pool !== ZERO_ADDRESS ? pool : undefined,
    isV4 ? resolved.poolId : undefined,
  );
  const marketCapEth =
    poolStats.marketCapEth > 0 ? poolStats.marketCapEth : (creation?.marketCapEth ?? 0);
  const priceWeth =
    poolStats.priceWeth > 0
      ? poolStats.priceWeth
      : marketCapEth > 0
        ? marketCapEth / 1_000_000_000
        : 0;

  if (!isDeployed) return <NotDeployed chainId={chainId} />;

  if (!token) {
    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <h2 className="text-lg font-bold text-neutral-100">Invalid token address</h2>
        <p className="mt-2 text-sm text-neutral-400">
          The URL doesn&apos;t contain a valid address.
        </p>
        <Link href="/" className="btn-secondary mt-5">
          Back to Discover
        </Link>
      </div>
    );
  }

  // A provider timeout does not mean the contract is missing. Keep this state
  // explicitly retryable instead of intermittently labelling valid tokens as
  // "not found".
  if (!name || !symbol) {
    const metadataLoading = nameRead.isLoading || symbolRead.isLoading;
    const metadataSettled =
      !metadataLoading &&
      ((nameRead.isError || nameRead.data !== undefined) &&
        (symbolRead.isError || symbolRead.data !== undefined));
    if (!metadataSettled) {
      return (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="card p-6">
              <LineSkeleton className="h-7 w-56" />
              <LineSkeleton className="mt-3 h-4 w-72" />
            </div>
            <div className="card h-72 p-6">
              <LineSkeleton className="h-5 w-24" />
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <h2 className="text-lg font-bold text-neutral-100">Token data unavailable</h2>
        <p className="mt-2 text-sm text-neutral-400">
          The network did not return this token&apos;s details. Try the request again.
        </p>
        <button
          type="button"
          className="btn-secondary mt-5"
          onClick={() => {
            void nameRead.refetch();
            void symbolRead.refetch();
          }}
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    );
  }

  // Wait for pad resolution; if it's not a pad token, also wait for the ancient list.
  const stillResolving =
    resolved.isLoading || (isCurve && curve.isLoading) || (!resolved.resolved && ancientLoading);
  if (stillResolving) {
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="card p-6">
            <LineSkeleton className="h-7 w-56" />
            <LineSkeleton className="mt-3 h-4 w-72" />
          </div>
          <div className="card h-72 p-6">
            <LineSkeleton className="h-5 w-24" />
          </div>
          <div className="card h-64 p-6">
            <LineSkeleton className="h-5 w-24" />
          </div>
        </div>
        <div className="space-y-6">
          <div className="card h-80 p-6">
            <LineSkeleton className="h-5 w-24" />
          </div>
          <div className="card h-48 p-6">
            <LineSkeleton className="h-5 w-24" />
          </div>
        </div>
      </div>
    );
  }

  // ── Ancient (pre-existing Robinhood) token: chart + trade + USD stats, no fees ──
  if (isAncient && ancient) {
    const dexUrl = `https://dexscreener.com/robinhood/${ancient.address}`;
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <TokenHeaderCard
            token={token}
            name={name}
            symbol={symbol}
            creator={ZERO_ADDRESS}
            chainId={chainId}
            ancient
            imageURI={ancient.imageUrl}
          />
          <TokenChart token={token} pool={pool} imageURI={ancient.imageUrl} />
        </div>

        <div className="space-y-6">
          {ancient.hasWethPool && pool !== ZERO_ADDRESS ? (
            <TradeWidget token={token} symbol={symbol} pool={pool} feeTier={ancient.feeTier} />
          ) : (
            <div className="card p-5">
              <h3 className="font-bold text-neutral-100">Trade</h3>
              <p className="mt-2 text-xs text-neutral-400">
                This token has no WETH pool for in-app trading. Trade it on DexScreener.
              </p>
              <a
                href={dexUrl}
                target="_blank"
                rel="noreferrer"
                className="btn-primary mt-4 w-full"
              >
                Trade on DexScreener
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          )}

          <div className="card p-5">
            <h3 className="font-bold text-neutral-100">Stats</h3>
            <dl className="mt-4 space-y-2.5 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-neutral-500">Market Cap</dt>
                <dd className="font-mono text-neutral-100">
                  {ancient.fdvUsd > 0 ? formatUsd(ancient.fdvUsd) : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-neutral-500">24h Volume</dt>
                <dd className="font-mono text-neutral-100">
                  {ancient.volume24Usd > 0 ? formatUsd(ancient.volume24Usd) : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-neutral-500">Liquidity</dt>
                <dd className="font-mono text-neutral-100">
                  {ancient.liquidityUsd > 0 ? formatUsd(ancient.liquidityUsd) : "—"}
                </dd>
              </div>
            </dl>
            <a
              href={dexUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-amber-400"
            >
              View on DexScreener
              <ExternalLink className="h-3 w-3" />
            </a>
            <p className="mt-3 text-[11px] text-neutral-600">
              Data by GeckoTerminal. This is a pre-existing token, not launched on this site.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── PotatoPad token (curve or direct): full page with LP-fees card ──
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* LEFT (2/3) */}
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <TokenHeaderCard
          token={token}
          name={name}
          symbol={symbol}
          creator={creator}
          chainId={chainId}
          launchMeta={creation}
        />
        {/* Exchange-style stat strip: the numbers traders scan first, above the chart. */}
        <StatsCard
          token={token}
          pool={pool !== ZERO_ADDRESS ? pool : undefined}
          chainId={chainId}
          marketCapEth={marketCapEth}
          onCurve={onCurve}
          progressBps={curve.progressBps}
          volume24Usd={creation?.volume24Usd}
          isV4={isV4}
          startBlock={creation?.blockNumber}
          variant="strip"
        />
        <TokenChart
          token={token}
          pool={pool}
          poolId={resolved.poolId}
          priceWeth={priceWeth}
          isV4={isV4}
          isCurve={isCurve}
          bonded={resolved.bonded}
          progressBps={curve.progressBps}
          startBlock={creation?.blockNumber}
          imageURI={creation?.imageURI}
        />
        <TokenTraders
          token={token}
          poolId={resolved.poolId}
          creator={creator}
          pool={pool}
          symbol={symbol ?? ""}
          isV4={isV4}
          startBlock={creation?.blockNumber}
        />
      </div>

      {/* RIGHT (1/3) */}
      <div className="space-y-6">
        {isCurve && curve.bondable && !resolved.bonded && (
          <BondCard token={token} pad={resolved.pad} chainId={chainId} />
        )}
        <TradeWidget
          token={token}
          symbol={symbol}
          pool={pool}
          isCurve={isCurve}
          isV4={isV4}
          v4PoolId={resolved.poolId}
          v4Fee={resolved.feeTier}
          bonded={resolved.bonded}
        />
        {/* Renders only for holder-rewards launches; a no-op otherwise. */}
        {!isV4 && (
          <HolderRewardsCard token={token} symbol={symbol} pad={resolved.pad} chainId={chainId} />
        )}
        <HarvestCard
          creator={creator}
          lpTokenId={lpTokenId}
          pool={pool}
          token={token}
          symbol={symbol}
          pad={resolved.pad}
          isV4={isV4}
        />
      </div>
    </div>
  );
}

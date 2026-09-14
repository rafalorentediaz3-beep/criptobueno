"use client";

import { useRef } from "react";
import { decodeEventLog, parseAbiItem } from "viem";
import type { Address, Hex, Log } from "viem";
import { usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { usePad } from "@/lib/hooks";
import { ZERO_ADDRESS, V4_POOL_MANAGER_ADDRESSES } from "@/lib/config";
import { priceWethPerToken, tokenIsToken0 } from "@/lib/pool";

const v4SwapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
);

export type V4SwapPoint = {
  timestamp: number;
  price: number;
  sender: Address;
  /** "buy" = trader received the launched token; "sell" = trader gave it up. */
  side: "buy" | "sell";
  /** Whole-unit amounts (18 decimals assumed for both legs), always positive. */
  tokenAmount: number;
  wethAmount: number;
};

/**
 * Shared, incrementally-updating feed of every Uniswap V4 swap on a pool.
 * Both the candlestick/area chart and the "Recent trades" list read from this
 * single hook (same query key → one shared cache/fetch across both), so
 * opening a token page only ever scans the chain once per poll, not twice.
 *
 * On first mount it backfills a generous but bounded block range, then every
 * poll after that only asks for blocks strictly newer than the last one
 * already fetched — this is what keeps repeated polling cheap on the shared
 * RPC proxy instead of re-scanning millions of blocks every tick.
 */
export function useV4SwapHistory(
  token: Address,
  poolId: Hex | undefined,
  enabled: boolean,
  refetchIntervalMs: number,
  fromBlockHint?: bigint,
  quoteToken?: Address,
) {
  const { chainId, weth } = usePad();
  const quote = quoteToken ?? weth;
  const client = usePublicClient();
  const v4Manager = V4_POOL_MANAGER_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  const FALLBACK_BLOCKS = 250_000n;
  const LOG_CHUNK = 9_000n;
  const cacheRef = useRef<{
    key: string;
    points: V4SwapPoint[];
    lastBlock: bigint;
    blockTsCache: Map<string, number>;
  } | null>(null);

  return useQuery({
    queryKey: ["v4-swap-history", chainId, token, poolId, quote, fromBlockHint?.toString()],
    enabled: enabled && !!poolId && !!client,
    refetchInterval: refetchIntervalMs,
    queryFn: async () => {
      if (!client || !poolId) return { points: [] as V4SwapPoint[], latestTs: 0 };
      try {
        const params = new URLSearchParams({
          token,
          poolId,
          quoteToken: quote,
          ...(fromBlockHint !== undefined ? { fromBlock: fromBlockHint.toString() } : {}),
        });
        const res = await fetch(`/api/v4-swaps?${params.toString()}`, {
          signal: AbortSignal.timeout(45_000),
        });
        if (res.ok) {
          return (await res.json()) as { points: V4SwapPoint[]; latestTs: number };
        }
      } catch {
        // Fall back to browser RPC below. The server endpoint is an acceleration,
        // not a correctness dependency.
      }
      const cacheKey = `${chainId}:${poolId}:${quote}`;
      let cache = cacheRef.current;
      if (!cache || cache.key !== cacheKey) {
        cache = { key: cacheKey, points: [], lastBlock: -1n, blockTsCache: new Map() };
        cacheRef.current = cache;
      }
      const latest = await client.getBlockNumber();
      const fromBlock =
        cache.lastBlock < 0n
          ? fromBlockHint !== undefined && fromBlockHint <= latest
            ? fromBlockHint
            : latest > FALLBACK_BLOCKS
              ? latest - FALLBACK_BLOCKS
              : 0n
          : cache.lastBlock + 1n;
      if (fromBlock <= latest) {
        // Robinhood providers cap getLogs ranges around 10k blocks. The old
        // five-million-block request failed on every first detail-page visit.
        const logs: Log[] = [];
        const windows: { fromBlock: bigint; toBlock: bigint }[] = [];
        for (let from = fromBlock; from <= latest; from += LOG_CHUNK + 1n) {
          windows.push({
            fromBlock: from,
            toBlock: from + LOG_CHUNK < latest ? from + LOG_CHUNK : latest,
          });
        }
        for (let i = 0; i < windows.length; i += 3) {
          const chunks = await Promise.all(
            windows.slice(i, i + 3).map((window) =>
              client
                .getLogs({
                  address: v4Manager,
                  event: v4SwapEvent,
                  args: { id: poolId },
                  ...window,
                })
                .catch(() => []),
            ),
          );
          for (const chunk of chunks) logs.push(...chunk);
        }
        if (logs.length > 0) {
          const uniqueBlocks = Array.from(new Set(logs.map((log) => log.blockNumber ?? 0n))).filter(
            (b) => !cache!.blockTsCache.has(b.toString()),
          );
          const blockEntries = await Promise.all(
            uniqueBlocks.map(async (blockNumber) => {
              const block = await client.getBlock({ blockNumber });
              return [blockNumber, Number(block.timestamp)] as const;
            }),
          );
          for (const [blockNumber, ts] of blockEntries) cache.blockTsCache.set(blockNumber.toString(), ts);
          const isToken0 = tokenIsToken0(token, quote);
          const newPoints = logs
            .map((log) => {
              const decoded = decodeEventLog({ abi: [v4SwapEvent], data: log.data, topics: log.topics });
              const tokenDelta = isToken0 ? decoded.args.amount0 : decoded.args.amount1;
              const wethDelta = isToken0 ? decoded.args.amount1 : decoded.args.amount0;
              // Pool-perspective deltas: negative = pool sent out (trader received),
              // positive = pool took in (trader gave up).
              const side: "buy" | "sell" = tokenDelta < 0n ? "buy" : "sell";
              return {
                timestamp: cache!.blockTsCache.get((log.blockNumber ?? 0n).toString()) ?? 0,
                price: priceWethPerToken(decoded.args.sqrtPriceX96, isToken0),
                sender: decoded.args.sender,
                side,
                tokenAmount: Math.abs(Number(tokenDelta) / 1e18),
                wethAmount: Math.abs(Number(wethDelta) / 1e18),
              };
            })
            // A missing/failed block timestamp lookup would default to 0 and
            // corrupt the whole time axis (huge fake time span → the chart
            // tries to allocate millions of candle buckets and the tab hangs),
            // so drop anything without a real timestamp.
            .filter((point) => point.price > 0 && point.timestamp > 0);
          cache.points = [...cache.points, ...newPoints].sort((a, b) => a.timestamp - b.timestamp);
        }
        cache.lastBlock = latest;
      }
      const latestBlock = await client.getBlock({ blockNumber: latest });
      return { points: cache.points, latestTs: Number(latestBlock.timestamp) };
    },
  });
}

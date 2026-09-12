"use client";

import { ArrowDownLeft, ArrowUpRight, Users } from "lucide-react";
import { useState } from "react";
import type { Address, Hex } from "viem";
import { usePublicClient } from "wagmi";
import { useTokenHolders } from "@/lib/events";
import { ZERO_ADDRESS } from "@/lib/config";
import { shortAddress, timeAgo, formatUsd } from "@/lib/format";
import { useEthUsdPrice } from "@/lib/price";
import { useV4SwapHistory } from "@/lib/useV4SwapHistory";

/**
 * Replaces the old "Holders" card for V4 tokens with a combined
 * Traders / Holders card (two tabs), styled after pump.fun-style launchpads:
 * a "Recent trades" feed (buy/sell arrows, amount, trader address, price in
 * WETH + USD, time ago) plus the existing Holders list as a second tab.
 *
 * Non-V4 tokens have no decoded Swap feed, so only the Holders tab is shown
 * for them (same content as the old ActivityTabs component).
 */
export function TokenTraders({
  token,
  poolId,
  creator,
  pool,
  symbol,
  isV4,
  startBlock,
}: {
  token: Address;
  poolId?: Hex;
  creator: Address;
  pool: Address;
  symbol: string;
  isV4: boolean;
  startBlock?: bigint;
}) {
  const client = usePublicClient();
  const [tab, setTab] = useState<"trades" | "holders">(isV4 ? "trades" : "holders");
  const [holdersRequested, setHoldersRequested] = useState(false);
  const { holders, total, unavailable, isLoading } = useTokenHolders(
    token,
    isV4 ? "v4" : undefined,
    tab === "holders" && holdersRequested,
    startBlock,
  );
  const topHolders = holders.slice(0, 10);
  const { usd: ethUsd } = useEthUsdPrice();
  const tradesQuery = useV4SwapHistory(
    token,
    poolId,
    isV4 && tab === "trades" && !!client,
    30_000,
    startBlock,
  );
  const trades = (tradesQuery.data?.points ?? []).slice().reverse().slice(0, 50);

  function holderStatus(address: Address) {
    const a = address.toLowerCase();
    if (pool !== ZERO_ADDRESS && a === pool.toLowerCase())
      return { text: "Pool", tone: "pool" as const };
    if (a === creator.toLowerCase()) return { text: "creator", tone: "creator" as const };
    return { text: "", tone: "clean" as const };
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-full bg-neutral-900 p-0.5">
          {isV4 && (
            <button
              type="button"
              onClick={() => setTab("trades")}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${tab === "trades" ? "bg-amber-500 text-black" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              Recent trades
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setTab("holders");
              setHoldersRequested(true);
            }}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${tab === "holders" ? "bg-amber-500 text-black" : "text-neutral-400 hover:text-neutral-200"}`}
          >
            Holders
          </button>
        </div>
        <span className="font-mono text-xs text-neutral-500">
          {tab === "trades" ? trades.length : topHolders.length}
        </span>
      </div>

      {tab === "trades" ? (
        trades.length === 0 ? (
          <p className="mt-6 pb-2 text-center text-sm text-neutral-500">
            {tradesQuery.isLoading ? "Loading recent trades…" : "No trades yet."}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-800/70">
            {trades.map((trade, i) => {
              const isBuy = trade.side === "buy";
              return (
                <li key={i} className="flex items-center gap-3 py-2.5 text-sm">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${isBuy ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}
                  >
                    {isBuy ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownLeft className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-neutral-100">
                      {trade.tokenAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })} {symbol}
                    </span>
                    <span className="block font-mono text-[11px] text-neutral-500">
                      {shortAddress(trade.sender)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-xs text-neutral-200">
                      {trade.wethAmount.toFixed(5)} WETH
                    </span>
                    <span className="block text-[11px] text-neutral-500">
                      {ethUsd ? formatUsd(trade.wethAmount * ethUsd) : "—"}
                    </span>
                  </span>
                  <span className="w-10 shrink-0 text-right text-[11px] text-neutral-600">
                    {timeAgo(trade.timestamp).replace(" ago", "")}
                  </span>
                </li>
              );
            })}
          </ul>
        )
      ) : !holdersRequested ? (
        <div className="mt-6 flex justify-center pb-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setHoldersRequested(true)}
          >
            <Users className="h-4 w-4" />
            Load holders
          </button>
        </div>
      ) : isLoading ? (
        <div className="mt-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-8 w-full" />
          ))}
        </div>
      ) : unavailable ? (
        <p className="mt-6 pb-2 text-center text-sm text-neutral-500">
          History unavailable, this RPC caps log ranges.
        </p>
      ) : topHolders.length === 0 ? (
        <p className="mt-6 pb-2 text-center text-sm text-neutral-500">No holders found.</p>
      ) : (
        <div className="mt-3">
          <ul className="divide-y divide-neutral-800/70">
            {topHolders.map((h, i) => {
              const pctBps = total > 0n ? Number((h.balance * 10000n) / total) : 0;
              const pct = (pctBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
              const st = holderStatus(h.address);
              const toneCls =
                st.tone === "pool"
                  ? "bg-fuchsia-500/10 text-fuchsia-300"
                  : st.tone === "creator"
                    ? "bg-emerald-500/10 text-emerald-400"
                    : "bg-neutral-800 text-neutral-500";
              return (
                <li key={h.address} className="flex items-center gap-3 rounded-md py-2.5 text-sm">
                  <span className="w-5 shrink-0 font-mono text-xs text-neutral-600">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-neutral-200">{shortAddress(h.address)}</span>
                    {st.text && (
                      <span className={`ml-2 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${toneCls}`}>
                        {st.text}
                      </span>
                    )}
                  </span>
                  <span className="hidden w-24 sm:block">
                    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                      <span
                        className="block h-full rounded-full bg-amber-500/70"
                        style={{ width: `${Math.min(100, pctBps / 100)}%` }}
                      />
                    </span>
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-neutral-200">
                    {pct}%
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

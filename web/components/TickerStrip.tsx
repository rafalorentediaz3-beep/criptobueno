"use client";

import { useMemo } from "react";
import { useLaunchActivity } from "@/lib/events";
import { usePad } from "@/lib/hooks";
import { timeAgo } from "@/lib/format";

interface TickerItem {
  key: string;
  kind: "created";
  label: string;
  timestamp: number;
}

/**
 * Thin marquee above the header: most recent TokenCreated ("PLANTED") launches,
 * looping via a CSS translateX(-50%) animation over a duplicated list. Edges
 * are feathered with a mask so text never clips. (v2 tokens are live on Uniswap
 * from launch, so there is no separate "harvested" event.)
 */
export function TickerStrip() {
  const { isDeployed } = usePad();
  // Discover owns the live event watchers. The ticker shares its query cache
  // without installing a second set of RPC subscriptions.
  const { creations } = useLaunchActivity({ live: false });

  const items = useMemo<TickerItem[]>(() => {
    return creations
      .map((c) => ({
        key: `created-${c.token}-${c.blockNumber.toString()}`,
        kind: "created" as const,
        label: `CREATED: $${c.symbol || "???"} (${timeAgo(c.timestamp)})`,
        timestamp: c.timestamp,
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 12);
  }, [creations]);

  if (!isDeployed) return null;

  // Pad short lists so the marquee never leaves empty gaps, then duplicate the
  // whole list once for the seamless -50% loop.
  let base: TickerItem[] = items.length
    ? items
    : [{ key: "empty", kind: "created", label: "CREATE THE FIRST HOT TOKEN", timestamp: 0 }];
  while (base.length < 6) {
    base = base.concat(base.map((it, i) => ({ ...it, key: `${it.key}-pad${base.length + i}` })));
  }
  const loop = [...base, ...base.map((it) => ({ ...it, key: `${it.key}-dup` }))];

  return (
    <div className="border-b border-neutral-800 bg-neutral-950">
      <div
        className="overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to right, transparent, #000 4rem, #000 calc(100% - 4rem), transparent)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent, #000 4rem, #000 calc(100% - 4rem), transparent)",
        }}
      >
        <div
          className="animate-marquee flex w-max items-center py-1.5"
          style={{ animationDuration: `${Math.max(30, base.length * 6)}s` }}
        >
          {loop.map((item) => (
            <span key={item.key} className="flex items-center whitespace-nowrap">
              <span className="flex items-center gap-1.5 px-5 font-mono text-[10px] uppercase tracking-widest">
                <span className="text-amber-400">{item.label}</span>
              </span>
              <span aria-hidden className="text-neutral-700">
                &bull;
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

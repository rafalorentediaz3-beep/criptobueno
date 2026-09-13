"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  RefreshCw,
} from "lucide-react";
import { formatUsd } from "@/lib/format";

interface SiteStats {
  tokensLaunched: number;
  activeTokens: number;
  volume24Usd: number;
  volumeAllTimeUsd: number | null;
  unavailable: boolean;
  updatedAt: number;
}

type Metric = {
  label: string;
  value: string;
  hint: string;
  accent: string;
};

const fmtNum = (n: number) => n.toLocaleString("en-US");
const fmtUsd = (n: number) => (n > 0 ? formatUsd(n) : "$0");

function MetricCard({ metric, loading }: { metric: Metric; loading: boolean }) {
  return (
    <article className="group relative min-h-36 overflow-hidden rounded-lg border border-white/[0.08] bg-neutral-950/55 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_18px_45px_-32px_rgba(0,0,0,0.95)] backdrop-blur-xl transition-colors hover:border-pink-400/25 hover:bg-neutral-950/65">
      <div className={`absolute inset-x-0 top-0 h-px ${metric.accent}`} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-bold uppercase text-neutral-300 sm:text-[15px]">
          {metric.label}
        </div>
        <ArrowUpRight className="h-3.5 w-3.5 text-neutral-700 transition-colors group-hover:text-pink-300/70" aria-hidden />
      </div>
      {loading ? (
        <div className="mt-6 h-8 w-28 animate-pulse rounded bg-white/[0.06]" />
      ) : (
        <p className="mt-5 font-mono text-[28px] font-semibold leading-none text-neutral-100 tabular-nums">
          {metric.value}
        </p>
      )}
      <p className="mt-2 text-xs text-neutral-500">{metric.hint}</p>
    </article>
  );
}

export default function AnalyticsPage() {
  const { data, isLoading, isError } = useQuery<SiteStats>({
    queryKey: ["site-stats"],
    queryFn: async () => {
      const response = await fetch("/api/stats");
      if (!response.ok) throw new Error("stats unavailable");
      return (await response.json()) as SiteStats;
    },
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  const primary: Metric = {
    label: "All-time volume",
    value: data
      ? data.volumeAllTimeUsd != null
        ? fmtUsd(data.volumeAllTimeUsd)
        : "Computing"
      : "$0",
    hint: "Cumulative volume since launch",
    accent: "bg-gradient-to-r from-pink-500/80 via-pink-400/30 to-transparent",
  };

  const metrics: Metric[] = [
    {
      label: "Tokens launched",
      value: data ? fmtNum(data.tokensLaunched) : "0",
      hint: data ? `${fmtNum(data.activeTokens)} active in the last 24h` : "Since launch",
      accent: "bg-gradient-to-r from-amber-400/70 to-transparent",
    },
    {
      label: "24h volume",
      value: data ? fmtUsd(data.volume24Usd) : "$0",
      hint: "Combining all tokens",
      accent: "bg-gradient-to-r from-emerald-400/70 to-transparent",
    },
  ];

  return (
    <div className="space-y-7 pb-8">
      <header className="flex flex-col gap-4 border-b border-white/[0.08] pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase text-pink-300/80">
            <span className="h-1.5 w-1.5 rounded-full bg-pink-400 shadow-[0_0_10px_rgba(244,114,182,0.9)]" />
            Live overview
          </div>
          <h1 className="text-3xl font-semibold text-neutral-100 sm:text-4xl">Analytics</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-neutral-400">
            Real-time activity and liquidity across every launched token.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start rounded-full border border-white/[0.08] bg-black/30 px-3 py-2 text-[11px] text-neutral-400 backdrop-blur-xl sm:self-auto">
          <RefreshCw className={`h-3 w-3 text-pink-300/80 ${isLoading ? "animate-spin" : ""}`} aria-hidden />
          {data?.updatedAt
            ? `Updated ${new Date(data.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Updating live"}
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" aria-label="Platform metrics">
        <MetricCard metric={primary} loading={isLoading} />
        {metrics.map((metric) => (
          <MetricCard key={metric.label} metric={metric} loading={isLoading} />
        ))}
      </section>

      {(isError || data?.unavailable) && (
        <div className="rounded-lg border border-amber-300/15 bg-amber-300/[0.06] px-4 py-3 text-xs text-amber-100/70 backdrop-blur-xl">
          {isError
            ? "Stats are temporarily unavailable. The dashboard will retry automatically."
            : "The data feed is refreshing, so some figures may be briefly incomplete."}
        </div>
      )}

    </div>
  );
}

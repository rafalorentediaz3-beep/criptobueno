"use client";

import { useQuery } from "@tanstack/react-query";
import { GECKOTERMINAL_NETWORKS } from "@/lib/config";

/**
 * 24h USD trading volume for a single pool, straight from GeckoTerminal's
 * public per-pool endpoint. Client-side (like {useGeckoIndexed}): no API key
 * needed and CORS is permissive. Fails soft to `null` — a stat that can't
 * load shows a dash rather than blocking the page.
 */
export function usePoolVolume24h(chainId: number, pool: string | undefined): number | null {
  const network = GECKOTERMINAL_NETWORKS[chainId];
  const { data } = useQuery({
    queryKey: ["pool-volume-24h", network, pool?.toLowerCase()],
    enabled: !!network && !!pool,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async (): Promise<number | null> => {
      try {
        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}`,
          { headers: { accept: "application/json" } },
        );
        if (!res.ok) return null;
        const json = (await res.json()) as {
          data?: { attributes?: { volume_usd?: { h24?: string } } };
        };
        const v = Number(json?.data?.attributes?.volume_usd?.h24);
        return Number.isFinite(v) && v >= 0 ? v : null;
      } catch {
        return null;
      }
    },
  });
  return data ?? null;
}

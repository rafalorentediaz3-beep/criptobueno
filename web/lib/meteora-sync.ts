// SERVER ONLY. Serverless port of scripts/meteora-reader.mjs that stores every
// qualifying token in Supabase. Records are append-only: once a mint is saved it
// is never updated or deleted, so the archive keeps every previous token.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireSupabase } from "@/lib/supabase";

const API = "https://damm-v2.datapi.meteora.ag/pools";
const DAY_MS = 86_400_000;
const PAGE_SIZE = 1000;
const MIN_FEES_USD = 3500;
const LOOKBACK_DAYS = 150;
const SCAN_PAGES_PER_RUN = 4;
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOCIAL_REFRESH_MS = 24 * 60 * 60 * 1000;
const SOCIAL_BATCH_SIZE = 30;
const QUOTES = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
]);

type Pool = {
  address?: string; launchpad?: string; is_blacklisted?: boolean; created_at?: unknown;
  cumulative_metrics?: { fees?: unknown }; fees?: Record<string, unknown>;
  token_x?: { address?: string; name?: string; symbol?: string };
  token_y?: { address?: string; name?: string; symbol?: string };
};
export type MeteoraToken = {
  mint: string; name: string; symbol: string; poolAddress: string; poolCreatedAt: number;
  launchpad: string; chain: "sol"; protocol: string; source: "meteora"; feeBasis: "lifetime";
  feesUsd: number; fees24hUsd: number | null; firstSeenAt?: string; savedAt?: string; frozen?: boolean;
  [key: string]: unknown;
};

type DexPair = {
  chainId?: string; pairAddress?: string; baseToken?: { address?: string };
  liquidity?: { usd?: number }; info?: {
    websites?: Array<{ url?: string }>;
    socials?: Array<{ type?: string; url?: string }>;
  };
};

function safeWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function socialLinks(mint: string, pairs: DexPair[]) {
  const matching = pairs.filter((pair) => pair.chainId === "solana" && pair.baseToken?.address === mint)
    .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));
  let websiteUrl: string | undefined;
  let twitterUrl: string | undefined;
  let associationPair: string | null = null;
  for (const pair of matching) {
    websiteUrl ??= (pair.info?.websites ?? []).map((entry) => safeWebUrl(entry.url)).find(Boolean);
    const social = (pair.info?.socials ?? []).find((entry) => {
      if (!["twitter", "x"].includes(entry.type?.toLowerCase() ?? "")) return false;
      const url = safeWebUrl(entry.url);
      return !!url && ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(new URL(url).hostname.toLowerCase());
    });
    twitterUrl ??= safeWebUrl(social?.url);
    if ((websiteUrl || twitterUrl) && associationPair === null) associationPair = pair.pairAddress ?? null;
    if (websiteUrl && twitterUrl) break;
  }
  return { websiteUrl, twitterUrl, associationPair };
}

async function enrichStoredSocials() {
  const db = requireSupabase();
  let checked = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("meteora_tokens")
      .select("mint,pool_created_at,fees_usd,first_seen_at,data").range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const now = Date.now();
    const stale = rows.filter((row) => {
      const metadata = (row.data as MeteoraToken)?.tokenMetadata as Record<string, unknown> | undefined;
      const checkedAt = typeof metadata?.associationCheckedAt === "string" ? Date.parse(metadata.associationCheckedAt) : 0;
      return !Number.isFinite(checkedAt) || now - checkedAt >= SOCIAL_REFRESH_MS;
    });
    for (let i = 0; i < stale.length; i += SOCIAL_BATCH_SIZE) {
      const batch = stale.slice(i, i + SOCIAL_BATCH_SIZE);
      try {
        const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.map((row) => row.mint).join(",")}`, {
          cache: "no-store", signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) continue;
        const pairs = await response.json() as DexPair[];
        if (!Array.isArray(pairs)) continue;
        const checkedAt = new Date().toISOString();
        const updates = [];
        for (const row of batch) {
          const existing = row.data as MeteoraToken;
          const previous = (existing.tokenMetadata ?? {}) as Record<string, unknown>;
          const links = socialLinks(row.mint, pairs);
          const username = links.twitterUrl ? new URL(links.twitterUrl).pathname.split("/").filter(Boolean)[0] : undefined;
          const oldTwitter = (existing.tokenTwitter ?? {}) as Record<string, unknown>;
          // Keep every historical field and any previously known valid links.
          const tokenMetadata = {
            ...previous,
            ...links,
            associationPair: links.associationPair ?? previous.associationPair,
            websiteUrl: links.websiteUrl ?? previous.websiteUrl,
            twitterUrl: links.twitterUrl ?? previous.twitterUrl,
            twitterUsername: username ?? previous.twitterUsername,
            associationCheckedAt: checkedAt,
            associationSource: links.websiteUrl || links.twitterUrl ? "dexscreener-exact-mint" : previous.associationSource ?? null,
          };
          const tokenTwitter = {
            ...oldTwitter,
            ...(username ? { username, url: links.twitterUrl, associationConfirmed: true,
              associationSource: "dexscreener-exact-mint", associationCheckedAt: checkedAt } : {}),
            checkedAt: typeof oldTwitter.checkedAt === "string" ? oldTwitter.checkedAt : checkedAt,
            source: oldTwitter.source ?? "dexscreener-exact-mint",
            blueVerified: oldTwitter.blueVerified ?? null,
            followsMeteora: oldTwitter.followsMeteora ?? null,
            followsSolana: oldTwitter.followsSolana ?? null,
          };
          updates.push({
            mint: row.mint,
            pool_created_at: row.pool_created_at,
            fees_usd: row.fees_usd,
            first_seen_at: row.first_seen_at,
            data: { ...existing, tokenMetadata, tokenTwitter },
          });
        }
        const { error: updateError } = await db.from("meteora_tokens")
          .upsert(updates, { onConflict: "mint" });
        if (updateError) throw new Error(updateError.message);
        checked += updates.length;
      } catch {
        // Social metadata is best-effort; keep scanning and retaining Meteora history.
      }
    }
    if (rows.length < 1000) break;
  }
  return checked;
}

function poolCreatedMs(value: unknown) {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : NaN;
  }
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function candidates(pools: Pool[], now: number) {
  const byMint = new Map<string, MeteoraToken>();
  for (const pool of pools) {
    if (!pool?.address || !MINT.test(pool.address) || pool.is_blacklisted === true) continue;
    const launchpad = typeof pool.launchpad === "string" ? pool.launchpad.trim().toLowerCase() : "";
    if (launchpad !== "met-dbc") continue;
    const createdAt = poolCreatedMs(pool.created_at);
    if (!Number.isFinite(createdAt) || createdAt < now - LOOKBACK_DAYS * DAY_MS || createdAt > now) continue;
    const feesUsd = pool.cumulative_metrics?.fees;
    if (typeof feesUsd !== "number" || !Number.isFinite(feesUsd) || feesUsd < MIN_FEES_USD) continue;
    for (const token of [pool.token_x, pool.token_y]) {
      if (!token?.address || !MINT.test(token.address) || QUOTES.has(token.address)) continue;
      const previous = byMint.get(token.address);
      if (previous && previous.feesUsd >= feesUsd) continue;
      const fees24h = pool.fees?.["24h"];
      byMint.set(token.address, {
        mint: token.address,
        name: String(token.name || token.symbol || "Token").slice(0, 100),
        symbol: String(token.symbol || "").slice(0, 32),
        poolAddress: pool.address, poolCreatedAt: createdAt, launchpad,
        chain: "sol", protocol: "Meteora AMM V2", source: "meteora", feeBasis: "lifetime",
        feesUsd, fees24hUsd: typeof fees24h === "number" ? fees24h : null,
      });
    }
  }
  return [...byMint.values()];
}

async function requestPage(page: number, sortBy: string) {
  const url = new URL(API);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(PAGE_SIZE));
  url.searchParams.set("sort_by", sortBy);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Meteora respondió HTTP ${response.status}.`);
  const data = await response.json();
  if (!Array.isArray(data.data) || !Number.isInteger(data.pages)) throw new Error("Respuesta de Meteora incompatible.");
  return data as { data: Pool[]; pages: number };
}

async function insertNew(tokens: MeteoraToken[]) {
  if (!tokens.length) return 0;
  const savedAt = new Date().toISOString();
  const rows = tokens.map((token) => {
    const stamp = token.savedAt || token.firstSeenAt || savedAt;
    return {
      mint: token.mint, pool_created_at: Math.round(token.poolCreatedAt), fees_usd: token.feesUsd,
      first_seen_at: stamp,
      data: { ...token, firstSeenAt: token.firstSeenAt || stamp, savedAt: stamp, frozen: true },
    };
  });
  const { data, error } = await requireSupabase().from("meteora_tokens")
    .upsert(rows, { onConflict: "mint", ignoreDuplicates: true }).select("mint");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

async function seedFromArchive() {
  const db = requireSupabase();
  const { count } = await db.from("meteora_tokens").select("mint", { count: "exact", head: true });
  if (count) return 0;
  try {
    const raw = await readFile(path.join(process.cwd(), "data", "meteora-direct-token-history.json"), "utf8")
      .catch(() => readFile(path.join(process.cwd(), "data", "radar-snapshot.json"), "utf8"));
    const archive = JSON.parse(raw) as { tokens?: MeteoraToken[] };
    const valid = (archive.tokens ?? []).filter((t) => MINT.test(t.mint) && Number.isFinite(t.feesUsd) && Number.isFinite(Number(t.poolCreatedAt)));
    return insertNew(valid.map((t) => ({ ...t, poolCreatedAt: Number(t.poolCreatedAt) })));
  } catch {
    return 0;
  }
}

export async function runMeteoraSync() {
  const db = requireSupabase();
  const { data: state } = await db.from("meteora_sync_state").select("scan_page").eq("id", 1).single();
  const now = Date.now();
  let inserted = await seedFromArchive();
  let scanPage = state?.scan_page ?? 1;
  try {
    for (const sortBy of ["fee_24h:desc", "pool_created_at:desc"]) {
      inserted += await insertNew(candidates((await requestPage(1, sortBy)).data, now));
    }
    // Resumable full sweep: a few creation-ordered pages per run, so older pools
    // whose lifetime fees later cross the threshold are also captured.
    const cutoff = now - LOOKBACK_DAYS * DAY_MS;
    for (let i = 0; i < SCAN_PAGES_PER_RUN; i++) {
      const page = await requestPage(scanPage, "pool_created_at:desc");
      inserted += await insertNew(candidates(page.data, now));
      const pastWindow = page.data.length > 0 && page.data.every((pool) => poolCreatedMs(pool.created_at) < cutoff);
      scanPage = pastWindow || scanPage >= page.pages || !page.data.length ? 1 : scanPage + 1;
      if (scanPage === 1) break;
    }
    await enrichStoredSocials();
    await db.from("meteora_sync_state").update({ last_poll_at: new Date().toISOString(), last_error: null, scan_page: scanPage }).eq("id", 1);
    return { ok: true, inserted, scanPage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("meteora_sync_state").update({ last_poll_at: new Date().toISOString(), last_error: message, scan_page: scanPage }).eq("id", 1);
    return { ok: false, inserted, scanPage, error: message };
  }
}

export async function readStoredTokens() {
  const db = requireSupabase();
  const tokens: MeteoraToken[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("meteora_tokens").select("data")
      .order("pool_created_at", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    tokens.push(...(data ?? []).map((row) => row.data as MeteoraToken));
    if (!data || data.length < 1000) break;
  }
  const { data: state } = await db.from("meteora_sync_state").select("last_poll_at,last_error").eq("id", 1).single();
  return { tokens, lastPollAt: (state?.last_poll_at as string | null) ?? null, lastError: (state?.last_error as string | null) ?? null };
}

export { LOOKBACK_DAYS, MIN_FEES_USD };

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { MeteoraReader } from "./meteora-reader.mjs";
import { TokenMetadataReader } from "./token-metadata.mjs";

const radarConfig = JSON.parse(await readFile(new URL("../radar.config.json", import.meta.url), "utf8"));
if (!["axiom", "meteora"].includes(radarConfig.source)) throw new Error("Fuente del radar no válida.");
if (radarConfig.source === "meteora" && radarConfig.meteoraFeeBasis !== "lifetime") throw new Error("Meteora debe usar fees acumuladas.");
const ACTIVE_SOURCE = radarConfig.source;

const HOST = "127.0.0.1";
const PORT = Number(process.env.BOT_PROXY_PORT || 3001);
const UPSTREAM = "https://damm-v2.datapi.meteora.ag/pools";
const PAGE_SIZE = 1000;
const MIN_FEES_USD = 500;
const AXIOM_SOL_PER_METEORA_FEE_USD = 0.00032555404584;
const TAX_REFERENCE_PCT = 0.1;
const SOL_PRICE_FALLBACK_USD = 94.36;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_MS = 60_000;
const ARCHIVE_URL = new URL("../data/meteora-token-history.json", import.meta.url);
const ARCHIVE_DIR = new URL("../data/", import.meta.url);
const TEMP_URL = new URL("../data/meteora-token-history.json.tmp", import.meta.url);
const AXIOM_ARCHIVE_URL = new URL("../data/axiom-token-history.json", import.meta.url);
const AXIOM_TEMP_URL = new URL("../data/axiom-token-history.json.tmp", import.meta.url);
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // Wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
]);
let archive = { version: 3, updatedAt: null, scans: 0, latestTokens: [], tokens: [], legacyTokens: [] };
let lastScanError = null;
let scanInFlight = null;
let lastUpstreamRequestAt = 0;
let axiomArchive = { version: 1, updatedAt: null, tokens: [] };
let axiomWriteQueue = Promise.resolve();

function record(value) {
  return value && typeof value === "object" ? value : {};
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const numeric = Number(value);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function metric24h(value) {
  if (typeof value === "number") return value;
  const source = record(value);
  for (const key of ["24h", "24H", "h24", "day", "total"]) {
    const result = Number(source[key]);
    if (Number.isFinite(result) && result !== 0) return result;
  }
  return 0;
}

function fees24h(pool) {
  // Meteora's USD-denominated pool swap fees for the last 24h.
  // Never fall back to volume: traded volume is not revenue/fees.
  for (const key of ["fee_24h", "fees_24h", "fee24h", "fees24h"]) {
    const result = Number(pool[key]);
    if (Number.isFinite(result) && result !== 0) return result;
  }
  return metric24h(pool.fees ?? pool.fee);
}

function cumulativeFeesUsd(pool) {
  return Number(record(pool.cumulative_metrics).fees) || 0;
}

function cumulativeVolumeUsd(pool) {
  return Number(record(pool.cumulative_metrics).volume) || 0;
}

function tokenInfo(value) {
  const token = record(value);
  return {
    address: String(token.address ?? token.mint ?? token.token_address ?? ""),
    name: String(token.name ?? token.symbol ?? "Token"),
    symbol: String(token.symbol ?? token.name ?? "TOKEN"),
    image: typeof token.image === "string" ? token.image : null,
    priceUsd: Number(token.price) > 0 ? Number(token.price) : null,
  };
}

function poolRows(payload) {
  const pools = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return pools.map((entry) => {
    const pool = record(entry);
    const tokenX = tokenInfo(pool.token_x ?? pool.tokenA ?? pool.token_a);
    const tokenY = tokenInfo(pool.token_y ?? pool.tokenB ?? pool.token_b);
    const poolTaxRate = pool.pool_config?.base_fee_pct ?? pool.fee_pct ?? pool.dynamic_fee_pct;
    return {
      poolAddress: String(pool.address ?? pool.pool_address ?? ""),
      pair: String(pool.name ?? pool.pair ?? `${tokenX.symbol}/${tokenY.symbol}`),
      tokenX,
      tokenY,
      currentPrice: Number(pool.current_price) > 0 ? Number(pool.current_price) : null,
      fees24hUsd: fees24h(pool),
      volume24hUsd: metric24h(pool.volume_24h ?? pool.volume),
      globalFeesPaidUsd: cumulativeFeesUsd(pool),
      globalVolumeUsd: cumulativeVolumeUsd(pool),
      taxRatePct: poolTaxRate != null && Number.isFinite(Number(poolTaxRate))
        ? Number(poolTaxRate)
        : null,
      liquidityUsd: Number(pool.tvl ?? pool.liquidity ?? 0) || 0,
      poolCreatedAt: pool.pool_created_at ?? pool.created_at ?? null,
    };
  }).filter((pool) => pool.poolAddress && pool.tokenX.address && pool.tokenY.address);
}

async function fetchPools({ filterBy, query } = {}) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(UPSTREAM);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (filterBy) url.searchParams.set("filter_by", filterBy);
    if (query) url.searchParams.set("query", query);
    const waitMs = Math.max(0, 120 - (Date.now() - lastUpstreamRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastUpstreamRequestAt = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Meteora respondió ${response.status}.`);
    const payload = await response.json();
    const rawRows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    const pageRows = poolRows(payload);
    all.push(...pageRows);
    if (rawRows.length < PAGE_SIZE) break;
    if (Number(payload?.pages) > 0 && page >= Number(payload.pages)) break;
  }
  return all;
}

function tokenCandidates(pools) {
  const byMint = new Map();
  for (const pool of pools) {
    const tokens = [pool.tokenX, pool.tokenY].filter((token) => !QUOTE_MINTS.has(token.address));
    for (const token of tokens) {
      const taxRatePctForToken = pool.taxRatePct;
      const current = byMint.get(token.address);
      const poolsSeen = (current?.poolsSeen ?? 0) + 1;
      const globalFeesPaidUsd = (current?.globalFeesPaidUsd ?? 0) + pool.globalFeesPaidUsd;
      const globalVolumeUsd = (current?.globalVolumeUsd ?? 0) + pool.globalVolumeUsd;
      const knownTaxBaseUsd = (current?.knownTaxBaseUsd ?? 0)
        + (taxRatePctForToken == null ? 0 : pool.globalFeesPaidUsd);
      const weightedTaxPct = (current?.weightedTaxPct ?? 0)
        + (taxRatePctForToken == null ? 0 : pool.globalFeesPaidUsd * taxRatePctForToken);
      const taxRatePct = knownTaxBaseUsd > 0 ? weightedTaxPct / knownTaxBaseUsd : null;
      const fees24hUsd = (current?.fees24hUsd ?? 0) + pool.fees24hUsd;
      const representative = !current || pool.globalFeesPaidUsd > current.representativePoolFeesUsd ? pool : current;
      byMint.set(token.address, {
        ...representative,
        mint: token.address,
        token,
        poolsSeen,
        globalFeesPaidUsd,
        globalVolumeUsd,
        axiomGlobalFeesPaidUsd: null,
        axiomGlobalFeesPaidSol: globalFeesPaidUsd * AXIOM_SOL_PER_METEORA_FEE_USD,
        axiomAfterTaxFeesUsd: null,
        axiomAfterTaxFeesSol: taxRatePct == null
          ? null
          : globalFeesPaidUsd * AXIOM_SOL_PER_METEORA_FEE_USD * (taxRatePct / 100),
        taxRatePct,
        knownTaxBaseUsd,
        weightedTaxPct,
        fees24hUsd,
        representativePoolFeesUsd: representative.globalFeesPaidUsd,
      });
    }
  }
  return [...byMint.values()];
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function fetchTokenPools(mint) {
  return fetchPools({ query: mint });
}

async function loadArchive() {
  try {
    const parsed = JSON.parse(await readFile(ARCHIVE_URL, "utf8"));
    if (parsed?.version === 3 && Array.isArray(parsed.tokens)) {
      const solPriceUsd = Number(parsed.solPriceUsd) > 0 ? Number(parsed.solPriceUsd) : SOL_PRICE_FALLBACK_USD;
      const nowIso = new Date().toISOString();
      const normalizedTokens = parsed.tokens.map((token) => {
        const feesUsd = Number(token.globalFeesPaidUsd);
        const taxRatePct = token.taxRatePct == null ? null : Number(token.taxRatePct);
        const estimatedSol = Number.isFinite(feesUsd) ? feesUsd * AXIOM_SOL_PER_METEORA_FEE_USD : null;
        const estimatedUsd = estimatedSol == null ? null : estimatedSol * solPriceUsd;
        const afterTaxSol = estimatedSol == null || taxRatePct == null ? null : estimatedSol * taxRatePct / 100;
        const afterTaxUsd = afterTaxSol == null ? null : afterTaxSol * solPriceUsd;
        return {
          ...token,
          axiomGlobalFeesPaidSol: estimatedSol,
          axiomGlobalFeesPaidUsd: estimatedUsd,
          axiomAfterTaxFeesSol: afterTaxSol,
          axiomAfterTaxFeesUsd: afterTaxUsd,
          firstQualifiedAt: token.axiomAfterTaxFeesUsd == null && afterTaxUsd >= MIN_FEES_USD
            ? nowIso
            : token.firstQualifiedAt,
          lastQualifiedAt: token.axiomAfterTaxFeesUsd == null && afterTaxUsd >= MIN_FEES_USD
            ? nowIso
            : token.lastQualifiedAt,
        };
      });
      const cutoff = Date.now() - RETENTION_MS;
      const qualifying = normalizedTokens
        .filter((token) => Number(token.axiomAfterTaxFeesUsd) >= MIN_FEES_USD)
        .filter((token) => Date.parse(token.lastQualifiedAt ?? token.firstQualifiedAt) >= cutoff);
      archive = {
        ...parsed,
        solPriceUsd,
        tokens: qualifying.sort((left, right) => Number(left.axiomAfterTaxFeesUsd) - Number(right.axiomAfterTaxFeesUsd)),
        latestTokens: [...qualifying]
          .sort((left, right) => Date.parse(right.lastQualifiedAt ?? right.firstQualifiedAt) - Date.parse(left.lastQualifiedAt ?? left.firstQualifiedAt))
          .slice(0, 50),
      };
      await saveArchive();
    }
    else if (Array.isArray(parsed?.tokens)) {
      const legacyByMint = new Map();
      for (const token of [...(parsed.legacyTokens ?? []), ...parsed.tokens]) {
        if (token?.mint) legacyByMint.set(token.mint, token);
      }
      archive = {
        version: 3,
        updatedAt: parsed.updatedAt ?? null,
        scans: parsed.scans ?? 0,
        latestTokens: [],
        tokens: [],
        legacyTokens: [...legacyByMint.values()],
      };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Could not read token archive:", error);
  }
}

async function saveArchive() {
  await mkdir(ARCHIVE_DIR, { recursive: true });
  await writeFile(TEMP_URL, JSON.stringify(archive, null, 2), "utf8");
  await rename(TEMP_URL, ARCHIVE_URL);
}

async function loadAxiomArchive() {
  try {
    const parsed = JSON.parse(await readFile(AXIOM_ARCHIVE_URL, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.tokens)) {
      const cutoff = Date.now() - RETENTION_MS;
      axiomArchive = {
        version: 1,
        updatedAt: parsed.updatedAt ?? null,
        tokens: parsed.tokens.filter((token) => Date.parse(token.lastSeenAt) >= cutoff),
      };
      await saveAxiomArchive();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Could not read Axiom archive:", error);
  }
}

async function saveAxiomArchive() {
  await mkdir(ARCHIVE_DIR, { recursive: true });
  await writeFile(AXIOM_TEMP_URL, JSON.stringify(axiomArchive, null, 2), "utf8");
  await rename(AXIOM_TEMP_URL, AXIOM_ARCHIVE_URL);
}

async function readJsonBody(request, maxBytes = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("El envío de Axiom supera el tamaño permitido.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function storeAxiomObservation(input) {
  if (input?.chain !== "sol" || input?.stage !== "migrated" || input?.protocol !== "Meteora AMM V2") {
    throw new Error("Solo se archivan Migrated de Solana y Meteora AMM V2 confirmados en Axiom.");
  }
  const mint = String(input?.mint ?? "").trim();
  const feesSol = Number(input?.globalFeesPaidSol);
  const suppliedTaxMin = input?.taxRatePctMin ?? input?.taxRatePct;
  const suppliedTaxMax = input?.taxRatePctMax ?? input?.taxRatePct;
  const taxRatePctMin = suppliedTaxMin == null ? null : Number(suppliedTaxMin);
  const taxRatePctMax = suppliedTaxMax == null ? null : Number(suppliedTaxMax);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || !Number.isFinite(feesSol) || feesSol < 0) {
    throw new Error("El contrato o Global Fees Paid recibido de Axiom no es válido.");
  }
  if ((taxRatePctMin != null && (!Number.isFinite(taxRatePctMin) || taxRatePctMin < 0 || taxRatePctMin > 100))
    || (taxRatePctMax != null && (!Number.isFinite(taxRatePctMax) || taxRatePctMax < 0 || taxRatePctMax > 100))) {
    throw new Error("El tax recibido de Axiom debe estar entre 0% y 100%.");
  }

  const now = new Date().toISOString();
  const existing = new Map(axiomArchive.tokens.map((token) => [token.mint, token]));
  const old = existing.get(mint);
  const useIncoming = !old || old.pairAddress === input.pairAddress || feesSol >= old.axiomGlobalFeesPaidSol;
  const storedTaxMin = !useIncoming ? old.taxRatePctMin : input.taxPending ? null : taxRatePctMin ?? old?.taxRatePctMin ?? null;
  const storedTaxMax = !useIncoming ? old.taxRatePctMax : input.taxPending ? null : taxRatePctMax ?? (taxRatePctMin != null ? taxRatePctMin : old?.taxRatePctMax ?? storedTaxMin);
  existing.set(mint, {
    ...old,
    mint,
    name: String(input?.name ?? old?.name ?? "Token").slice(0, 100),
    symbol: String(input?.symbol ?? old?.symbol ?? "").slice(0, 32),
    axiomGlobalFeesPaidSol: useIncoming ? feesSol : old.axiomGlobalFeesPaidSol,
    pairAddress: useIncoming ? String(input.pairAddress ?? "") : old.pairAddress,
    chain: "sol",
    stage: "migrated",
    protocol: "Meteora AMM V2",
    taxRatePctMin: storedTaxMin,
    taxRatePctMax: storedTaxMax,
    taxObservedAt: !useIncoming || taxRatePctMin == null ? old?.taxObservedAt ?? null : now,
    firstSeenAt: old?.firstSeenAt ?? now,
    lastSeenAt: now,
    observations: (old?.observations ?? 0) + 1,
    source: "axiom-pulse-state",
  });

  const cutoff = Date.now() - RETENTION_MS;
  axiomArchive = {
    version: 1,
    updatedAt: now,
    tokens: [...existing.values()]
      .filter((token) => Date.parse(token.lastSeenAt) >= cutoff)
      .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)),
  };
  await saveAxiomArchive();
  return existing.get(mint);
}

function solPriceFromPools(pools) {
  const wrappedSol = "So11111111111111111111111111111111111111112";
  const stableMints = new Set([
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
  ]);
  for (const pool of pools) {
    if (pool.tokenX.address === wrappedSol && pool.tokenX.priceUsd > 0) return pool.tokenX.priceUsd;
    if (pool.tokenY.address === wrappedSol && pool.tokenY.priceUsd > 0) return pool.tokenY.priceUsd;
    const hasSolAndStable = (pool.tokenX.address === wrappedSol && stableMints.has(pool.tokenY.address))
      || (pool.tokenY.address === wrappedSol && stableMints.has(pool.tokenX.address));
    if (hasSolAndStable && pool.currentPrice) {
      return pool.currentPrice > 1 ? pool.currentPrice : 1 / pool.currentPrice;
    }
  }
  return null;
}

async function fetchSolPriceUsd(pools) {
  const fromMeteora = solPriceFromPools(pools);
  if (fromMeteora) return fromMeteora;
  try {
    const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const price = Number((await response.json())?.price);
      if (price > 0) return price;
    }
  } catch {}
  try {
    const response = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const price = Number((await response.json())?.data?.amount);
      if (price > 0) return price;
    }
  } catch {}
  return archive.solPriceUsd ?? SOL_PRICE_FALLBACK_USD;
}

async function refreshArchive() {
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      // Read all DAMM v2 pools so inactive pools still contribute their
      // lifetime fees to each token's Global Fees Paid total.
      const pools = await fetchPools();
      const solPriceUsd = await fetchSolPriceUsd(pools);
      const candidates = tokenCandidates(pools).map((candidate) => {
        const estimatedSol = candidate.axiomGlobalFeesPaidSol;
        const estimatedUsd = estimatedSol == null ? null : estimatedSol * (solPriceUsd ?? SOL_PRICE_FALLBACK_USD);
        const afterTaxSol = candidate.taxRatePct == null ? null : estimatedSol * candidate.taxRatePct / 100;
        const afterTaxUsd = afterTaxSol == null ? null : afterTaxSol * (solPriceUsd ?? SOL_PRICE_FALLBACK_USD);
        return {
          ...candidate,
          axiomGlobalFeesPaidUsd: Number.isFinite(estimatedUsd) ? estimatedUsd : null,
          axiomGlobalFeesPaidSol: Number.isFinite(estimatedSol) ? estimatedSol : null,
          axiomAfterTaxFeesUsd: Number.isFinite(afterTaxUsd) ? afterTaxUsd : null,
          axiomAfterTaxFeesSol: Number.isFinite(afterTaxSol) ? afterTaxSol : null,
        };
      });
      const observed = candidates.filter((candidate) => candidate.axiomAfterTaxFeesUsd >= MIN_FEES_USD);
      const existing = new Map(archive.tokens.map((token) => [token.mint, token]));

      for (const candidate of candidates) {
        const old = existing.get(candidate.mint);
        if (candidate.axiomAfterTaxFeesUsd < MIN_FEES_USD && !old) continue;
        const qualifies = candidate.axiomAfterTaxFeesUsd >= MIN_FEES_USD;
        existing.set(candidate.mint, {
          ...old,
          mint: candidate.mint,
          name: candidate.token.name,
          symbol: candidate.token.symbol,
          image: candidate.token.image,
          pair: candidate.pair,
          poolAddress: candidate.poolAddress,
          tokenX: candidate.tokenX,
          tokenY: candidate.tokenY,
          globalFeesPaidUsd: Math.max(old?.globalFeesPaidUsd ?? 0, candidate.globalFeesPaidUsd),
          globalVolumeUsd: Math.max(old?.globalVolumeUsd ?? 0, candidate.globalVolumeUsd),
          axiomGlobalFeesPaidUsd: candidate.axiomGlobalFeesPaidUsd,
          axiomGlobalFeesPaidSol: candidate.axiomGlobalFeesPaidSol,
          axiomAfterTaxFeesUsd: candidate.axiomAfterTaxFeesUsd,
          axiomAfterTaxFeesSol: candidate.axiomAfterTaxFeesSol,
          taxRatePct: candidate.taxRatePct,
          effectiveFeePct: candidate.globalVolumeUsd > 0 ? (candidate.globalFeesPaidUsd / candidate.globalVolumeUsd) * 100 : 0,
          poolsCount: candidate.poolsSeen,
          fees24hUsd: candidate.fees24hUsd,
          volume24hUsd: candidate.volume24hUsd,
          liquidityUsd: candidate.liquidityUsd,
          poolCreatedAt: candidate.poolCreatedAt,
          firstQualifiedAt: old?.firstQualifiedAt ?? (qualifies ? nowIso : null),
          lastObservedAt: nowIso,
          lastQualifiedAt: qualifies ? nowIso : old?.lastQualifiedAt ?? null,
          observations: (old?.observations ?? 0) + 1,
          qualifyingObservations: (old?.qualifyingObservations ?? 0) + (qualifies ? 1 : 0),
        });
      }

      const cutoff = now.getTime() - RETENTION_MS;
      archive = {
        version: 3,
        updatedAt: nowIso,
        scans: (archive.scans ?? 0) + 1,
        solPriceUsd,
        legacyTokens: (archive.legacyTokens ?? []).filter((token) => Date.parse(token.lastQualifiedAt ?? token.firstQualifiedAt) >= cutoff),
        latestTokens: [...existing.values()]
          .filter((token) => Number(token.axiomAfterTaxFeesUsd) >= MIN_FEES_USD)
          .sort((left, right) => Date.parse(right.lastQualifiedAt ?? right.firstQualifiedAt) - Date.parse(left.lastQualifiedAt ?? left.firstQualifiedAt))
          .slice(0, 50),
        tokens: [...existing.values()]
          .filter((token) => Number(token.axiomAfterTaxFeesUsd) >= MIN_FEES_USD)
          .filter((token) => Date.parse(token.lastQualifiedAt ?? token.firstQualifiedAt) >= cutoff)
          .sort((left, right) => Number(left.axiomAfterTaxFeesUsd) - Number(right.axiomAfterTaxFeesUsd)),
      };
      lastScanError = null;
      await saveArchive();
      console.log(`Meteora scan ${archive.scans}: ${observed.length} estimated Axiom-fee tokens with >= $${MIN_FEES_USD}; ${archive.tokens.length} archived.`);
    } catch (error) {
      lastScanError = error instanceof Error ? error.message : "No se pudo actualizar el archivo de tokens.";
      console.error("Meteora archive scan failed:", lastScanError);
    }
  })().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

const archiveReady = Promise.resolve();
const axiomArchiveReady = ACTIVE_SOURCE === "axiom" ? loadAxiomArchive() : Promise.resolve();
let axiomSolPriceUsd = null;
let axiomSolPriceUpdatedAt = 0;
let axiomPriceAttemptAt = 0;
const meteoraReader = ACTIVE_SOURCE === "meteora" ? new MeteoraReader({ minFeesUsd: radarConfig.meteoraMinFeesUsd, lookbackDays: radarConfig.meteoraLookbackDays }) : null;
let axiomReader = null;
if (ACTIVE_SOURCE === "axiom") {
  const { NativeAxiomReader } = await import("./axiom-native-reader.mjs");
  axiomReader = new NativeAxiomReader(async (input) => {
    await axiomArchiveReady;
    const write = axiomWriteQueue.then(() => storeAxiomObservation(input));
    axiomWriteQueue = write.catch(() => {});
    return write;
  });
}
const activeReader = meteoraReader ?? axiomReader;
const tokenMetadataReader = meteoraReader ? new TokenMetadataReader(() => meteoraReader.snapshot().tokens) : null;

async function getAxiomSolPriceUsd() {
  if (axiomSolPriceUsd && Date.now() - axiomSolPriceUpdatedAt < 60_000) return axiomSolPriceUsd;
  const cached = () => axiomSolPriceUsd && Date.now() - axiomSolPriceUpdatedAt <= 300_000 ? axiomSolPriceUsd : null;
  if (Date.now() - axiomPriceAttemptAt < 30_000) return cached();
  axiomPriceAttemptAt = Date.now();
  for (const [url, pick] of [
    ["https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", (data) => data?.price],
    ["https://api.coinbase.com/v2/prices/SOL-USD/spot", (data) => data?.data?.amount],
  ]) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const price = Number(pick(await response.json()));
        if (Number.isFinite(price) && price > 0) {
          axiomSolPriceUsd = price;
          axiomSolPriceUpdatedAt = Date.now();
          return price;
        }
      }
    } catch {}
  }
  return cached();
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && ["/api/axiom/health", "/api/radar/health"].includes(pathname)) {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ service: "moneypoly-axiom-reader", pid: process.pid,
      source: ACTIVE_SOURCE, uptimeSeconds: Math.floor(process.uptime()), reader: activeReader.getStatus(), socialMetadata: tokenMetadataReader?.status }));
    return;
  }
  if (request.method === "GET" && meteoraReader && ["/api/radar/tokens", "/api/meteora/tokens", "/api/bot/tokens"].includes(pathname)) {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    const snapshot = meteoraReader.snapshot();
    const tokens = snapshot.tokens.map((token) => tokenMetadataReader.attach(token))
      .filter((token) => Boolean(token.tokenMetadata?.websiteUrl || token.tokenMetadata?.twitterUsername));
    const createdAt = (token) => {
      const value = token.poolCreatedAt;
      if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
      return Date.parse(value || token.firstSeenAt) || 0;
    };
    const cutoff = Date.now() - snapshot.lookbackDays * 24 * 60 * 60 * 1000;
    const latestTokens = tokens.filter((token) => createdAt(token) >= cutoff && createdAt(token) <= Date.now())
      .sort((a, b) => createdAt(b) - createdAt(a)).slice(0, 50);
    response.end(JSON.stringify({ ...snapshot, tokens, latestTokens, totalCaptured: tokens.length,
      linkRequirement: "website-or-x", socialMetadata: tokenMetadataReader.status }));
    return;
  }
  if (pathname.startsWith("/api/axiom/") && !axiomReader) {
    response.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Axiom está en pausa. La fuente activa es Meteora; su implementación y archivo de Axiom se conservan." }));
    return;
  }
  if (request.method === "POST" && pathname === "/api/axiom/connect") {
    const origin = request.headers.origin;
    if (origin && !["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin)) {
      response.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Abre la conexión desde MoneyPoly local." }));
      return;
    }
    axiomReader.start(true).catch((error) => console.error("Axiom reader:", error.message));
    response.writeHead(202, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ reader: axiomReader.getStatus() }));
    return;
  }
  if (request.method === "POST" && pathname === "/api/axiom/background") {
    const origin = request.headers.origin;
    if (origin && !["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin)) {
      response.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Usa el monitor local." }));
      return;
    }
    try {
      await axiomReader.setBackground(true);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ reader: axiomReader.getStatus() }));
    } catch {
      response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "La ventana del lector no está disponible." }));
    }
    return;
  }
  if (request.method === "POST" && pathname === "/api/axiom/observations") {
    try {
      await axiomArchiveReady;
      const input = await readJsonBody(request);
      const write = axiomWriteQueue.then(() => storeAxiomObservation(input));
      axiomWriteQueue = write.catch(() => {});
      const token = await write;
      response.writeHead(202, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ accepted: true, mint: token.mint, observations: token.observations }));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "No se pudo guardar el dato de Axiom." }));
    }
    return;
  }

  if (request.method === "GET" && ["/api/axiom/tokens", "/api/radar/tokens"].includes(pathname)) {
    try {
      await axiomArchiveReady;
      await axiomWriteQueue;
      const solPriceUsd = await getAxiomSolPriceUsd();
      const cutoff = Date.now() - RETENTION_MS;
      const captured = axiomArchive.tokens
        .filter((token) => token.chain === "sol" && token.stage === "migrated" && token.protocol === "Meteora AMM V2" && Date.parse(token.lastSeenAt) >= cutoff)
        .map((token) => {
          const taxMin = token.taxRatePctMin == null ? null : Number(token.taxRatePctMin);
          const taxMax = token.taxRatePctMax == null ? taxMin : Number(token.taxRatePctMax);
          const afterTaxSolMin = taxMin == null ? null : token.axiomGlobalFeesPaidSol * taxMin / 100;
          const afterTaxSolMax = taxMax == null ? null : token.axiomGlobalFeesPaidSol * taxMax / 100;
          return {
            ...token,
            axiomGlobalFeesPaidUsd: solPriceUsd == null ? null : token.axiomGlobalFeesPaidSol * solPriceUsd,
            axiomAfterTaxFeesSolMin: afterTaxSolMin,
            axiomAfterTaxFeesSolMax: afterTaxSolMax,
            axiomAfterTaxFeesUsdMin: afterTaxSolMin == null || solPriceUsd == null ? null : afterTaxSolMin * solPriceUsd,
            axiomAfterTaxFeesUsdMax: afterTaxSolMax == null || solPriceUsd == null ? null : afterTaxSolMax * solPriceUsd,
          };
        });
      const qualifying = captured
        .filter((token) => Number(token.axiomAfterTaxFeesUsdMin) >= MIN_FEES_USD)
        .sort((left, right) => right.axiomAfterTaxFeesUsdMin - left.axiomAfterTaxFeesUsdMin);
      const latestQualified = [...qualifying]
        .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
        .slice(0, 50);
      const latestObservation = captured.reduce((latest, token) =>
        !latest || Date.parse(token.lastSeenAt) > Date.parse(latest) ? token.lastSeenAt : latest, null);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({
        source: "axiom", feeBasis: "axiom-tax",
        tokens: qualifying,
        latestTokens: latestQualified,
        totalCaptured: captured.length,
        taxPendingCount: captured.filter((token) => token.taxRatePctMin == null).length,
        refreshedAt: axiomArchive.updatedAt,
        latestObservation,
        captureConnected: latestObservation != null && Date.now() - Date.parse(latestObservation) < 120_000,
        reader: axiomReader.getStatus(),
        retentionDays: RETENTION_MS / (24 * 60 * 60 * 1000),
        minFeesUsd: MIN_FEES_USD,
        solPriceUsd,
        solPriceUpdatedAt: axiomSolPriceUpdatedAt ? new Date(axiomSolPriceUpdatedAt).toISOString() : null,
      }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "No se pudo leer el archivo directo de Axiom." }));
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/bot/tokens") {
    response.writeHead(410, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "La estimación basada en Meteora está desactivada. Usa la captura directa de Axiom." }));
    return;
  }

  if (request.method !== "GET") {
    response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, HOST, async () => {
  console.log(`MoneyPoly ${ACTIVE_SOURCE} reader listening on http://${HOST}:${PORT}`);
  await Promise.all([archiveReady, axiomArchiveReady]);
  activeReader.start().then(() => tokenMetadataReader?.start()).catch((error) => console.error(`${ACTIVE_SOURCE} reader:`, error.message));
});

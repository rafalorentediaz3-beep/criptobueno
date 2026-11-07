import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const API = "https://damm-v2.datapi.meteora.ag/pools";
const ARCHIVE = new URL("../data/meteora-direct-token-history.json", import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 1000;
const METEORA_LAUNCHPAD = "met-dbc";
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const QUOTES = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
]);

export function poolCreatedMs(value) {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric < 1e12 ? numeric * 1000 : numeric : NaN;
  }
  return typeof value === "string" ? Date.parse(value) : NaN;
}

export function meteoraCandidates(pools, minFeesUsd = 3500, { now = Date.now(), lookbackDays = 150 } = {}) {
  const byMint = new Map();
  const seenPools = new Set();
  for (const pool of pools) {
    if (!MINT.test(pool?.address) || seenPools.has(pool.address) || pool.is_blacklisted === true) continue;
    seenPools.add(pool.address);
    const launchpad = typeof pool.launchpad === "string" ? pool.launchpad.trim().toLowerCase() : "";
    if (launchpad !== METEORA_LAUNCHPAD) continue;
    const createdAt = poolCreatedMs(pool.created_at);
    if (!Number.isFinite(createdAt) || createdAt < now - lookbackDays * DAY_MS || createdAt > now) continue;
    // Only the API's cumulative USD fee metric qualifies a pool. Neither volume,
    // 24h fees nor any estimated Axiom conversion can replace a missing value.
    const feesUsd = pool.cumulative_metrics?.fees;
    if (typeof feesUsd !== "number" || !Number.isFinite(feesUsd) || feesUsd < minFeesUsd) continue;
    const pair = [pool.token_x, pool.token_y];
    for (const token of pair) {
      if (!MINT.test(token?.address) || QUOTES.has(token.address)) continue;
      const previous = byMint.get(token.address);
      if (previous && previous.feesUsd >= feesUsd) continue;
      byMint.set(token.address, {
        mint: token.address,
        name: String(token.name || token.symbol || "Token").slice(0, 100),
        symbol: String(token.symbol || "").slice(0, 32),
        poolAddress: pool.address,
        poolCreatedAt: createdAt,
        launchpad,
        chain: "sol", protocol: "Meteora AMM V2", source: "meteora",
        feeBasis: "lifetime", feesUsd,
        // Supplementary information only; it does not determine eligibility.
        fees24hUsd: typeof pool.fees?.["24h"] === "number" ? pool.fees["24h"] : null,
      });
    }
  }
  return [...byMint.values()];
}

export class MeteoraReader {
  constructor({ minFeesUsd = 3500, lookbackDays = 150, archiveUrl = ARCHIVE, fetcher = fetch, clock = Date.now } = {}) {
    if (!Number.isFinite(minFeesUsd) || minFeesUsd < 0) throw new Error("Mínimo de fees Meteora no válido.");
    if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) throw new Error("Ventana de descubrimiento Meteora no válida.");
    this.minFeesUsd = minFeesUsd;
    this.lookbackDays = lookbackDays;
    this.clock = clock;
    this.archiveUrl = archiveUrl;
    this.fetcher = fetcher;
    this.tokens = new Map();
    this.revision = 0;
    this.savedRevision = -1;
    this.requestQueue = Promise.resolve();
    this.writeQueue = Promise.resolve();
    this.lastRequestAt = 0;
    this.status = {
      state: "starting", engine: "meteora-api", requiresChrome: false,
      message: "Conectando con la API de Meteora…", pollIntervalMs: POLL_INTERVAL_MS,
      fullScanIntervalMs: 15 * 60 * 1000, lastPollAt: null, lastFullScanAt: null,
      fullScan: { running: false, pagesScanned: 0, pagesTotal: null, poolsScanned: 0, poolsTotal: null },
    };
  }

  getStatus() {
    const stale = this.status.lastPollAt && this.clock() - Date.parse(this.status.lastPollAt) > POLL_INTERVAL_MS * 2;
    return { ...this.status, ...(stale ? { state: "waiting_data", message: "La búsqueda de nuevos tokens está en espera. El archivo acumulado se conserva." } : {}) };
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.archiveUrl, "utf8"));
      if ([1, 2].includes(saved.version) && Array.isArray(saved.tokens)) {
        if (saved.version === 1) {
          // Keep the entire previous archive before applying the 150-day admission
          // rule. COPYFILE_EXCL prevents overwriting that original backup later.
          try { await copyFile(this.archiveUrl, new URL(this.archiveUrl.href + ".before-150d.json"), constants.COPYFILE_EXCL); }
          catch (error) { if (error.code !== "EEXIST") throw error; }
        }
        for (const token of saved.tokens) {
          const createdAt = poolCreatedMs(token.poolCreatedAt);
          const eligibleMigration = saved.version === 2 || (Number.isFinite(createdAt)
            && createdAt >= this.clock() - this.lookbackDays * DAY_MS && createdAt <= this.clock());
          if (token.source === "meteora" && token.feeBasis === "lifetime"
              && MINT.test(token.mint) && eligibleMigration
              && Number.isFinite(token.feesUsd) && token.feesUsd >= this.minFeesUsd) {
            this.tokens.set(token.mint, saved.version === 2 ? token : {
              ...token, poolCreatedAt: createdAt,
              savedAt: token.lastSeenAt || token.firstSeenAt || new Date(this.clock()).toISOString(),
              frozen: true,
            });
          }
        }
        if (saved.version === 2) this.savedRevision = this.revision;
      }
    } catch (error) {
      // Never overwrite an unreadable existing archive with an empty one.
      if (error.code !== "ENOENT") throw error;
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    await this.load();
    await this.save();
    // Frequent discovery and a separate, paginated full sweep. The full sweep
    // has no arbitrary 100-page cap and never keeps the entire pool universe in RAM.
    void this.poll();
    this.sweepTimer = setTimeout(() => void this.fullScan(), 1000);
  }

  async requestPage(page, sortBy) {
    const task = this.requestQueue.then(async () => {
      if (this.stopped) throw new Error("Lector detenido");
      const delay = Math.max(0, 180 - (Date.now() - this.lastRequestAt));
      if (delay) await new Promise((done) => setTimeout(done, delay));
      const url = new URL(API);
      url.searchParams.set("page", String(page));
      url.searchParams.set("page_size", String(PAGE_SIZE));
      url.searchParams.set("sort_by", sortBy);
      this.lastRequestAt = Date.now();
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
      if (!response.ok) throw new Error(`Meteora respondió HTTP ${response.status}.`);
      const data = await response.json();
      if (!Array.isArray(data.data) || !Number.isInteger(data.pages) || data.pages < 0) throw new Error("Meteora ha devuelto una lista de pools incompatible.");
      return data;
    });
    this.requestQueue = task.catch(() => {});
    return task;
  }

  observe(pools) {
    const now = new Date(this.clock()).toISOString();
    for (const token of meteoraCandidates(pools, this.minFeesUsd, { now: this.clock(), lookbackDays: this.lookbackDays })) {
      // Append once per contract. Re-reading a token never changes its fees,
      // dates, chosen pool or observation count, and never extends its lifetime.
      if (this.tokens.has(token.mint)) continue;
      this.tokens.set(token.mint, {
        ...token, firstSeenAt: now, lastSeenAt: now, savedAt: now,
        observations: 1, frozen: true,
      });
      this.revision++;
    }
    this.status.state = "receiving";
    this.status.message = `Buscando nuevos tokens de los últimos ${this.lookbackDays} días en Meteora. Archivo acumulativo.`;
    this.status.lastPollAt = now;
    this.status.lastError = null;
  }

  save() {
    const task = this.writeQueue.then(async () => {
      if (this.savedRevision === this.revision) return;
      await mkdir(new URL("./", this.archiveUrl), { recursive: true });
      const revision = this.revision;
      const temporary = new URL(this.archiveUrl.href + ".tmp");
      await writeFile(temporary, JSON.stringify({ version: 2, source: "meteora", feeBasis: "lifetime", minFeesUsd: this.minFeesUsd,
        lookbackDays: this.lookbackDays, archivePolicy: "append-only", frozenRecords: true,
        updatedAt: this.status.lastPollAt, tokens: [...this.tokens.values()] }, null, 2), "utf8");
      await rename(temporary, this.archiveUrl);
      this.savedRevision = revision;
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  failure(error) {
    if (this.stopped) return;
    this.status.lastError = error.message;
    this.status.state = "waiting_data";
    this.status.message = "No se pudo actualizar Meteora: " + error.message;
  }

  async poll() {
    if (this.stopped) return;
    const startedAt = Date.now();
    try {
      // Active pools plus newly created pools. The independent sweep below also
      // recovers old/inactive pools whose accumulated fees already qualify.
      for (const sortBy of ["fee_24h:desc", "pool_created_at:desc"]) {
        const data = await this.requestPage(1, sortBy);
        if (this.stopped) return;
        this.observe(data.data);
      }
      await this.save();
    } catch (error) { this.failure(error); }
    finally { if (!this.stopped) this.pollTimer = setTimeout(() => void this.poll(), Math.max(0, POLL_INTERVAL_MS - (Date.now() - startedAt))); }
  }

  async fullScan() {
    if (this.stopped) return;
    this.status.fullScan = { running: true, pagesScanned: 0, pagesTotal: null, poolsScanned: 0, poolsTotal: null };
    try {
      let page = 1, pages = 1;
      do {
        const data = await this.requestPage(page, "pool_created_at:desc");
        if (this.stopped) return;
        pages = Math.max(1, data.pages);
        this.observe(data.data);
        this.status.fullScan = { running: true, pagesScanned: page, pagesTotal: pages,
          poolsScanned: this.status.fullScan.poolsScanned + data.data.length, poolsTotal: data.total };
        await this.save();
        // With descending creation dates, a wholly older page ends the window.
        // Admission is checked per pool too, including dates on the boundary.
        const cutoff = this.clock() - this.lookbackDays * DAY_MS;
        if (data.data.length && data.data.every((pool) => poolCreatedMs(pool.created_at) < cutoff)) {
          this.status.fullScan.reachedLookbackLimit = true;
          break;
        }
        page++;
      } while (page <= pages && !this.stopped);
      if (!this.stopped) this.status.lastFullScanAt = new Date(this.clock()).toISOString();
    } catch (error) { this.failure(error); }
    finally {
      this.status.fullScan = { ...this.status.fullScan, running: false };
      if (!this.stopped) this.sweepTimer = setTimeout(() => void this.fullScan(), this.status.fullScanIntervalMs);
    }
  }

  snapshot() {
    const cutoff = this.clock() - this.lookbackDays * DAY_MS;
    const tokens = [...this.tokens.values()].filter((token) => token.feesUsd >= this.minFeesUsd
      && typeof token.launchpad === "string" && token.launchpad.trim().toLowerCase() === METEORA_LAUNCHPAD)
      .sort((a, b) => a.feesUsd - b.feesUsd);
    const created = (token) => {
      const raw = token.poolCreatedAt;
      if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
      return Date.parse(raw || token.firstSeenAt) || 0;
    };
    const reader = this.getStatus();
    return {
      source: "meteora", feeBasis: "lifetime", minFeesUsd: this.minFeesUsd, retentionDays: null,
      lookbackDays: this.lookbackDays, archivePolicy: "append-only", frozenRecords: true,
      tokens, latestTokens: tokens.filter((token) => created(token) >= cutoff && created(token) <= this.clock())
        .sort((a, b) => created(b) - created(a)).slice(0, 50),
      totalCaptured: tokens.length, latestObservation: this.status.lastPollAt,
      refreshedAt: this.status.lastPollAt, captureConnected: reader.state === "receiving", reader,
    };
  }

  stop() { this.stopped = true; clearTimeout(this.pollTimer); clearTimeout(this.sweepTimer); }
}

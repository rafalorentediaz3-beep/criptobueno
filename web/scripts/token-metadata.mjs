import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const CACHE = new URL("../data/token-social-metadata.json", import.meta.url);
const DAY = 86400000;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TARGETS = { meteora: { id: "1384042881808166924", username: "MeteoraAG" }, solana: { id: "951329744804392960", username: "solana" } };

export function publicUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function twitterHandle(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(url.hostname.toLowerCase())) return null;
    const handle = url.pathname.split("/").filter(Boolean)[0];
    if (!HANDLE.test(handle || "") || ["i", "intent", "share", "home", "search", "explore", "settings", "messages", "compose"].includes(handle.toLowerCase())) return null;
    return handle;
  } catch { return null; }
}

export function dexMetadata(token, pairs, checkedAt) {
  // A token can also be the quote side of an unrelated pair. Its base token's
  // socials must never be attributed to the requested mint in that case.
  const matches = pairs.filter((pair) => pair.chainId === "solana" && pair.baseToken?.address === token.mint && pair.info)
    .sort((a, b) => Number(b.pairAddress === token.poolAddress) - Number(a.pairAddress === token.poolAddress)
      || (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
  const pair = matches[0];
  const social = pair?.info.socials?.find((entry) => ["twitter", "x"].includes(entry.type?.toLowerCase()) && twitterHandle(entry.url));
  const username = social ? twitterHandle(social.url) : null;
  const tokenPage = publicUrl(pair?.url);
  return {
    mint: token.mint, name: token.name, symbol: token.symbol,
    tokenPageUrl: tokenPage && new URL(tokenPage).hostname === "dexscreener.com" ? tokenPage : `https://solscan.io/token/${token.mint}`,
    websiteUrl: publicUrl(pair?.info.websites?.[0]?.url),
    twitterUsername: username, twitterUrl: username ? `https://x.com/${username}` : null,
    associationSource: username ? "dexscreener-exact-mint" : null,
    associationCheckedAt: checkedAt, associationPair: pair?.pairAddress ?? null,
  };
}

export function blueVerification(user) {
  const verification = user?.verification;
  if (verification?.verified === false) return false;
  if (verification?.verified !== true) return null;
  if (verification.type === "individual") return true;
  if (["organization", "government"].includes(verification.type)) return false;
  return null;
}

export async function followingEvidence(username, request, maxPages = 20) {
  const found = { meteora: null, solana: null };
  const seen = new Set();
  let cursor = null, complete = false, pagesRead = 0;
  try {
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(username)}/following`);
      url.searchParams.set("count", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const data = await request(url.href);
      if (data.code !== 200 || !Array.isArray(data.results)) throw new Error("Lista de seguidos no disponible");
      pagesRead++;
      for (const user of data.results) {
        for (const [key, target] of Object.entries(TARGETS)) if (user.id === target.id) found[key] = true;
      }
      if (found.meteora && found.solana) return { followsMeteora: true, followsSolana: true, complete: false, pagesRead };
      // Only a confirmed end cursor can turn an absence into false. Empty,
      // unavailable, truncated or failed responses must not invent a negative.
      if (!data.cursor || !("bottom" in data.cursor)) break;
      const next = data.cursor.bottom;
      if (next === null || next === "" || /^0(?:\||$)/.test(next)) { complete = true; break; }
      if (typeof next !== "string" || seen.has(next) || data.results.length === 0) break;
      seen.add(next); cursor = next;
    }
  } catch {}
  return { followsMeteora: found.meteora ?? (complete ? false : null), followsSolana: found.solana ?? (complete ? false : null), complete, pagesRead };
}

export class TokenMetadataReader {
  constructor(listTokens, { fetcher = fetch, cacheUrl = CACHE, clock = Date.now } = {}) {
    this.listTokens = listTokens; this.fetcher = fetcher; this.cacheUrl = cacheUrl; this.clock = clock;
    this.metadata = new Map(); this.profiles = new Map(); this.lastRequestAt = 0;
    this.status = { state: "starting", message: "Preparando metadata y X asociados a los contratos…" };
  }

  async request(url) {
    const delay = Math.max(0, 250 - (Date.now() - this.lastRequestAt));
    if (delay) await new Promise((done) => setTimeout(done, delay));
    this.lastRequestAt = Date.now();
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(12000), redirect: "error" });
    if (!response.ok) throw new Error(`La fuente de metadata respondió HTTP ${response.status}.`);
    const text = await response.text();
    if (text.length > 8_000_000) throw new Error("Respuesta de metadata demasiado grande.");
    return JSON.parse(text);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      const saved = JSON.parse(await readFile(this.cacheUrl, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.metadata) || !Array.isArray(saved.profiles)) throw new Error("Archivo de metadata incompatible.");
      this.metadata = new Map(saved.metadata.map((entry) => [entry.mint, entry]));
      this.profiles = new Map(saved.profiles.map((entry) => [entry.username.toLowerCase(), entry]));
    } catch (error) {
      if (error.code !== "ENOENT") { this.status = { state: "error", message: "No se pudo cargar el archivo de metadata; se conserva sin sobrescribir." }; return; }
    }
    void this.run();
  }

  async save() {
    await mkdir(new URL("./", this.cacheUrl), { recursive: true });
    const temporary = new URL(this.cacheUrl.href + ".tmp");
    await writeFile(temporary, JSON.stringify({ version: 1, metadata: [...this.metadata.values()], profiles: [...this.profiles.values()] }, null, 2), "utf8");
    await rename(temporary, this.cacheUrl);
  }

  async associations(tokens) {
    const url = `https://api.dexscreener.com/tokens/v1/solana/${tokens.map((token) => token.mint).join(",")}`;
    const pairs = await this.request(url);
    if (!Array.isArray(pairs)) throw new Error("La fuente de enlaces no devolvió pares válidos.");
    const checkedAt = new Date(this.clock()).toISOString();
    for (const token of tokens) this.metadata.set(token.mint, { ...this.metadata.get(token.mint), ...dexMetadata(token, pairs, checkedAt) });
  }

  async inspect(token) {
    const metadata = this.metadata.get(token.mint);
    if (!metadata) return;
    const now = new Date(this.clock()).toISOString();
    if (!metadata.metadataCheckedAt || this.clock() - Date.parse(metadata.metadataCheckedAt) > (metadata.metadataError ? DAY / 24 : 7 * DAY)) {
      try {
        const report = await this.request(`https://api.rugcheck.xyz/v1/tokens/${token.mint}/report`);
        if (report.mint !== token.mint) throw new Error("La metadata no corresponde al contrato.");
        const uri = report.tokenMeta?.uri;
        metadata.metadataUri = publicUrl(uri);
        if (!metadata.metadataUri && typeof uri === "string" && /^ipfs:\/\/(?:ipfs\/)?[a-zA-Z0-9]+(?:\/[^\s]*)?$/.test(uri)) {
          metadata.metadataUri = publicUrl(uri.replace(/^ipfs:\/\/(?:ipfs\/)?/, "https://ipfs.io/ipfs/"));
        }
        metadata.description = String(report.fileMeta?.description || "").slice(0, 2000);
        metadata.metadataSource = "rugcheck-exact-mint";
        metadata.metadataError = null;
      } catch { metadata.metadataError = "Metadata original no disponible en esta consulta."; }
      metadata.metadataCheckedAt = now;
    }
    const username = metadata.twitterUsername;
    if (username) {
      const cached = this.profiles.get(username.toLowerCase());
      if (!cached || this.clock() - Date.parse(cached.checkedAt) > (cached.profileError ? DAY / 24 : DAY)) {
        const profile = { username, blueVerified: null, followsMeteora: null, followsSolana: null, checkedAt: now, source: "fxtwitter" };
        try {
          let response;
          try {
            response = await this.request(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(username)}`);
            if (response.code !== 200 || !response.user) throw new Error("Perfil no disponible en v2");
          }
          catch { response = await this.request(`https://api.fxtwitter.com/${encodeURIComponent(username)}`); }
          if (response.code !== 200 || response.user?.screen_name?.toLowerCase() !== username.toLowerCase()) throw new Error("Perfil no confirmado");
          profile.blueVerified = blueVerification(response.user);
          profile.accountId = response.user.id;
          profile.verificationType = response.user.verification?.type ?? null;
        } catch { profile.profileError = "Verificación de la cuenta no disponible en esta consulta."; }
        Object.assign(profile, await followingEvidence(username, (url) => this.request(url)));
        this.profiles.set(username.toLowerCase(), profile);
      }
    }
    metadata.enrichedAt = now;
  }

  async run() {
    if (this.stopped) return;
    try {
      const tokens = [...this.listTokens()].sort((a, b) => Number(b.poolCreatedAt) - Number(a.poolCreatedAt));
      const missing = tokens.filter((token) => !this.metadata.get(token.mint)?.associationCheckedAt
        || this.clock() - Date.parse(this.metadata.get(token.mint).associationCheckedAt) > 7 * DAY);
      if (missing.length) await this.associations(missing.slice(0, 30));
      const next = tokens.find((token) => {
        const metadata = this.metadata.get(token.mint);
        if (!metadata) return false;
        const profile = metadata.twitterUsername && this.profiles.get(metadata.twitterUsername.toLowerCase());
        const retryAfter = metadata.metadataError || profile?.profileError ? DAY / 24 : DAY;
        return !metadata.enrichedAt || this.clock() - Date.parse(metadata.enrichedAt) > retryAfter;
      });
      if (next) await this.inspect(next);
      if (missing.length || next) await this.save();
      this.status = { state: "running", message: "Leyendo metadata, tic azul y seguimientos del X asociado al token.",
        associated: this.metadata.size, checked: [...this.metadata.values()].filter((entry) => entry.enrichedAt).length,
        total: tokens.length, lastCheckAt: new Date(this.clock()).toISOString() };
    } catch (error) { this.status = { ...this.status, state: "waiting_data", message: error.message }; }
    finally { if (!this.stopped) this.timer = setTimeout(() => void this.run(), this.status.state === "waiting_data" ? 30000 : 1000); }
  }

  attach(token) {
    const metadata = this.metadata.get(token.mint);
    if (!metadata) return { ...token, tokenMetadata: { mint: token.mint, tokenPageUrl: `https://solscan.io/token/${token.mint}`, pending: true } };
    const profile = metadata.twitterUsername ? this.profiles.get(metadata.twitterUsername.toLowerCase()) : null;
    return { ...token, tokenMetadata: { ...metadata }, tokenTwitter: metadata.twitterUsername ? {
      ...(profile ?? { blueVerified: null, followsMeteora: null, followsSolana: null }),
      username: metadata.twitterUsername, url: metadata.twitterUrl,
      associationConfirmed: true, associationSource: metadata.associationSource,
      associationCheckedAt: metadata.associationCheckedAt,
    } : null };
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }
}

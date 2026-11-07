import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, NextResponse } from "next/server";
import { LOOKBACK_DAYS, MIN_FEES_USD, readStoredTokens, runMeteoraSync, SYNC_INTERVAL_MS, syncLocalReaderTokens } from "@/lib/meteora-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAY_MS = 86_400_000;
const RECENT_LIMIT = 50;

type ArchivedToken = { poolCreatedAt?: number; savedAt?: string; [key: string]: unknown };
type Archive = {
  source?: string; feeBasis?: string; minFeesUsd?: number; lookbackDays?: number;
  archivePolicy?: string; frozenRecords?: boolean; updatedAt?: string; tokens?: ArchivedToken[];
};

function hasWebsiteAndX(token: ArchivedToken) {
  const metadata = token.tokenMetadata as Record<string, unknown> | undefined;
  return Boolean(metadata?.websiteUrl && (metadata.twitterUrl || metadata.twitterUsername));
}

async function readLiveReader() {
  const upstream = await fetch("http://127.0.0.1:3001/api/radar/tokens", {
    cache: "no-store", signal: AbortSignal.timeout(5_000),
  });
  if (!upstream.ok) throw new Error("Reader unavailable");
  const data = await upstream.json();
  if (!["meteora", "axiom"].includes(data.source) || !Array.isArray(data.tokens)
      || !Array.isArray(data.latestTokens) || !data.reader) throw new Error("Invalid reader response");
  let databaseSync: { state: "saved" | "not_configured" | "error"; inserted: number } = {
    state: "not_configured", inserted: 0,
  };
  if (process.env.SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    try {
      databaseSync = { state: "saved", inserted: await syncLocalReaderTokens(data.tokens) };
    } catch {
      databaseSync = { state: "error", inserted: 0 };
    }
  }
  const tokens = data.tokens.filter(hasWebsiteAndX);
  return {
    ...data,
    databaseSync,
    tokens,
    latestTokens: data.latestTokens.filter(hasWebsiteAndX),
    totalStored: data.totalCaptured ?? data.tokens.length,
    totalCaptured: tokens.length,
  };
}

// On Vercel there is no local reader process, so serve the committed append-only archive instead.
async function readArchive() {
  const dataDir = path.join(process.cwd(), "data");
  const raw = await readFile(path.join(dataDir, "meteora-direct-token-history.json"), "utf8")
    .catch(() => readFile(path.join(dataDir, "radar-snapshot.json"), "utf8"));
  const archive = JSON.parse(raw) as Archive;
  const lookbackDays = archive.lookbackDays ?? 150;
  const now = Date.now();
  const cutoff = now - lookbackDays * DAY_MS;
  const created = (token: ArchivedToken) => Number(token.poolCreatedAt) || 0;
  const storedTokens = [...(archive.tokens ?? [])].sort((a, b) => created(b) - created(a));
  const tokens = storedTokens.filter(hasWebsiteAndX);
  const latestTokens = tokens
    .filter((token) => created(token) >= cutoff && created(token) <= now)
    .slice(0, RECENT_LIMIT);

  return {
    source: archive.source ?? "meteora",
    feeBasis: archive.feeBasis ?? "lifetime",
    minFeesUsd: archive.minFeesUsd ?? 3500,
    retentionDays: null,
    lookbackDays,
    archivePolicy: archive.archivePolicy ?? "append-only",
    frozenRecords: archive.frozenRecords ?? true,
    tokens,
    latestTokens,
    totalCaptured: tokens.length,
    totalStored: storedTokens.length,
    refreshedAt: archive.updatedAt ?? null,
    captureConnected: false,
    reader: {
      state: "archive",
      message: "Archivo guardado" + (archive.updatedAt ? " · " + new Date(archive.updatedAt).toLocaleString("es-ES", { timeZone: "Europe/Madrid" }) : ""),
    },
  };
}

// Vercel: every visit returns the full Supabase archive and, if the last poll is
// older than 5 minutes, triggers a background Meteora sync after responding.
async function readDatabase() {
  const { tokens: storedTokens, lastPollAt, lastError } = await readStoredTokens();
  const stale = !lastPollAt || Date.now() - Date.parse(lastPollAt) > SYNC_INTERVAL_MS;
  if (stale) after(() => runMeteoraSync().catch(() => {}));
  if (!storedTokens.length && stale) throw new Error("Archive empty");
  const tokens = storedTokens.filter(hasWebsiteAndX);
  const now = Date.now();
  const cutoff = now - LOOKBACK_DAYS * DAY_MS;
  const latestTokens = tokens
    .filter((t) => t.poolCreatedAt >= cutoff && t.poolCreatedAt <= now)
    .slice(0, RECENT_LIMIT);
  const when = lastPollAt ? new Date(lastPollAt).toLocaleString("es-ES", { timeZone: "Europe/Madrid" }) : null;
  return {
    source: "meteora", feeBasis: "lifetime", minFeesUsd: MIN_FEES_USD, retentionDays: null,
    lookbackDays: LOOKBACK_DAYS, archivePolicy: "append-only", frozenRecords: true,
    tokens, latestTokens, totalCaptured: tokens.length, refreshedAt: lastPollAt,
    totalStored: storedTokens.length,
    captureConnected: !lastError,
    reader: lastError
      ? { state: "waiting_data", message: "No se pudo actualizar Meteora: " + lastError }
      : { state: "receiving", message: "Buscando nuevos tokens en Meteora cada 5 min. Archivo acumulativo" + (when ? " · " + when : "") },
  };
}

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    return NextResponse.json(await readLiveReader(), { headers });
  } catch {
    try {
      if (process.env.SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
        return NextResponse.json(await readDatabase(), { headers });
      }
    } catch {}
    try {
      return NextResponse.json(await readArchive(), { headers });
    } catch {
      return NextResponse.json({ error: "El lector del servidor no está disponible. Esperando a que se restablezca la lectura." }, { status: 503, headers });
    }
  }
}

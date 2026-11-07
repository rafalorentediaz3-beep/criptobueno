import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;
const RECENT_LIMIT = 50;

type ArchivedToken = { poolCreatedAt?: number; savedAt?: string; [key: string]: unknown };
type Archive = {
  source?: string; feeBasis?: string; minFeesUsd?: number; lookbackDays?: number;
  archivePolicy?: string; frozenRecords?: boolean; updatedAt?: string; tokens?: ArchivedToken[];
};

async function readLiveReader() {
  const upstream = await fetch("http://127.0.0.1:3001/api/radar/tokens", {
    cache: "no-store", signal: AbortSignal.timeout(5_000),
  });
  if (!upstream.ok) throw new Error("Reader unavailable");
  const data = await upstream.json();
  if (!["meteora", "axiom"].includes(data.source) || !Array.isArray(data.tokens)
      || !Array.isArray(data.latestTokens) || !data.reader) throw new Error("Invalid reader response");
  return data;
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
  const tokens = [...(archive.tokens ?? [])].sort((a, b) => created(b) - created(a));
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
    refreshedAt: archive.updatedAt ?? null,
    captureConnected: false,
    reader: {
      state: "archive",
      message: "Archivo guardado" + (archive.updatedAt ? " · " + new Date(archive.updatedAt).toLocaleString("es-ES", { timeZone: "Europe/Madrid" }) : ""),
    },
  };
}

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    return NextResponse.json(await readLiveReader(), { headers });
  } catch {
    try {
      return NextResponse.json(await readArchive(), { headers });
    } catch {
      return NextResponse.json({ error: "El lector del servidor no está disponible. Esperando a que se restablezca la lectura." }, { status: 503, headers });
    }
  }
}

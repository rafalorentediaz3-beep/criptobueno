import { NextRequest, NextResponse } from "next/server";

/**
 * Pins a launch image to IPFS via Pinata and returns an `ipfs://<cid>` URI.
 * That URI goes into createToken's metadata (emitted in the TokenCreated event),
 * so the image is content-addressed and permanent — no database.
 *
 * Requires a SERVER-ONLY `PINATA_JWT` env var (never exposed to the browser).
 * Guards: image types only, 10 MB cap (roomy enough for animated GIFs/WebP), and
 * a coarse per-IP rate limit so the endpoint can't be used to burn the Pinata
 * quota. Files are pinned as-is — GIF/WebP animation is preserved (never flattened).
 */
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

// NOTE: the per-IP key is derived from `x-forwarded-for` / `x-real-ip`, which
// are client-settable. Unless a fixed upstream proxy overwrites them, a caller
// can rotate the header per request and evade this cap, burning the Pinata
// quota. The GLOBAL backstop below is the unspoofable ceiling.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

// Global backstop across ALL callers — independent of the (spoofable) IP key.
const MAX_GLOBAL_PER_WINDOW = Number(process.env.UPLOAD_MAX_GLOBAL_PER_WINDOW) || 200;
let globalHits: number[] = [];

function globalRateLimited(): boolean {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < WINDOW_MS);
  globalHits.push(now);
  return globalHits.length > MAX_GLOBAL_PER_WINDOW;
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return recent.length > MAX_PER_WINDOW;
}

export async function POST(req: NextRequest) {
  const jwt = process.env.PINATA_JWT;

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  // Global backstop first (unspoofable), then the soft per-IP cap.
  if (globalRateLimited() || rateLimited(ip)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file provided" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large (max 10 MB)" }, { status: 413 });
  }
  // Reject a MISSING type too — an empty Content-Type would otherwise slip any
  // blob (HTML/JS/SVG) past the allowlist and pin it to IPFS on our Pinata quota.
  if (!file.type || !ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: "unsupported or missing image type" }, { status: 415 });
  }

  // Local development can preview and test launches without requiring a
  // production Pinata secret. Data URIs are deliberately accepted only on
  // loopback hosts; deployed environments still fail clearly when Pinata is
  // not configured.
  const host = req.headers.get("host")?.split(":")[0]?.toLowerCase();
  if (!jwt && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
    const bytes = Buffer.from(await file.arrayBuffer());
    return NextResponse.json({
      uri: `data:${file.type};base64,${bytes.toString("base64")}`,
    });
  }

  if (!jwt) {
    return NextResponse.json(
      { error: "image upload not configured (PINATA_JWT missing)" },
      { status: 503 },
    );
  }

  const pinataForm = new FormData();
  pinataForm.append("file", file, file.name || "image");
  pinataForm.append("network", "public");

  let res: Response;
  try {
    res = await fetch("https://uploads.pinata.cloud/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: pinataForm,
    });
  } catch {
    return NextResponse.json({ error: "pinata unreachable" }, { status: 502 });
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error("pinata upload failed:", res.status, detail);
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { error: "Pinata rejected PINATA_JWT; check that the token is valid and has public file upload permission" },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: `Pinata upload failed (${res.status})` }, { status: 502 });
  }

  const data = (await res.json()) as { data?: { cid?: string }; cid?: string };
  const cid = data.data?.cid ?? data.cid;
  if (!cid) {
    return NextResponse.json({ error: "no CID returned by pinata" }, { status: 502 });
  }

  // Pre-warm our own image proxy, fire-and-forget: a FRESH pin exists only on
  // Pinata's gateway for the first minutes, so the first card render used to
  // miss public gateways, negative-cache for 60s, and the new token looked
  // imageless right when everyone clicks it. Warming here means the proxy has
  // the bytes cached (for a year) before the launch tx even confirms.
  const origin = new URL(req.url).origin;
  void fetch(`${origin}/api/img?cid=${cid}`).catch(() => {});

  return NextResponse.json({ uri: `ipfs://${cid}`, cid });
}

export const runtime = "nodejs";

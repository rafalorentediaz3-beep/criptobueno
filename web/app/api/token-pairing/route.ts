import { NextRequest, NextResponse } from "next/server";
import { verifyAction } from "@/lib/feedback/auth";
import { tokenPairingHash } from "@/lib/feedback/message";
import { loadFeed } from "@/lib/tokenFeed";
import { getTokenPairings, saveTokenPairing } from "@/lib/tokenMeta/pairingStore";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("tokens") ?? req.nextUrl.searchParams.get("token") ?? "";
  try {
    return NextResponse.json({ pairings: await getTokenPairings(raw.split(",")) });
  } catch (error) {
    return NextResponse.json({ pairings: {}, unavailable: (error as Error).message });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Record<string, unknown>;
  const address = String(body.address ?? "");
  const token = String(body.token ?? "");
  const symbol = String(body.symbol ?? "");
  const name = String(body.name ?? "");
  const imageUrl = String(body.imageUrl ?? "");
  const verified = await verifyAction({
    address,
    action: "token-pairing",
    subject: tokenPairingHash({ token, symbol, name, imageUrl }),
    nonce: String(body.nonce ?? ""),
    issuedAt: String(body.issuedAt ?? ""),
    signature: String(body.signature ?? ""),
  });
  if (!verified.ok) return NextResponse.json({ error: verified.error ?? "unauthorized" }, { status: 401 });
  const feed = await loadFeed();
  const creator = feed.creations.find((item) => item.token.toLowerCase() === token.toLowerCase())?.creator;
  if (!creator) return NextResponse.json({ error: "unknown token" }, { status: 404 });
  if (creator.toLowerCase() !== verified.address) return NextResponse.json({ error: "only the token creator can pair it" }, { status: 403 });
  const saved = await saveTokenPairing({ token, creator, symbol, name, imageUrl });
  return saved.ok ? NextResponse.json({ pairing: saved.value }) : NextResponse.json({ error: saved.error }, { status: saved.status });
}

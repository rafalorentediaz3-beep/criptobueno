import { decodeAbiParameters, getAddress, isAddress, type Hex } from "viem";
import { NextRequest, NextResponse } from "next/server";
import { resolveImageUri } from "@/lib/format";

export const runtime = "nodejs";

const RPC_URL = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const LOGO_SELECTOR = "0xfb7f21eb";
const cache = new Map<string, { imageUrl: string; expiresAt: number }>();
const TTL_MS = 60 * 60_000;

async function onChainLogo(address: string): Promise<string> {
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: address, data: LOGO_SELECTOR }, "latest"],
      }),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok) return "";
    const result = (await response.json()) as { result?: Hex };
    if (!result.result || result.result === "0x") return "";
    return decodeAbiParameters([{ type: "string" }], result.result)[0].trim();
  } catch {
    return "";
  }
}

async function indexedLogo(address: string): Promise<string> {
  try {
    const response = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${address}`,
      { headers: { accept: "application/json" }, next: { revalidate: 3600 } },
    );
    if (!response.ok) return "";
    const payload = (await response.json()) as { data?: { attributes?: { image_url?: string } } };
    return payload.data?.attributes?.image_url ?? "";
  } catch {
    return "";
  }
}

export async function GET(request: NextRequest) {
  const rawAddress = request.nextUrl.searchParams.get("address") ?? "";
  if (!isAddress(rawAddress)) {
    return NextResponse.json({ imageUrl: "" }, { status: 400 });
  }

  const address = getAddress(rawAddress);
  const key = address.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ imageUrl: cached.imageUrl });
  }

  const logoUri = (await onChainLogo(address)) || (await indexedLogo(key));
  const imageUrl = resolveImageUri(logoUri) ?? "";
  cache.set(key, { imageUrl, expiresAt: Date.now() + TTL_MS });

  return NextResponse.json(
    { imageUrl },
    { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } },
  );
}

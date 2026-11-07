import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const upstream = await fetch("http://127.0.0.1:3001/api/radar/tokens", {
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) throw new Error("Reader unavailable");
    const data = await upstream.json();
    if (!["meteora", "axiom"].includes(data.source) || !Array.isArray(data.tokens)
        || !Array.isArray(data.latestTokens) || !data.reader) throw new Error("Invalid reader response");
    return NextResponse.json(data, { headers });
  } catch {
    return NextResponse.json({ error: "El lector del servidor no está disponible. Esperando a que se restablezca la lectura." }, { status: 503, headers });
  }
}

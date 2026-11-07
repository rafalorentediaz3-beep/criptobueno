import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The browser always reads from the site it is visiting. Only the server talks
// to its private local reader; visitors never need a reader on their own device.
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const upstream = await fetch("http://127.0.0.1:3001/api/axiom/tokens", {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) throw new Error("Reader unavailable");
    const data = await upstream.json();
    if (!Array.isArray(data.tokens) || !Array.isArray(data.latestTokens) || !data.reader) {
      throw new Error("Invalid reader response");
    }
    return NextResponse.json(data, { headers });
  } catch {
    return NextResponse.json(
      { error: "El lector de Axiom del servidor no está disponible. Los datos guardados se conservan; esperando a que se restablezca la lectura." },
      { status: 503, headers },
    );
  }
}

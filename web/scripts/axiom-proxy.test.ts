import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/axiom/tokens/route";

test("visitors receive the server reader's current snapshot without caching", async (context) => {
  const snapshot = {
    tokens: [], latestTokens: [], totalCaptured: 13,
    reader: { state: "receiving", engine: "webview2", requiresChrome: false },
  };
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "http://127.0.0.1:3001/api/axiom/tokens");
    assert.equal(options.cache, "no-store");
    return Response.json(snapshot);
  });
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), snapshot);
});

test("a disconnected reader is reported explicitly instead of showing cached readings", async (context) => {
  context.mock.method(globalThis, "fetch", async () => { throw new Error("connection refused"); });
  const response = await GET();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.match(body.error, /lector de Axiom del servidor/);
  assert.equal(body.tokens, undefined);
});

test("failed and incompatible reader responses are not presented as a valid feed", async (context) => {
  for (const upstream of [new Response("offline", { status: 500 }), Response.json({ tokens: [] })]) {
    const mock = context.mock.method(globalThis, "fetch", async () => upstream);
    assert.equal((await GET()).status, 503);
    mock.mock.restore();
  }
});

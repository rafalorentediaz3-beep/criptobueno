import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/bot.html", import.meta.url), "utf8");
const now = Date.parse("2026-11-02T15:00:00Z");
const account = (blueVerified) => ({ username: "test_project", blueVerified, associationConfirmed: true, followsMeteora: true, followsSolana: true, checkedAt: new Date(now).toISOString(), source: "test-fixture" });
const token = (mint, age, tokenTwitter, extra = {}) => ({
  mint, name: mint, symbol: mint, source: "meteora", feesUsd: 3500,
  poolAddress: "pool", poolCreatedAt: now - age * 86400000,
  savedAt: new Date(now).toISOString(), tokenTwitter, ...extra,
});
const rows = [
  token("Blue", 2, account(true), { tokenMetadata: { tokenPageUrl: "https://dexscreener.com/solana/blue", metadataUri: "https://metadata.example/blue.json" } }),
  token("NoBlue", 1, { ...account(false), followsMeteora: false }),
  token("Unknown", 3, undefined, { is_verified: true, twitter: "https://x.com/project_account" }),
  token("Unlinked", 4, { ...account(true), associationConfirmed: false }),
];
const settle = () => new Promise((done) => setImmediate(done));

async function page(preferred = null, follows = "all") {
  const elements = new Map(), storage = new Map();
  if (preferred) storage.set("moneypoly:radar:twitter-filter:v1", preferred);
  if (follows) storage.set("moneypoly:radar:following-filter:v1", follows);
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", innerHTML: "", textContent: "", style: {}, listeners: {},
      classList: { add() {}, remove() {} }, setAttribute() {},
      addEventListener(name, listener) { this.listeners[name] = listener; },
    });
    return elements.get(id);
  };
  let refresh;
  const context = vm.createContext({
    URL,
    document: { getElementById: element }, location: { hostname: "localhost" },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async () => ({ ok: true, json: async () => ({
      source: "meteora", minFeesUsd: 3500, lookbackDays: 150, tokens: rows, latestTokens: rows.slice(0, 3),
      reader: { state: "receiving" }, latestObservation: new Date(now).toISOString(), totalCaptured: rows.length,
    }) }),
    setInterval(callback) { refresh = callback; }, setTimeout() {},
  });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]).runInContext(context);
  await settle();
  assert.equal(element("error").style.display, "none");
  return {
    element, storage, refresh: async () => { await refresh(); await settle(); },
    select(value) { element("twitterFilter").value = value; element("twitterFilter").listeners.change(); },
    rendered: () => [...element("feed").innerHTML.matchAll(/data-copy="([^"]+)"/g)].map((match) => match[1]),
  };
}

test("All includes unknown accounts and preserves chronological order", async () => {
  const view = await page();
  assert.equal(view.element("twitterFilter").value, "all");
  assert.deepEqual(view.rendered(), ["NoBlue", "Blue", "Unknown"]);
  assert.match(view.element("feed").innerHTML, /x-badge--unknown/);
  assert.match(view.element("twitterStatus").textContent, /1 con tic azul/);
});

test("blue-only and no-blue-only require explicit linked-account verification, in both tabs", async () => {
  const view = await page();
  view.select("blue");
  assert.deepEqual(view.rendered(), ["Blue"]);
  assert.equal(view.element("count").textContent, 1);
  view.element("archiveTab").listeners.click();
  assert.deepEqual(view.rendered(), ["Blue"]);
  view.select("no-blue");
  assert.deepEqual(view.rendered(), ["NoBlue"]);
  assert.equal(view.element("archiveCount").textContent, 1);
  view.select("all");
  assert.deepEqual(view.rendered(), ["NoBlue", "Blue", "Unknown", "Unlinked"]);
});

test("following both official accounts is required by default; unknown is not treated as false", async () => {
  const view = await page(null, null);
  assert.equal(view.element("followingFilter").value, "both");
  assert.deepEqual(view.rendered(), ["Blue"]);
  view.element("followingFilter").value = "all";
  view.element("followingFilter").listeners.change();
  assert.deepEqual(view.rendered(), ["NoBlue", "Blue", "Unknown"]);
});

test("search combines with the badge filter and pending status is not treated as no blue tick", async () => {
  const view = await page();
  view.select("no-blue");
  view.element("search").value = "Unknown";
  view.element("search").listeners.input();
  assert.deepEqual(view.rendered(), []);
  assert.match(view.element("feed").innerHTML, /pendientes/);
  view.select("all");
  assert.deepEqual(view.rendered(), ["Unknown"]);
});

test("each token has an info link and its own metadata and associated account links", async () => {
  const view = await page("blue");
  const rendered = view.element("feed").innerHTML;
  assert.ok(rendered.includes('href="https://dexscreener.com/solana/blue"'));
  assert.ok(rendered.includes('href="https://metadata.example/blue.json"'));
  assert.ok(rendered.includes('href="https://x.com/test_project"'));
});

test("the selected filter survives refresh and is restored from this browser", async () => {
  const view = await page("blue");
  assert.deepEqual(view.rendered(), ["Blue"]);
  view.select("no-blue");
  assert.equal(view.storage.get("moneypoly:radar:twitter-filter:v1"), "no-blue");
  await view.refresh();
  assert.deepEqual(view.rendered(), ["NoBlue"]);
  const invalid = await page("invalid");
  assert.equal(invalid.element("twitterFilter").value, "all");
});

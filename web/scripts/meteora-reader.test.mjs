import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { meteoraCandidates, MeteoraReader } from "./meteora-reader.mjs";

const NOW = Date.parse("2026-11-02T15:00:00Z");
const DAY = 86400000;
const mint = "PP4UWdpQFXp1H3EYXQFRTpmLasdXsiuNN5o5eCDMETT";
const otherMint = "3H9Qq3W9TLM5LmUU4wSUb9Ln7abcBE9AkeXGJpNDUSPR";
const pool = (fees, address = "BhEUSjchfaVc7bUtCQarjvvQyKhiZNaFnzfL7MjMGNgm") => ({
  address, token_x: { address: mint, name: "MettPad", symbol: "METT" },
  token_y: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  cumulative_metrics: { fees, volume: 1e9 }, fees: { "24h": 9000 }, created_at: NOW - DAY,
});
const candidates = (pools) => meteoraCandidates(pools, 3500, { now: NOW });

async function temporaryArchive(context) {
  const directory = await mkdtemp(join(tmpdir(), "moneypoly-meteora-test-"));
  const archiveUrl = pathToFileURL(join(directory, "archive.json"));
  context.after(async () => {
    for (const suffix of ["", ".tmp", ".before-150d.json"]) await rm(new URL(archiveUrl.href + suffix), { force: true });
    await rmdir(directory);
  });
  return archiveUrl;
}

test("the $3,500 lifetime threshold is inclusive and never uses 24h fees or volume", () => {
  assert.equal(candidates([pool(3499.99)]).length, 0);
  assert.equal(candidates([pool(3500)])[0].feesUsd, 3500);
  assert.equal(candidates([pool(undefined)]).length, 0);
  assert.equal(candidates([pool(null)]).length, 0);
  assert.equal(candidates([pool(NaN)]).length, 0);
  assert.equal(candidates([{ ...pool(5000), fees: { "24h": 0 } }])[0].feesUsd, 5000);
});

test("duplicate pools and multiple pools for one mint do not inflate its fee amount", () => {
  const first = pool(3500);
  const second = pool(4200, "6ESbso1k12jJBEbNthW8qwjPRGZpU3rrMskTeuiV9jiF");
  const tokens = candidates([first, first, second]);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].mint, mint);
  assert.equal(tokens[0].feesUsd, 4200);
  assert.equal(tokens[0].poolAddress, second.address);
  assert.equal(tokens[0].source, "meteora");
  assert.equal(tokens[0].axiomGlobalFeesPaidSol, undefined);
  assert.equal(candidates([{ ...first, is_blacklisted: true }]).length, 0);
});

test("admission includes the 150-day boundary and rejects old, future or missing creation dates", () => {
  assert.equal(candidates([{ ...pool(3500), created_at: NOW - 150 * DAY }]).length, 1);
  for (const created_at of [NOW - 150 * DAY - 1, NOW + 1, null, undefined, "invalid"]) {
    assert.equal(candidates([{ ...pool(3500), created_at }]).length, 0);
  }
  assert.equal(candidates([{ ...pool(3500), created_at: (NOW - DAY) / 1000 }])[0].poolCreatedAt, NOW - DAY);
  assert.equal(candidates([{ ...pool(3500), created_at: String(NOW - DAY) }])[0].poolCreatedAt, NOW - DAY);
});

test("saved tokens never renew fees, dates, pool or observation count; new mints accumulate", () => {
  let now = NOW;
  const reader = new MeteoraReader({ clock: () => now });
  reader.observe([pool(3500)]);
  const original = structuredClone(reader.snapshot().tokens[0]);
  now += DAY;
  reader.observe([pool(4000)]);
  reader.observe([pool(9000, "6ESbso1k12jJBEbNthW8qwjPRGZpU3rrMskTeuiV9jiF")]);
  reader.observe([pool(3000), { ...pool(3500), is_blacklisted: true }]);
  assert.deepEqual(reader.snapshot().tokens[0], original);
  reader.observe([{ ...pool(4000), token_x: { address: otherMint, symbol: "USPR" } }]);
  assert.equal(reader.snapshot().tokens.length, 2);
  assert.equal(reader.snapshot().archivePolicy, "append-only");
  assert.equal(reader.snapshot().retentionDays, null);
});

test("records remain beyond 150 days and survive a restart without timestamp renewal", async (context) => {
  const archiveUrl = await temporaryArchive(context);
  let now = NOW;
  const reader = new MeteoraReader({ archiveUrl, clock: () => now });
  reader.observe([pool(3500)]);
  const original = structuredClone(reader.snapshot().tokens[0]);
  now += 200 * DAY;
  await reader.save();
  const restarted = new MeteoraReader({ archiveUrl, clock: () => now });
  await restarted.load();
  assert.deepEqual(restarted.snapshot().tokens, [original]);
  assert.equal(restarted.snapshot().latestTokens.length, 0);
  assert.equal(reader.snapshot().captureConnected, false);
  assert.equal(reader.getStatus().state, "waiting_data");
});

test("re-reading saved tokens does not rewrite the archive or its saved timestamp", async (context) => {
  const archiveUrl = await temporaryArchive(context);
  let now = NOW;
  const reader = new MeteoraReader({ archiveUrl, clock: () => now });
  reader.observe([pool(3500)]);
  await reader.save();
  const original = await readFile(archiveUrl, "utf8");
  now += DAY;
  reader.observe([pool(8000)]);
  await reader.save();
  assert.equal(await readFile(archiveUrl, "utf8"), original);
});

test("the old archive is backed up and only eligible records enter the frozen archive", async (context) => {
  const archiveUrl = await temporaryArchive(context);
  const recent = { ...candidates([pool(3500)])[0], firstSeenAt: new Date(NOW - DAY).toISOString(), lastSeenAt: new Date(NOW).toISOString() };
  const old = { ...recent, mint: otherMint, poolCreatedAt: NOW - 151 * DAY };
  const content = JSON.stringify({ version: 1, tokens: [recent, old] });
  await writeFile(archiveUrl, content);
  const reader = new MeteoraReader({ archiveUrl, clock: () => NOW });
  await reader.load();
  assert.equal(await readFile(new URL(archiveUrl.href + ".before-150d.json"), "utf8"), content);
  assert.equal(reader.snapshot().tokens.length, 1);
  assert.equal(reader.snapshot().tokens[0].savedAt, recent.lastSeenAt);
  await reader.save();
  assert.equal(JSON.parse(await readFile(archiveUrl, "utf8")).version, 2);
  const restarted = new MeteoraReader({ archiveUrl, clock: () => NOW + 400 * DAY });
  await restarted.load();
  assert.equal(restarted.snapshot().tokens.length, 1);
  assert.equal(await readFile(new URL(archiveUrl.href + ".before-150d.json"), "utf8"), content);
});

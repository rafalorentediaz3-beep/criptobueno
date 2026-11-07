import assert from "node:assert/strict";
import test from "node:test";
import { publicUrl, twitterHandle, dexMetadata, blueVerification, followingEvidence, TokenMetadataReader } from "./token-metadata.mjs";

const mint = "PP4UWdpQFXp1H3EYXQFRTpmLasdXsiuNN5o5eCDMETT";
const token = { mint, name: "MettPad", symbol: "METT", poolAddress: "pool", feesUsd: 3500, savedAt: "2026-11-02T15:00:00Z", frozen: true };
const meteora = { id: "1384042881808166924", screen_name: "MeteoraAG" };
const solana = { id: "951329744804392960", screen_name: "solana" };

test("only account URLs are accepted; unsafe links, communities and lookalike domains are rejected", () => {
  assert.equal(twitterHandle("https://x.com/Mettpad/status/123"), "Mettpad");
  for (const url of ["https://x.com/i/communities/123", "https://x.com.evil.example/Mettpad", "javascript://x.com/Mettpad", "https://user:pass@x.com/Mettpad"]) assert.equal(twitterHandle(url), null);
  assert.equal(publicUrl("javascript:alert(1)"), null);
  assert.equal(publicUrl("https://project.example/metadata.json"), "https://project.example/metadata.json");
});

test("metadata is associated with the exact base mint, never another token using it as quote", () => {
  const misleading = { chainId: "solana", baseToken: { address: "other" }, quoteToken: { address: mint }, info: { socials: [{ type: "twitter", url: "https://x.com/wrong_account" }] } };
  assert.equal(dexMetadata(token, [misleading], "now").twitterUsername, null);
  const matching = { ...misleading, pairAddress: "pool", baseToken: { address: mint }, info: { socials: [{ type: "twitter", url: "https://x.com/Mettpad" }], websites: [{ url: "https://mettpad.com" }] } };
  assert.equal(dexMetadata(token, [misleading, matching], "now").twitterUsername, "Mettpad");
});

test("blue verification requires explicit provider evidence and distinguishes other badge colors", () => {
  assert.equal(blueVerification({ verification: { verified: true, type: "individual" } }), true);
  assert.equal(blueVerification({ verification: { verified: true, type: "organization" } }), false);
  assert.equal(blueVerification({ verification: { verified: false } }), false);
  assert.equal(blueVerification({ is_verified: true }), null);
  assert.equal(blueVerification({ verification: { verified: true } }), null);
});

test("following pagination finds both official IDs without confusing similarly named accounts", async () => {
  let calls = 0;
  const result = await followingEvidence("project", async () => ++calls === 1
    ? { code: 200, results: [meteora, { id: "different", screen_name: "solana_news" }], cursor: { bottom: "next" } }
    : { code: 200, results: [solana], cursor: { bottom: "0|end" } });
  assert.equal(result.followsMeteora, true);
  assert.equal(result.followsSolana, true);
  assert.equal(calls, 2);
});

test("partial or failed following lists stay unknown; a confirmed end can establish a negative", async () => {
  const partial = await followingEvidence("project", async () => ({ code: 200, results: [meteora], cursor: { bottom: "more" } }), 1);
  assert.equal(partial.followsMeteora, true);
  assert.equal(partial.followsSolana, null);
  const complete = await followingEvidence("project", async () => ({ code: 200, results: [meteora], cursor: { bottom: "0|end" } }));
  assert.equal(complete.followsSolana, false);
  const failed = await followingEvidence("project", async () => { throw new Error("offline"); });
  assert.equal(failed.followsMeteora, null);
  assert.equal(failed.followsSolana, null);
});

test("profile fallback and metadata enrich a copy without changing frozen fees or dates", async () => {
  const original = structuredClone(token);
  const reader = new TokenMetadataReader(() => [token]);
  reader.metadata.set(mint, { mint, twitterUsername: "Mettpad", twitterUrl: "https://x.com/Mettpad", associationSource: "dexscreener-exact-mint" });
  const requests = [];
  reader.request = async (url) => {
    requests.push(url);
    if (url.includes("rugcheck")) return { mint, tokenMeta: { uri: "https://project.example/metadata.json" }, fileMeta: { description: "Token metadata" } };
    if (url.endsWith("/following?count=100")) return { code: 200, results: [meteora, solana], cursor: { bottom: "0|end" } };
    if (url.includes("/2/profile/")) throw new Error("v2 unavailable");
    return { code: 200, user: { id: "123", screen_name: "Mettpad", verification: { verified: true, type: "individual" } } };
  };
  await reader.inspect(token);
  const enriched = reader.attach(token);
  assert.deepEqual(token, original);
  assert.equal(enriched.feesUsd, original.feesUsd);
  assert.equal(enriched.savedAt, original.savedAt);
  assert.equal(enriched.tokenTwitter.blueVerified, true);
  assert.equal(enriched.tokenTwitter.followsMeteora, true);
  assert.equal(enriched.tokenTwitter.followsSolana, true);
  assert.equal(enriched.tokenMetadata.metadataUri, "https://project.example/metadata.json");
  assert.ok(!requests.includes("https://project.example/metadata.json"));
});

test("a metadata report for a different mint is never linked", async () => {
  const reader = new TokenMetadataReader(() => [token]);
  reader.metadata.set(mint, { mint });
  reader.request = async () => ({ mint: "other", tokenMeta: { uri: "https://wrong.example/data.json" } });
  await reader.inspect(token);
  assert.equal(reader.attach(token).tokenMetadata.metadataUri, undefined);
  assert.ok(reader.attach(token).tokenMetadata.metadataError);
});

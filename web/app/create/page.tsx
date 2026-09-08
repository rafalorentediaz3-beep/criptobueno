"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { bytesToHex, decodeEventLog } from "viem";
import { useAccount, usePublicClient, useReadContracts, useSignMessage } from "wagmi";
import { potatoCurvePadAbi, potatoV4PadAbi } from "@/lib/abi";
import { SITE_URL } from "@/lib/config";
import { usePad, useTx } from "@/lib/hooks";
import { useAncientTokens } from "@/lib/ancient";
import { DESCRIPTION_MAX, tokenDescriptionHash } from "@/lib/feedback/message";
import { tokenPairingHash } from "@/lib/feedback/message";
import { signAction } from "@/lib/feedback/sign";
import { formatEth, normalizeSocialUrl, resolveImageUri, tryParseEther } from "@/lib/format";
import type { RobinhoodStock } from "@/lib/stocks";
import { ConnectGate } from "@/components/ConnectGate";
import { NotDeployed } from "@/components/NotDeployed";
import { TxStatus } from "@/components/TxStatus";

/**
 * The treasury always takes half the WETH fees; the other half is the creator's.
 * A holder-rewards launch splits THAT half between the creator and holders, so
 * the creator's cut of total fees runs 0…50%.
 */
const CREATOR_HALF_PCT = 50;
/**
 * Largest creator cut a reward launch accepts. The pad rejects exactly
 * CREATOR_HALF_PCT (`creatorFeeBps >= CREATOR_FEE_SHARE_BPS -> InvalidConfig`),
 * because that pays holders zero while the token still carries the holder-rewards
 * badge. Keep the slider strictly inside the contract's bound so the form cannot
 * offer a launch that reverts.
 */
const MAX_CREATOR_CUT_PCT = CREATOR_HALF_PCT - 5;

const inputCls =
  "w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-900 placeholder-neutral-400 outline-none transition-colors focus:border-neutral-400 focus:ring-4 focus:ring-neutral-900/5";
const labelCls = "text-[10px] font-bold uppercase tracking-wider text-neutral-500";

let stockCatalogueCache: RobinhoodStock[] | null = null;
let stockCatalogueRequest: Promise<RobinhoodStock[]> | null = null;

function loadStockCatalogue() {
  if (stockCatalogueCache) return Promise.resolve(stockCatalogueCache);
  if (!stockCatalogueRequest) {
    stockCatalogueRequest = fetch("/api/robinhood/stocks?v=4", {
      cache: "force-cache",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("stock catalogue unavailable");
        const data = (await response.json()) as { stocks?: RobinhoodStock[] };
        stockCatalogueCache = data.stocks ?? [];
        return stockCatalogueCache;
      })
      .finally(() => {
        stockCatalogueRequest = null;
      });
  }
  return stockCatalogueRequest;
}

function StockLogo({ stock }: { stock: RobinhoodStock }) {
  const [source, setSource] = useState(stock.imageUrl);
  return (
    <img
      src={source}
      alt={`${stock.name} logo`}
      loading="eager"
      decoding="async"
      className="h-6 w-6 shrink-0 rounded-full object-contain p-0"
      onError={() => {
        const localFallback = `/stock-logos/${encodeURIComponent(stock.symbol)}.png`;
        if (source !== localFallback) {
          setSource(localFallback);
        }
      }}
    />
  );
}

export default function CreatePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Curve pad is the PRIMARY launcher: every new launch (plain or holder-rewards)
  // goes here. The direct pad stays read-only for coins already launched on it.
  const { curvePad, v4Pad, chainId, canLaunch, canV4Launch } = usePad();
  const canCreate = canLaunch || canV4Launch;
  const tx = useTx();
  const publicClient = usePublicClient({ chainId });
  const { tokens: ancientTokens } = useAncientTokens();
  const { address: userAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();

  // Dev-buy cap. The atomic creator buy runs in the launch block (anti-snipe
  // active) and the creator is NOT exempt, so buying > MAX_WALLET reverts the
  // launch with DevBuyExceedsCap. MAX_WALLET is TOTAL_SUPPLY / 50 — 2% of
  // supply, i.e. 20M tokens. We estimate the ETH that buys 20M tokens off the
  // single-sided-v3 curve (starting at the opening price) so the form can warn
  // before submitting. Read the per-deployment start FDV on-chain.
  const { data: curveConsts } = useReadContracts({
    allowFailure: true,
    contracts: [{ address: curvePad, abi: potatoCurvePadAbi, functionName: "actualStartFdv" }],
    query: { enabled: canLaunch },
  });
  const maxDevBuyWei = useMemo<bigint | undefined>(() => {
    const startFdv = curveConsts?.[0]?.result as bigint | undefined;
    if (startFdv === undefined || startFdv === 0n) return undefined;
    // Whole-token curve math (floats are fine for a UI bound). The FULL 1B supply
    // is single-sided liquidity L over [p_floor, p_top] (p_top = 256x the start FDV
    // for the 80/20 split); buying M tokens from the floor costs L·(√p1 − √p_floor)
    // where 1/√p1 = 1/√p_floor − M/L.
    const SUPPLY = 1e9,
      M = 2e7; // MAX_WALLET = TOTAL_SUPPLY / 50, i.e. 2% of supply
    const startEth = Number(startFdv) / 1e18;
    const pFloor = startEth / SUPPLY;
    const pTop = (startEth * 256) / SUPPLY; // outer FDV = 256x start
    const sf = Math.sqrt(pFloor),
      st = Math.sqrt(pTop);
    const L = SUPPLY / (1 / sf - 1 / st);
    const inv1 = 1 / sf - M / L;
    if (!(inv1 > 0)) return undefined; // M exceeds capacity (shouldn't happen)
    const wethMax = L * (1 / inv1 - sf); // ETH to buy exactly M tokens
    if (!(wethMax > 0) || !Number.isFinite(wethMax)) return undefined;
    // Gross up 1% fee, then a small haircut so the buy stays under the strict cap.
    const capEth = wethMax * 1.01 * 0.98;
    return BigInt(Math.floor(capEth * 1e18));
  }, [curveConsts]);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [description, setDescription] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const [uploading, setUploading] = useState(false);
  // Object URL of the just-picked file: instant preview while IPFS propagates.
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState("");
  const [stocks, setStocks] = useState<RobinhoodStock[]>([]);
  const [stockQuery, setStockQuery] = useState("");
  const [pairedStock, setPairedStock] = useState<RobinhoodStock | null>(null);
  const [stocksLoading, setStocksLoading] = useState(false);

  // Holder rewards: share the creator's half of the fees with everyone holding.
  const [rewardsOn, setRewardsOn] = useState(false);
  // True when the server reports a newer pad than this bundle was built with.
  const [staleClient, setStaleClient] = useState(false);
  const [creatorCutPct, setCreatorCutPct] = useState(0);
  const [launchMode, setLaunchMode] = useState<"v3" | "v4">("v3");
  const [v4Fee, setV4Fee] = useState(3_000);
  const [launchWarning, setLaunchWarning] = useState("");
  const launchWarningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holderCutPct = CREATOR_HALF_PCT - creatorCutPct;

  function showLaunchWarning(message: string) {
    if (launchWarningTimer.current) clearTimeout(launchWarningTimer.current);
    setLaunchWarning("");
    requestAnimationFrame(() => setLaunchWarning(message));
    launchWarningTimer.current = setTimeout(() => setLaunchWarning(""), 4200);
  }

  useEffect(() => {
    return () => {
      if (launchWarningTimer.current) clearTimeout(launchWarningTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStocksLoading(true);
    loadStockCatalogue()
      .then((catalogue) => {
        if (!cancelled) setStocks(catalogue);
      })
      .catch(() => {
        if (!cancelled) setStocks([]);
      })
      .finally(() => {
        if (!cancelled) setStocksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const matchingStocks = useMemo(() => {
    const query = stockQuery.trim().toLowerCase();
    return stocks
      .filter((stock) => !query || `${stock.symbol} ${stock.name}`.toLowerCase().includes(query))
      .slice(0, 80);
  }, [stockQuery, stocks]);

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadErr("");
    setUploading(true);
    // Preview the LOCAL file instantly. The pinned ipfs:// URI is what goes
    // on-chain, but a fresh pin takes minutes to propagate to public gateways,
    // so previewing via the URI showed a blank square right after upload.
    setLocalPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = (await res.json()) as { uri?: string; error?: string };
      if (!res.ok || !data.uri) throw new Error(data.error || "upload failed");
      setImage(data.uri);
    } catch (err) {
      setUploadErr(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  const devBuyWei = devBuy.trim() === "" ? 0n : tryParseEther(devBuy);
  // A requested dev-buy is "too large" if it exceeds the cap — or if the cap
  // hasn't loaded yet (fail closed so a race can't submit an over-cap buy).
  const devBuyTooLarge =
    devBuyWei !== undefined &&
    devBuyWei > 0n &&
    (maxDevBuyWei === undefined || devBuyWei > maxDevBuyWei);

  // Anti-vampire shield: block names/tickers of every curated ancient (matches the
  // on-chain seed) plus a few blue-chips, so copycats can't vamp the originals.
  const blacklist = useMemo(() => {
    const s = new Set<string>([
      "doge", "pepe", "shib", "bonk", "wif", "trump", "eth", "weth", "usdc", "usdt", "usdg",
    ]);
    for (const t of ancientTokens) {
      if (t.symbol) s.add(t.symbol.trim().toLowerCase());
      if (t.name) s.add(t.name.trim().toLowerCase());
    }
    return s;
  }, [ancientTokens]);
  const nameBlocked = name.trim().length > 0 && blacklist.has(name.trim().toLowerCase());
  const symbolBlocked = symbol.trim().length > 0 && blacklist.has(symbol.trim().toLowerCase());
  const vampBlocked = nameBlocked || symbolBlocked;

  const isV4 = launchMode === "v4";
  const formValid =
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    image.trim().length > 0 &&
    !vampBlocked &&
    devBuyWei !== undefined &&
    !devBuyTooLarge &&
    (!isV4 || devBuyWei === 0n) &&
    (isV4 ? canV4Launch : canLaunch);

  useEffect(() => {
    if (!tx.confirmed || !tx.receipt) return;
    let target = "/";
    let launchedToken: string | undefined;
    for (const log of tx.receipt.logs) {
      for (const abi of [potatoCurvePadAbi, potatoV4PadAbi]) {
        try {
          const event = decodeEventLog({
            abi,
            eventName: "TokenCreated",
            data: log.data,
            topics: log.topics,
          });
          launchedToken = event.args.token as string;
          target = `/token/${launchedToken}`;
          break;
        } catch {
          // not a TokenCreated log (e.g. a dev-buy's Buy log) — keep scanning
        }
      }
      if (launchedToken) break;
    }
    // Save the description off-chain (gasless, creator-signed). Best-effort: the
    // token is fully launched regardless, so a declined signature or a failed
    // write just means no description, never a lost token. The redirect waits a
    // moment for the signature prompt but never blocks on it.
    const trimmedDesc = description.trim();
    if (launchedToken && trimmedDesc && userAddress) {
      const tokenAddr = launchedToken;
      void (async () => {
        try {
          const subject = tokenDescriptionHash({ token: tokenAddr, description: trimmedDesc });
          const { nonce, issuedAt, signature } = await signAction(
            userAddress,
            "token-description",
            subject,
            (message) => signMessageAsync({ message }),
          );
          await fetch("/api/token-meta", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              address: userAddress,
              token: tokenAddr,
              description: trimmedDesc,
              nonce,
              issuedAt,
              signature,
            }),
          });
        } catch {
          // creator declined the signature or the write failed — token is fine
        }
      })();
    }
    if (launchedToken && pairedStock && userAddress) {
      const tokenAddr = launchedToken;
      void (async () => {
        try {
          const subject = tokenPairingHash({
            token: tokenAddr,
            symbol: pairedStock.symbol,
            name: pairedStock.name,
            imageUrl: pairedStock.imageUrl,
          });
          const { nonce, issuedAt, signature } = await signAction(
            userAddress,
            "token-pairing",
            subject,
            (message) => signMessageAsync({ message }),
          );
          await fetch("/api/token-pairing", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              address: userAddress,
              token: tokenAddr,
              symbol: pairedStock.symbol,
              name: pairedStock.name,
              imageUrl: pairedStock.imageUrl,
              nonce,
              issuedAt,
              signature,
            }),
          });
        } catch {
          // Pairing is metadata only and never invalidates a successful launch.
        }
      })();
    }
    // Kick the Discover/profile feed so "My profile" / planter pages pick up the
    // new plant sooner (server cache may still lag one TTL).
    void queryClient.invalidateQueries({ queryKey: ["launch-activity"] });
    // Give the optional description-signature prompt room to appear before we
    // navigate; the save continues even after the redirect either way.
    const timer = setTimeout(() => router.push(target), trimmedDesc ? 2500 : 800);
    return () => clearTimeout(timer);
    // description/pairing/userAddress/signMessageAsync are read once at confirmation;
    // intentionally not deps so a later keystroke can't re-fire the save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.confirmed, tx.receipt, router, queryClient]);

  if (!canCreate) {
    return <NotDeployed chainId={chainId} />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!formValid || devBuyWei === undefined) {
      if (vampBlocked) {
        showLaunchWarning("Choose another name or symbol before launching.");
      } else if (!name.trim() || !symbol.trim()) {
        showLaunchWarning("Add a name and symbol before launching.");
      } else if (!image.trim()) {
        showLaunchWarning("Add a token image before launching.");
      } else if (devBuyWei === undefined || devBuyTooLarge) {
        showLaunchWarning("Adjust the dev buy amount before launching.");
      } else if (isV4 && devBuyWei !== 0n) {
        showLaunchWarning("Uniswap v4 launches do not include a dev buy yet. Set it to 0.");
      } else {
        showLaunchWarning("Complete the required fields before launching.");
      }
      return;
    }
    if (staleClient) {
      showLaunchWarning("Reload the page before launching this token.");
      return;
    }
    // Stale-client guard. The pad address is baked into this bundle at build
    // time; a tab left open across a repoint keeps writing to the RETIRED pad
    // (that is exactly how DeepFryer/FROG/POND launched onto the old
    // bounded-range pad hours after the curve pad shipped). Ask the server for
    // its current pad right before submitting and refuse on mismatch. Fail
    // open on network error: this guards a known hazard, it must not brick
    // launches when the config endpoint itself hiccups.
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      const cfg = (await res.json()) as { curvePad?: string | null };
      if (cfg.curvePad && cfg.curvePad.toLowerCase() !== curvePad.toLowerCase()) {
        setStaleClient(true);
        return;
      }
    } catch {
      // config check unavailable — proceed, the wallet still simulates the tx
    }
    // Random CREATE2 salt: makes the token address unpredictable so a griefer
    // can't pre-initialize its Uniswap pool to brick the launch.
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const meta = {
      imageURI: image.trim(),
      // Normalize creator-typed links BEFORE they're baked immutably on-chain:
      // bare domains gain https://, handles become profile URLs, protocol typos
      // are repaired, junk becomes "". A coin with no (usable) site of its own
      // gets Potato Pad as its website, so explorers and aggregators reading
      // this launch metadata link somewhere real instead of rendering a blank.
      website: normalizeSocialUrl(website, "website") ?? SITE_URL,
      twitter: normalizeSocialUrl(twitter, "twitter") ?? "",
      telegram: normalizeSocialUrl(telegram, "telegram") ?? "",
    };
    const trimmedName = name.trim();
    const ticker = symbol.trim().toUpperCase();

    if (isV4) {
      let gas: bigint | undefined;
      try {
        const simulation = await publicClient?.simulateContract({
          address: v4Pad,
          abi: potatoV4PadAbi,
          functionName: "createToken",
          args: [trimmedName, ticker, meta, salt, v4Fee],
          account: userAddress,
        });
        if (simulation?.request.gas) gas = (simulation.request.gas * 12n) / 10n;
      } catch (error) {
        const message =
          error && typeof error === "object" && "shortMessage" in error
            ? String((error as { shortMessage: unknown }).shortMessage)
            : "The network rejected this launch before signing.";
        showLaunchWarning(`Launch simulation failed: ${message}`);
        return;
      }
      tx.writeContract({
        address: v4Pad,
        abi: potatoV4PadAbi,
        functionName: "createToken",
        args: [trimmedName, ticker, meta, salt, v4Fee],
        ...(gas ? { gas } : {}),
      });
      return;
    }

    const common = { address: curvePad, abi: potatoCurvePadAbi, value: devBuyWei } as const;

    // Both entry points launch identically — same locked LP, same treasury cut.
    // createRewardToken additionally splits the creator half with holders.
    if (rewardsOn) {
      let gas: bigint | undefined;
      try {
        const simulation = await publicClient?.simulateContract({
          ...common,
          functionName: "createRewardToken",
          args: [trimmedName, ticker, meta, salt, creatorCutPct * 100],
          account: userAddress,
        });
        if (simulation?.request.gas) gas = (simulation.request.gas * 12n) / 10n;
      } catch (error) {
        const message =
          error && typeof error === "object" && "shortMessage" in error
            ? String((error as { shortMessage: unknown }).shortMessage)
            : "The network rejected this launch before signing.";
        showLaunchWarning(`Launch simulation failed: ${message}`);
        return;
      }
      tx.writeContract({
        ...common,
        functionName: "createRewardToken",
        args: [trimmedName, ticker, meta, salt, creatorCutPct * 100],
        ...(gas ? { gas } : {}),
      });
      return;
    }
    let gas: bigint | undefined;
    try {
      const simulation = await publicClient?.simulateContract({
        ...common,
        functionName: "createToken",
        args: [trimmedName, ticker, meta, salt],
        account: userAddress,
      });
      if (simulation?.request.gas) gas = (simulation.request.gas * 12n) / 10n;
    } catch (error) {
      const message =
        error && typeof error === "object" && "shortMessage" in error
          ? String((error as { shortMessage: unknown }).shortMessage)
          : "The network rejected this launch before signing.";
      showLaunchWarning(`Launch simulation failed: ${message}`);
      return;
    }
    tx.writeContract({
      ...common,
      functionName: "createToken",
      args: [trimmedName, ticker, meta, salt],
      ...(gas ? { gas } : {}),
    });
  }

  const previewSrc = localPreview ?? resolveImageUri(image);
  const submitLabel = tx.isPending
    ? "Confirm in wallet…"
    : tx.isConfirming
      ? "Planting…"
      : tx.confirmed
        ? "Planted"
        : vampBlocked
          ? "Deployment restricted"
          : "Launch token";

  return (
    <div className="mx-auto max-w-4xl">
      {launchWarning && (
        <div
          key={launchWarning}
          role="alert"
          className="launch-warning fixed left-1/2 top-4 z-[100] w-[min(92vw,28rem)] -translate-x-1/2 rounded-2xl border border-amber-300/80 bg-[#fff8df]/95 px-4 py-3 text-center text-sm font-semibold text-[#765514] shadow-[0_18px_45px_-18px_rgba(120,85,10,0.55)] backdrop-blur-xl"
        >
          {launchWarning}
        </div>
      )}
      <ConnectGate>
        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-5">
          {/* LEFT: input matrix */}
          <div className="space-y-6 rounded-3xl border border-white/80 bg-white/70 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_20px_55px_-36px_rgba(15,23,42,0.5)] backdrop-blur-xl sm:p-7 md:col-span-3">
            <div className="border-b border-neutral-100 pb-5">
              <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
                Launch token
              </h1>
            </div>

            <form id="launch-form" onSubmit={onSubmit} className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-[1.35fr_0.65fr]">
                <div className="space-y-1.5">
                  <label htmlFor="name" className={labelCls}>
                    Name
                  </label>
                  <input
                    id="name"
                    className={`${inputCls} ${nameBlocked ? "border-rose-900/60 bg-rose-950/10 text-rose-300" : ""}`}
                    placeholder="Token name"
                    value={name}
                    maxLength={48}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="symbol" className={labelCls}>
                    Symbol
                  </label>
                  <input
                    id="symbol"
                    className={`${inputCls} font-mono uppercase ${symbolBlocked ? "border-rose-900/60 bg-rose-950/10 text-rose-300" : ""}`}
                    placeholder="MASH"
                    value={symbol}
                    maxLength={12}
                    onChange={(e) => setSymbol(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="paired-stock" className={labelCls}>
                  Pair with
                </label>
                <input
                  id="paired-stock"
                  className={`${inputCls} border-white/80 bg-white/65 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_20px_-16px_rgba(15,23,42,0.45)] backdrop-blur-xl`}
                  placeholder="Search by ticker or company"
                  value={stockQuery}
                  onChange={(event) => setStockQuery(event.target.value)}
                />
                {pairedStock && (
                  <button
                    type="button"
                    onClick={() => setPairedStock(null)}
                    className="flex w-full items-center gap-3 rounded-2xl border border-lime-200 bg-lime-50/70 p-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_20px_-16px_rgba(132,204,22,0.45)] backdrop-blur-xl"
                  >
                    <StockLogo stock={pairedStock} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm text-neutral-900">{pairedStock.symbol}</strong>
                      <span className="block truncate text-xs text-neutral-500">{pairedStock.name}</span>
                    </span>
                    <span className="text-xs text-neutral-500">Change</span>
                  </button>
                )}
                {!pairedStock && (
                  <div className="max-h-64 overflow-y-auto rounded-2xl border border-white/80 bg-white/60 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_14px_30px_-22px_rgba(15,23,42,0.5)] backdrop-blur-xl">
                    {stocksLoading ? (
                      <div className="space-y-1 p-2">
                        {Array.from({ length: 5 }).map((_, index) => (
                          <div key={index} className="flex items-center gap-3 rounded-xl px-2 py-2">
                            <div className="h-6 w-6 animate-pulse rounded-full bg-neutral-200" />
                            <div className="flex-1 space-y-1.5">
                              <div className="h-3 w-16 animate-pulse rounded bg-neutral-200" />
                              <div className="h-2.5 w-32 animate-pulse rounded bg-neutral-100" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : matchingStocks.length === 0 ? (
                      <p className="p-4 text-center text-xs text-neutral-500">No matching stocks found.</p>
                    ) : (
                      matchingStocks.map((stock) => (
                        <button
                          key={`${stock.symbol}-${stock.name}`}
                          type="button"
                          onClick={() => {
                            setPairedStock(stock);
                            setStockQuery("");
                          }}
                          className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-all hover:bg-white/85 hover:shadow-sm"
                        >
                          <StockLogo stock={stock} />
                          <span className="min-w-0">
                            <strong className="block text-sm text-neutral-900">{stock.symbol}</strong>
                            <span className="block truncate text-xs text-neutral-500">{stock.name}</span>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className={labelCls}>Image</label>
                </div>
                <div className="flex gap-3">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/80 bg-neutral-50 shadow-sm">
                    {previewSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={previewSrc} alt="" className="h-full w-full object-cover" />
                    ) : uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
                    ) : (
                      <span className="text-neutral-700">—</span>
                    )}
                  </div>
                  <label className="flex flex-1 cursor-pointer items-center justify-center rounded-2xl border border-dashed border-neutral-300 bg-white/55 text-xs font-medium text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-white">
                    {uploading ? "Uploading…" : "Choose image"}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                      className="hidden"
                      disabled={uploading}
                      onChange={handleUpload}
                    />
                  </label>
                </div>
                {uploadErr && (
                  <p className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-xs leading-relaxed text-rose-700">
                    {uploadErr.includes("PINATA_JWT")
                      ? "Image uploads are not configured yet. Add PINATA_JWT to the server environment and try again."
                      : uploadErr}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="twitter" className={labelCls}>
                    X
                  </label>
                  <input
                    id="twitter"
                    className={`${inputCls} text-[11px]`}
                    placeholder="https://x.com/…"
                    value={twitter}
                    onChange={(e) => setTwitter(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="telegram" className={labelCls}>
                    Telegram
                  </label>
                  <input
                    id="telegram"
                    className={`${inputCls} text-[11px]`}
                    placeholder="https://t.me/…"
                    value={telegram}
                    onChange={(e) => setTelegram(e.target.value)}
                  />
                </div>
              </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="website" className={labelCls}>
                  Website
                </label>
                <input
                  id="website"
                  className={`${inputCls} text-[11px]`}
                  placeholder="https://…"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="description" className={labelCls}>
                    Description
                  </label>
                  <span className="text-[9px] text-neutral-600">
                    {description.length}/{DESCRIPTION_MAX}
                  </span>
                </div>
                <textarea
                  id="description"
                  rows={3}
                  maxLength={DESCRIPTION_MAX}
                  className={`${inputCls} resize-none`}
                  placeholder="What's the coin about?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="rounded-2xl border border-neutral-100 bg-neutral-50/60 p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="devbuy" className={labelCls}>
                    Dev buy (ETH)
                  </label>
                  <span className="text-[9px] text-neutral-600">
                    Max {maxDevBuyWei !== undefined ? formatEth(maxDevBuyWei) : "…"} ETH
                  </span>
                </div>
                <input
                  id="devbuy"
                  className={`${inputCls} font-mono tabular-nums`}
                  placeholder="0.00"
                  inputMode="decimal"
                  disabled={isV4}
                  value={devBuy}
                  onChange={(e) => setDevBuy(e.target.value)}
                />
                {isV4 && (
                  <p className="text-xs text-neutral-600">
                    v4 launches start with liquidity only. Buy after launch through Uniswap.
                  </p>
                )}
                {devBuy.trim() !== "" && devBuyWei === undefined && (
                  <p className="text-xs text-rose-400">Enter a valid amount.</p>
                )}
                {devBuyTooLarge && (
                  <p className="text-xs text-rose-400">
                    {maxDevBuyWei !== undefined
                      ? `Max ${formatEth(maxDevBuyWei)} ETH.`
                      : "Checking limit…"}
                  </p>
                )}
              </div>

              <div className="space-y-3 border-t border-neutral-100 pt-5">
                <div>
                  <label className={labelCls}>Launch venue</label>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={!canLaunch}
                      onClick={() => setLaunchMode("v3")}
                      className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        launchMode === "v3"
                          ? "border-amber-500/60 bg-amber-500/10"
                          : "border-neutral-200 bg-white hover:border-neutral-300"
                      } ${!canLaunch ? "cursor-not-allowed opacity-40" : ""}`}
                    >
                      <span className="block text-xs font-bold text-neutral-900">Uniswap v3</span>
                      <span className="mt-0.5 block text-[10px] leading-tight text-neutral-500">
                        Bonding curve + dev buy.
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={!canV4Launch}
                      onClick={() => {
                        setDevBuy("");
                        setLaunchMode("v4");
                      }}
                      className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        launchMode === "v4"
                          ? "border-lime-400 bg-lime-50"
                          : "border-neutral-200 bg-white hover:border-neutral-300"
                      } ${!canV4Launch ? "cursor-not-allowed opacity-40" : ""}`}
                    >
                      <span className="block text-xs font-bold text-neutral-900">Uniswap v4</span>
                      <span className="mt-0.5 block text-[10px] leading-tight text-neutral-500">
                        Locked single-sided liquidity.
                      </span>
                    </button>
                  </div>
                </div>
                {isV4 && (
                  <div className="space-y-1.5 rounded-xl border border-neutral-200 bg-white p-3.5">
                    <label htmlFor="v4fee" className={labelCls}>
                      Trading fee
                    </label>
                    <select
                      id="v4fee"
                      className={inputCls}
                      value={v4Fee}
                      onChange={(e) => setV4Fee(Number(e.target.value))}
                    >
                      <option value={100}>0.01%</option>
                      <option value={500}>0.05%</option>
                      <option value={3000}>0.30%</option>
                      <option value={10000}>1.00%</option>
                    </select>
                    <p className="text-[10px] leading-relaxed text-neutral-600">
                      Fixed when the pool is initialized; it cannot be changed later.
                    </p>
                  </div>
                )}
                {!isV4 ? (
                  <>
                    <div>
                      <label className={labelCls}>Fees</label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRewardsOn(false)}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      rewardsOn
                        ? "border-neutral-200 bg-white hover:border-neutral-300"
                        : "border-amber-500/60 bg-amber-500/10"
                    }`}
                  >
                    <span className="block text-xs font-bold text-neutral-900">Dev fees</span>
                    <span className="mt-0.5 block text-[10px] leading-tight text-neutral-500">
                      You receive fees.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRewardsOn(true)}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      rewardsOn
                        ? "border-lime-400 bg-lime-50"
                        : "border-neutral-200 bg-white hover:border-neutral-300"
                    }`}
                  >
                    <span className="block text-xs font-bold text-neutral-900">Holder rewards</span>
                    <span className="mt-0.5 block text-[10px] leading-tight text-neutral-500">
                      Holders earn fees.
                    </span>
                  </button>
                    </div>

                    {rewardsOn && (
                      <div className="space-y-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3.5">
                    <div className="flex items-baseline justify-between">
                      <label htmlFor="creatorcut" className={labelCls}>
                        Your cut
                      </label>
                      <span className="font-mono text-xs tabular-nums text-neutral-400">
                        {creatorCutPct}% of all fees
                      </span>
                    </div>
                    <input
                      id="creatorcut"
                      type="range"
                      min={0}
                      max={MAX_CREATOR_CUT_PCT}
                      step={5}
                      value={creatorCutPct}
                      onChange={(e) => setCreatorCutPct(Number(e.target.value))}
                      className="w-full accent-amber-500"
                    />

                    {/* Live split preview: the three ways a fee can go. */}
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-neutral-900">
                      <div className="bg-neutral-700" style={{ width: "50%" }} />
                      <div className="bg-amber-500" style={{ width: `${creatorCutPct}%` }} />
                      <div className="bg-emerald-500" style={{ width: `${holderCutPct}%` }} />
                    </div>
                    <dl className="grid grid-cols-3 gap-2 text-center">
                      {[
                        ["Treasury", "50%", "bg-neutral-700"],
                        ["You", `${creatorCutPct}%`, "bg-amber-500"],
                        ["Holders", `${holderCutPct}%`, "bg-emerald-500"],
                      ].map(([label, pct, dot]) => (
                        <div key={label}>
                          <dt className="flex items-center justify-center gap-1 text-[9px] uppercase tracking-wider text-neutral-500">
                            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                            {label}
                          </dt>
                          <dd className="mt-0.5 font-mono text-xs tabular-nums text-neutral-900">
                            {pct}
                          </dd>
                        </div>
                      ))}
                    </dl>

                    <p className="text-[10px] leading-relaxed text-neutral-600">
                      Fee settings are fixed after launch.
                    </p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3.5">
                    <label className={labelCls}>Fee recipients</label>
                    <p className="mt-1 text-[10px] leading-relaxed text-neutral-600">
                      v4 launches use the locked fee locker: 50% to the creator and 50% to
                      treasury. Holder rewards are available on the v3 launch path.
                    </p>
                  </div>
                )}
              </div>
            </form>
          </div>

          {/* RIGHT: shield + submit */}
          <div className="relative flex flex-col gap-4 md:col-span-2 md:sticky md:top-24 md:min-h-[640px]">
            {vampBlocked ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50/75 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_12px_28px_-22px_rgba(225,29,72,0.55)] backdrop-blur-xl">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rose-100 text-xs text-rose-600">
                    !
                  </span>
                  <div className="min-w-0 space-y-1.5">
                    <h4 className="text-xs font-semibold tracking-tight text-rose-900">
                      Name unavailable
                    </h4>
                    <p className="text-[11px] leading-relaxed text-rose-700/80">
                      {nameBlocked ? "Name" : "Symbol"}{" "}
                      <span className="font-mono font-semibold text-rose-900">
                        {(nameBlocked ? name : symbol).trim()}
                      </span>{" "}
                      is protected. Choose another.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-white/80 bg-white/65 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_18px_40px_-24px_rgba(15,23,42,0.45)] backdrop-blur-xl">
                <h4 className="text-base font-semibold tracking-tight text-neutral-900">
                  Name check
                </h4>
                <p className="mt-2 text-sm leading-6 text-neutral-500">
                  Names and symbols are checked before launch.
                </p>
              </div>
            )}

            {staleClient && (
              <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-amber-700">
                  Update required
                </h4>
                <p className="text-[11px] leading-relaxed text-neutral-400">
                  Reload before launching. Your form entries will be lost.
                </p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="w-full rounded-lg bg-amber-500 py-2 text-[11px] font-bold uppercase tracking-widest text-neutral-950 hover:bg-amber-400"
                >
                  Reload page
                </button>
              </div>
            )}
            <div className="relative">
              <div className="w-full">
                <div className="launch-cta-border">
                  <button
                    type="submit"
                    form="launch-form"
                    disabled={tx.busy || tx.confirmed}
                    className={`w-full py-5 text-sm font-semibold tracking-wide transition-all ${
                      formValid && !tx.busy && !tx.confirmed && !staleClient
                        ? "bg-[linear-gradient(180deg,#ffd84a_0%,#f2b90f_48%,#d88a05_100%)] text-[#3a2100] shadow-[inset_0_2px_0_rgba(255,255,218,0.9),inset_0_-3px_0_rgba(142,78,0,0.25),0_12px_24px_-12px_rgba(180,108,0,0.95)] hover:brightness-110"
                        : "cursor-pointer bg-[linear-gradient(180deg,#e9c54b_0%,#c99a20_100%)] text-[#634000] shadow-[inset_0_1px_0_rgba(255,246,170,0.7)] hover:brightness-105"
                    }`}
                  >
                    {submitLabel}
                  </button>
                </div>
              </div>
            </div>
            <TxStatus tx={tx} chainId={chainId} successLabel="Token planted, taking you to its page…" />
          </div>
        </div>
      </ConnectGate>
    </div>
  );
}

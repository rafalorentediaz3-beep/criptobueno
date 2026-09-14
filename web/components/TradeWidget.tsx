"use client";

import { ExternalLink, TrendingUp } from "lucide-react";
import { useState } from "react";
import {
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract } from "wagmi";
import { potatoTokenAbi } from "@/lib/abi";
import {
  POOL_FEE_TIER,
  QUOTER_ADDRESSES,
  SWAP_ROUTER_ADDRESSES,
  UNIVERSAL_ROUTER_ADDRESSES,
  V4_QUOTER_ADDRESSES,
  ZERO_ADDRESS,
  uniswapSwapUrl,
} from "@/lib/config";
import {
  ROUTER_ADDRESS_THIS,
  quoterV2Abi,
  swapRouter02Abi,
  universalRouterAbi,
  v4QuoterAbi,
} from "@/lib/pool";
import { usePad, useTx } from "@/lib/hooks";
import { formatEth, formatTokens, tryParseEther, withSlippage } from "@/lib/format";
import { AddressChip } from "@/components/AddressChip";
import { ConnectGate } from "@/components/ConnectGate";
import { TxStatus } from "@/components/TxStatus";

/** Keep a little ETH aside for gas when quick-filling "Max" on buys. */
const GAS_BUFFER = parseEther("0.01");

/**
 * How long a signed swap stays valid, in seconds. SwapRouter02's
 * `exactInputSingle` struct has no deadline, so a signed-but-unmined swap would
 * otherwise linger in the mempool indefinitely (bounded only by slippage) and
 * be executed later when it's sandwich-profitable. We wrap the call in the
 * router's `multicall(deadline, [...])`, which reverts once the deadline passes.
 */
const SWAP_DEADLINE_SECONDS = 600n; // 10 minutes

/**
 * Deadline measured against the CHAIN's clock, not the browser's.
 *
 * The router compares against `block.timestamp`, so a browser clock that is
 * behind the chain produces a deadline already in the chain's past and every
 * swap reverts `Transaction too old`. That is easy to hit on a local or forked
 * node (Hardhat stamps each auto-mined block at least a second after the last,
 * so a burst of activity runs the chain clock ahead of real time), and it can
 * also bite a user whose system clock is simply wrong.
 *
 * Taking the max of the two is safe in both directions: the chain's own
 * timestamp when it is ahead, wall-clock when the latest block is stale.
 *
 * NOTE: this makes the window an UPPER bound, not an exact one. When the chain
 * clock lags wall-clock, the effective allowance measured against
 * `block.timestamp` is longer than SWAP_DEADLINE_SECONDS by however far it lags.
 * Immaterial on an L2 with real blocktimes, but do not later tighten this
 * constant on the assumption that it is exact.
 */
function swapDeadline(latestBlockTs?: bigint): bigint {
  const wall = BigInt(Math.floor(Date.now() / 1000));
  const base = latestBlockTs && latestBlockTs > wall ? latestBlockTs : wall;
  return base + SWAP_DEADLINE_SECONDS;
}

const SLIPPAGE_OPTIONS: Array<{ label: string; bps: bigint }> = [
  { label: "1%", bps: 100n },
  { label: "5%", bps: 500n },
  { label: "10%", bps: 1000n },
];

export function TradeWidget({
  token,
  symbol,
  pool,
  feeTier = POOL_FEE_TIER,
  isV4 = false,
  v4PoolId,
  v4Fee,
  isCurve = false,
  bonded = false,
  pairToken,
  pairSymbol,
}: {
  token: Address;
  symbol: string;
  pool: Address;
  /** Uniswap pool fee tier (bps). Defaults to PotatoPad's 1% tier; ancient tokens pass their own. */
  feeTier?: number;
  /** True for a direct-to-Uniswap-v4 launch. */
  isV4?: boolean;
  /** v4 PoolId, used to ensure this is a resolved v4 deployment. */
  v4PoolId?: Hex;
  /** v4 fee tier in hundredths of a bip. */
  v4Fee?: number;
  /** True when the token launched on the bonding-curve pad. */
  isCurve?: boolean;
  /** True once a curve token has bonded (its position locked into the fee locker). */
  bonded?: boolean;
  /** V4 quote asset. Tokenized-stock pools use this instead of WETH. */
  pairToken?: Address;
  pairSymbol?: string;
}) {
  const { address: user } = useAccount();
  const { chainId, weth } = usePad();
  const buyTx = useTx();
  const approveTx = useTx();
  const sellTx = useTx();

  const router = isV4
    ? UNIVERSAL_ROUTER_ADDRESSES[chainId]
    : SWAP_ROUTER_ADDRESSES[chainId];
  // Chain clock for the swap deadline, read ON DEMAND at submit rather than
  // polled. A poller would add a recurring hit to the rate-limited /api/rpc proxy
  // on every open token page, and the value is only ever needed at the moment a
  // swap is signed.
  const publicClient = usePublicClient();
  async function chainNow(): Promise<bigint | undefined> {
    try {
      return (await publicClient?.getBlock())?.timestamp;
    } catch {
      return undefined; // fall back to wall-clock inside swapDeadline()
    }
  }
  const quoter = isV4 ? V4_QUOTER_ADDRESSES[chainId] : QUOTER_ADDRESSES[chainId];
  // Every token — curve (pre- and post-migration), direct, ancient, and v4 —
  // trades through Uniswap. V4 uses its PoolKey and Universal Router instead
  // of the V3 pool/router pair.
  const onCurve = isCurve && !bonded; // pre-bond curve phase (copy only)
  const spender = router ?? ZERO_ADDRESS; // sells approve the router
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amountIn, setAmountIn] = useState("");
  const [slippageBps, setSlippageBps] = useState<bigint>(500n);
  const selectedV4Fee = v4Fee ?? 10_000;
  const quoteToken = pairToken ?? weth;
  const tokenIs0 = BigInt(token) < BigInt(quoteToken);
  const v4PoolKey = {
    currency0: tokenIs0 ? token : quoteToken,
    currency1: tokenIs0 ? quoteToken : token,
    fee: selectedV4Fee,
    tickSpacing:
      selectedV4Fee === 100
        ? 1
        : selectedV4Fee === 500
          ? 10
          : selectedV4Fee === 3_000
            ? 60
            : selectedV4Fee === 20_000
              ? 400
              : 200,
    hooks: ZERO_ADDRESS,
  } as const;
  const v4ZeroForOne = mode === "buy" ? !tokenIs0 : tokenIs0;
  const isStockPair = isV4 && quoteToken.toLowerCase() !== weth.toLowerCase();
  const inApp =
    !!router &&
    weth !== ZERO_ADDRESS &&
    !isStockPair &&
    (!isV4 || (!!v4PoolId && !!quoter));

  const amount = tryParseEther(amountIn);
  const hasAmount = amount !== undefined && amount > 0n;

  const { data: ethBalance } = useBalance({ address: user, query: { enabled: !!user } });

  const { data: tokenBalance } = useReadContract({
    address: token,
    abi: potatoTokenAbi,
    functionName: "balanceOf",
    args: [user ?? ZERO_ADDRESS],
    query: { enabled: !!user },
  });

  const { data: allowance } = useReadContract({
    address: token,
    abi: potatoTokenAbi,
    functionName: "allowance",
    args: [user ?? ZERO_ADDRESS, spender],
    query: { enabled: !!user && spender !== ZERO_ADDRESS },
  });

  const exceedsBalance =
    hasAmount &&
    (mode === "sell"
      ? tokenBalance !== undefined && amount > tokenBalance
      : ethBalance !== undefined && amount > ethBalance.value);

  // Accurate quote from QuoterV2 (accounts for the pool's impact).
  const { data: v3Quote, isFetching: v3Quoting } = useReadContract({
    address: !isV4 ? quoter ?? ZERO_ADDRESS : ZERO_ADDRESS,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: mode === "buy" ? weth : token,
        tokenOut: mode === "buy" ? token : weth,
        amountIn: amount ?? 0n,
        fee: feeTier,
        sqrtPriceLimitX96: 0n,
      },
    ],
    query: { enabled: !isV4 && inApp && !!quoter && hasAmount && !exceedsBalance },
  });
  const { data: v4Quote, isFetching: v4Quoting } = useReadContract({
    address: isV4 ? quoter ?? ZERO_ADDRESS : ZERO_ADDRESS,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: v4PoolKey,
        zeroForOne: v4ZeroForOne,
        exactAmount: (amount ?? 0n) as bigint,
        hookData: "0x",
      },
    ],
    query: { enabled: isV4 && inApp && !!quoter && hasAmount && !exceedsBalance },
  });

  const quoting = isV4 ? v4Quoting : v3Quoting;
  const amountOut = (isV4 ? v4Quote : v3Quote)?.[0] ?? 0n;
  const minOut = amountOut > 0n ? withSlippage(amountOut, slippageBps) : 0n;
  const needsApproval =
    mode === "sell" &&
    hasAmount &&
    !exceedsBalance &&
    allowance !== undefined &&
    allowance < amount;

  // ---- Fallback: no in-app router on this chain -> Uniswap link -------------
  if (!inApp) {
    return (
      <div className="card p-5">
        <h3 className="flex items-center gap-2 font-bold text-neutral-100">
          <TrendingUp className="h-4 w-4 text-amber-500" />
          Trade
        </h3>
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-center">
          <p className="font-semibold text-amber-400">
            Live on Uniswap {isV4 ? "V4" : "V3"}
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            {isStockPair
              ? `This pool trades directly against ${pairSymbol ?? "the paired stock"}.`
              : "In-app trading isn't wired for this network. Trade directly on Uniswap."}
          </p>
          <a
            href={uniswapSwapUrl(token, chainId, isStockPair ? quoteToken : undefined)}
            target="_blank"
            rel="noreferrer"
            className="btn-primary mt-4 w-full"
          >
            Trade on Uniswap
            <ExternalLink className="h-4 w-4" />
          </a>
          {pool !== ZERO_ADDRESS && (
            <div className="mt-3 flex items-center justify-center gap-2 text-xs text-neutral-500">
              Pool <AddressChip address={pool} chainId={chainId} />
            </div>
          )}
        </div>
      </div>
    );
  }

  function fillBuyMax() {
    if (!ethBalance) return;
    const max = ethBalance.value > GAS_BUFFER ? ethBalance.value - GAS_BUFFER : 0n;
    setAmountIn(formatEther(max));
  }

  function fillSellFraction(bps: bigint) {
    if (tokenBalance === undefined) return;
    setAmountIn(formatEther((tokenBalance * bps) / 10000n));
  }

  async function onBuy() {
    if (amount === undefined || !user || minOut === 0n || !router || exceedsBalance) return;
    if (isV4) {
      // Universal Router: wrap the caller's ETH, perform one V4 exact-input
      // action, settle WETH from the router balance, and take the token to
      // msgSender (the caller).
      // This intentionally only exposes the native-ETH buy path here. V4
      // ERC-20 sells require a Permit2 signature/allowance and are kept on
      // the canonical Uniswap UI rather than pretending a normal ERC-20
      // approval is sufficient.
      const v4SwapParams = encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes[]" }],
        [
          "0x060b0f",
          [
            encodeAbiParameters(
              [{ type: "tuple", components: [
                { name: "poolKey", type: "tuple", components: [
                  { name: "currency0", type: "address" },
                  { name: "currency1", type: "address" },
                  { name: "fee", type: "uint24" },
                  { name: "tickSpacing", type: "int24" },
                  { name: "hooks", type: "address" },
                ] },
                { name: "zeroForOne", type: "bool" },
                { name: "amountIn", type: "uint128" },
                { name: "amountOutMinimum", type: "uint128" },
                { name: "minHopPriceX36", type: "uint256" },
                { name: "hookData", type: "bytes" },
              ] }],
              [{ poolKey: v4PoolKey, zeroForOne: v4ZeroForOne, amountIn: amount, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }],
            ),
            encodeAbiParameters(
              [{ type: "tuple", components: [
                { name: "currency", type: "address" },
                { name: "amount", type: "uint256" },
                { name: "payerIsUser", type: "bool" },
              ] }],
              [{ currency: weth, amount, payerIsUser: false }],
            ),
            encodeAbiParameters(
              [{ type: "tuple", components: [
                { name: "currency", type: "address" },
                { name: "minAmount", type: "uint256" },
              ] }],
              [{ currency: token, minAmount: minOut }],
            ),
          ],
        ],
      );
      const wrapInput = encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [ROUTER_ADDRESS_THIS, amount],
      );
      buyTx.writeContract({
        address: router,
        abi: universalRouterAbi,
        functionName: "execute",
        args: ["0x0b10", [wrapInput, v4SwapParams], swapDeadline(await chainNow())],
        value: amount,
      });
      return;
    }
    const swapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: weth,
          tokenOut: token,
          fee: feeTier,
          recipient: user,
          amountIn: amount,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    // Wrap in the deadline-checked multicall so the tx can't be mined late.
    buyTx.writeContract({
      address: router,
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [swapDeadline(await chainNow()), [swapData]],
      value: amount,
    });
  }

  function onApprove() {
    // Sells approve the Uniswap router as spender.
    if (amount === undefined || spender === ZERO_ADDRESS) return;
    approveTx.writeContract({
      address: token,
      abi: potatoTokenAbi,
      functionName: "approve",
      args: [spender, amount],
    });
  }

  async function onSell() {
    if (isV4) return;
    if (amount === undefined || !user || minOut === 0n || !router || exceedsBalance) return;
    // Swap output stays IN the router (ADDRESS_THIS sentinel), then unwrapWETH9
    // in the same multicall pays the user native ETH instead of the WETH ERC-20
    // they'd otherwise have to unwrap by hand.
    const swapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: token,
          tokenOut: weth,
          fee: feeTier,
          recipient: ROUTER_ADDRESS_THIS,
          amountIn: amount,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const unwrapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "unwrapWETH9",
      args: [minOut, user],
    });
    // Wrap in the deadline-checked multicall so the tx can't be mined late.
    sellTx.writeContract({
      address: router,
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [swapDeadline(await chainNow()), [swapData, unwrapData]],
    });
  }

  const noQuote = hasAmount && !quoting && amountOut === 0n && !exceedsBalance;

  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 font-bold text-neutral-100">
        <TrendingUp className="h-4 w-4 text-amber-500" />
        Trade
      </h3>

      <ConnectGate>
        {/* Buy / Sell segmented toggle */}
        <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg border border-neutral-800 bg-neutral-950 p-1">
          <button
            type="button"
            onClick={() => {
              setMode("buy");
              setAmountIn("");
            }}
            className={`rounded-md py-2 text-sm font-bold transition-colors ${
              mode === "buy"
                ? "bg-amber-500 text-neutral-900"
                : "text-neutral-400 hover:text-neutral-100"
            }`}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("sell");
              setAmountIn("");
            }}
            className={`rounded-md py-2 text-sm font-bold transition-colors ${
              mode === "sell"
                ? "bg-red-500/80 text-neutral-50"
                : "text-neutral-400 hover:text-neutral-100"
            }`}
          >
            Sell
          </button>
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor={`trade-${token}`} className="label mb-0">
              {mode === "buy" ? "You pay (ETH)" : `You sell (${symbol})`}
            </label>
            {mode === "buy"
              ? ethBalance && (
                  <span className="font-mono text-xs text-neutral-500">
                    Bal {formatEth(ethBalance.value)} ETH
                  </span>
                )
              : tokenBalance !== undefined && (
                  <span className="font-mono text-xs text-neutral-500">
                    Bal {formatTokens(tokenBalance)}
                  </span>
                )}
          </div>
          <input
            id={`trade-${token}`}
            className="input font-mono"
            placeholder="0.0"
            inputMode="decimal"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
          />

          {/* quick-fill chips */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {isV4 && mode === "sell" ? (
              <a
                href={uniswapSwapUrl(token, chainId)}
                target="_blank"
                rel="noreferrer"
                className="btn-danger mt-4 w-full"
              >
                Sell on Uniswap
                <ExternalLink className="h-4 w-4" />
              </a>
            ) : mode === "buy" ? (
              <>
                {["0.1", "0.5", "1"].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmountIn(v)}
                    className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-neutral-400 transition-colors hover:border-amber-500/40 hover:text-amber-400"
                  >
                    {v}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={fillBuyMax}
                  disabled={!ethBalance}
                  className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-neutral-400 transition-colors hover:border-amber-500/40 hover:text-amber-400 disabled:opacity-50"
                >
                  Max
                </button>
              </>
            ) : (
              <>
                {[
                  ["25%", 2500n],
                  ["50%", 5000n],
                  ["75%", 7500n],
                  ["Max", 10000n],
                ].map(([label, bps]) => (
                  <button
                    key={label as string}
                    type="button"
                    onClick={() => fillSellFraction(bps as bigint)}
                    disabled={tokenBalance === undefined}
                    className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-neutral-400 transition-colors hover:border-amber-500/40 hover:text-amber-400 disabled:opacity-50"
                  >
                    {label as string}
                  </button>
                ))}
              </>
            )}
          </div>

          {amountIn.trim() !== "" && amount === undefined && (
            <p className="mt-1.5 text-xs text-red-400">Enter a valid amount.</p>
          )}
          {exceedsBalance && (
            <p className="mt-1.5 text-xs text-red-400">Amount exceeds your balance.</p>
          )}
        </div>

        {/* quote */}
        <dl className="mt-4 space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-neutral-500">You receive ≈</dt>
            <dd className="font-mono text-neutral-100">
              {!hasAmount || exceedsBalance
                ? "-"
                : quoting
                  ? "…"
                  : mode === "buy"
                    ? `${formatTokens(amountOut)} ${symbol}`
                    : `${formatEth(amountOut)} ETH`}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-neutral-500">Max slippage</dt>
            <dd className="flex gap-1">
              {SLIPPAGE_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setSlippageBps(o.bps)}
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                    slippageBps === o.bps
                      ? "bg-amber-500/20 text-amber-300"
                      : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">Min received</dt>
            <dd className="font-mono text-neutral-400">
              {!hasAmount || exceedsBalance || amountOut === 0n
                ? "-"
                : mode === "buy"
                  ? `${formatTokens(minOut)} ${symbol}`
                  : `${formatEth(minOut)} ETH`}
            </dd>
          </div>
        </dl>

        {noQuote && (
          <p className="mt-2 text-xs text-amber-400/80">
            Couldn&apos;t fetch a live quote. Try a different amount or trade on Uniswap.
          </p>
        )}

        {/* CTA */}
        {mode === "buy" ? (
          <button
            type="button"
            className="btn-primary mt-4 w-full"
            disabled={!hasAmount || quoting || minOut === 0n || exceedsBalance || buyTx.busy}
            onClick={onBuy}
          >
            {buyTx.isPending
              ? "Confirm in wallet…"
              : buyTx.isConfirming
                ? "Buying…"
                : `Buy $${symbol}`}
          </button>
        ) : needsApproval ? (
          <button
            type="button"
            className="btn-danger mt-4 w-full"
            disabled={approveTx.busy || exceedsBalance}
            onClick={onApprove}
          >
            {approveTx.isPending
              ? "Confirm in wallet…"
              : approveTx.isConfirming
                ? "Approving…"
                : `1. Approve $${symbol}`}
          </button>
        ) : (
          <button
            type="button"
            className="btn-danger mt-4 w-full"
            disabled={!hasAmount || quoting || minOut === 0n || exceedsBalance || sellTx.busy}
            onClick={onSell}
          >
            {sellTx.isPending
              ? "Confirm in wallet…"
              : sellTx.isConfirming
                ? "Selling…"
                : `Sell $${symbol}`}
          </button>
        )}

        {mode === "buy" ? (
          <TxStatus tx={buyTx} chainId={chainId} successLabel="Buy confirmed!" />
        ) : (
          <>
            <TxStatus
              tx={approveTx}
              chainId={chainId}
              successLabel="Approval confirmed, you can sell now."
            />
            <TxStatus tx={sellTx} chainId={chainId} successLabel="Sell confirmed!" />
          </>
        )}

        <div className="mt-3 flex items-center justify-between text-[11px] text-neutral-600">
          <span>
            {isV4
              ? `Swaps route through Uniswap V4 (${selectedV4Fee / 10_000}% fee). Sells use Permit2 on Uniswap.`
              : onCurve
              ? `Bonding curve — every buy walks the price up until it fills, then migrates. Routes through Uniswap V3 (${feeTier / 10_000}% fee).`
              : `Swaps route through Uniswap V3 (${feeTier / 10_000}% fee).`}
          </span>
          <a
            href={uniswapSwapUrl(token, chainId)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-neutral-500 hover:text-amber-400"
          >
            Uniswap
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </ConnectGate>
    </div>
  );
}

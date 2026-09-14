import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, decodeEventLog, http, isAddress, parseAbiItem, type Address, type Hex } from "viem";
import { robinhoodChain, V4_POOL_MANAGER_ADDRESSES, WETH_ADDRESSES, ZERO_ADDRESS } from "@/lib/config";
import { PUBLIC_RPC } from "@/lib/serverRpc";

export const runtime = "nodejs";

const v4SwapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
);

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(PUBLIC_RPC, { timeout: 35_000 }),
});

function isHex32(value: string | null): value is Hex {
  return !!value && /^0x[0-9a-fA-F]{64}$/.test(value);
}

const Q96 = 2 ** 96;

function tokenIsToken0(token: Address, weth: Address): boolean {
  return BigInt(token) < BigInt(weth);
}

function priceWethPerToken(sqrtPriceX96: bigint, isToken0: boolean): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const ratio = Number(sqrtPriceX96) / Q96;
  const p = ratio * ratio;
  if (!Number.isFinite(p) || p <= 0) return 0;
  return isToken0 ? p : 1 / p;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const poolId = req.nextUrl.searchParams.get("poolId");
  const quoteTokenRaw = req.nextUrl.searchParams.get("quoteToken");
  const fromBlockRaw = req.nextUrl.searchParams.get("fromBlock");
  if (!token || !isAddress(token) || !isHex32(poolId) || (quoteTokenRaw !== null && !isAddress(quoteTokenRaw))) {
    return NextResponse.json({ error: "invalid token, quoteToken, or poolId" }, { status: 400 });
  }

  const fromBlock =
    fromBlockRaw && /^\d+$/.test(fromBlockRaw) ? BigInt(fromBlockRaw) : undefined;
  const manager = V4_POOL_MANAGER_ADDRESSES[robinhoodChain.id] ?? ZERO_ADDRESS;
  const weth = WETH_ADDRESSES[robinhoodChain.id] ?? ZERO_ADDRESS;
  const quoteToken = (quoteTokenRaw as Address | null) ?? weth;
  if (manager === ZERO_ADDRESS || weth === ZERO_ADDRESS) {
    return NextResponse.json({ points: [], latestTs: 0 });
  }

  const latest = await client.getBlockNumber();
  const start = fromBlock && fromBlock <= latest ? fromBlock : latest > 250_000n ? latest - 250_000n : 0n;
  const logs = await client.getLogs({
    address: manager,
    event: v4SwapEvent,
    args: { id: poolId },
    fromBlock: start,
    toBlock: latest,
  });

  const blocks = Array.from(new Set(logs.map((log) => log.blockNumber ?? 0n))).filter(Boolean);
  const blockEntries = await Promise.all(
    blocks.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber });
      return [blockNumber.toString(), Number(block.timestamp)] as const;
    }),
  );
  const timestamps = new Map(blockEntries);
  const isToken0 = tokenIsToken0(token as Address, quoteToken);
  const points = logs
    .map((log) => {
      const decoded = decodeEventLog({ abi: [v4SwapEvent], data: log.data, topics: log.topics });
      const tokenDelta = isToken0 ? decoded.args.amount0 : decoded.args.amount1;
      const wethDelta = isToken0 ? decoded.args.amount1 : decoded.args.amount0;
      return {
        timestamp: timestamps.get((log.blockNumber ?? 0n).toString()) ?? 0,
        price: priceWethPerToken(decoded.args.sqrtPriceX96, isToken0),
        sender: decoded.args.sender,
        side: tokenDelta < 0n ? "buy" : "sell",
        tokenAmount: Math.abs(Number(tokenDelta) / 1e18),
        wethAmount: Math.abs(Number(wethDelta) / 1e18),
      };
    })
    .filter((point) => point.price > 0 && point.timestamp > 0);

  const latestBlock = await client.getBlock({ blockNumber: latest });
  return NextResponse.json(
    { points, latestTs: Number(latestBlock.timestamp) },
    { headers: { "Cache-Control": "public, s-maxage=20, stale-while-revalidate=60" } },
  );
}

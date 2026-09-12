"use client";

// Kept separate from lib/config.ts: RainbowKit's getDefaultConfig is
// client-only, and config.ts is also imported by server components.
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "viem";
import { baseSepolia, hardhat } from "wagmi/chains";
import { isChainDeployed, robinhoodChain } from "./config";
import { robinhoodServerTransport } from "./serverRpc";

// Robinhood reads go through our same-origin /api/rpc proxy in the browser, so
// the Alchemy key never ships to the client and can't be scraped. On the server
// (SSR) we hit the Alchemy endpoint directly from the server-only env var.
// `batch: true` lets viem coalesce concurrent single eth_call/eth_getLogs/etc.
// requests (e.g. curve reads, v4 reads, and pool reads all firing on the same
// tick) into ONE JSON-RPC array POST instead of several separate round trips —
// the proxy already accepts and de-dupes/caches batched array bodies (see
// app/api/rpc/route.ts), so this is a pure latency win with no server change.
const robinhoodTransport =
  typeof window === "undefined"
    ? robinhoodServerTransport()
    : http(`${window.location.origin}/api/rpc`, { batch: true });

// Chains with a deployed pad (curve OR direct) first: wagmi treats the first
// chain as the default when no wallet is connected, so visitors land on a
// network where the app actually exists instead of an empty-state page.
const chains = [robinhoodChain, baseSepolia, hardhat].sort(
  (a, b) => (isChainDeployed(b.id) ? 1 : 0) - (isChainDeployed(a.id) ? 1 : 0)
) as [typeof robinhoodChain, typeof baseSepolia, typeof hardhat];

export const wagmiConfig = getDefaultConfig({
  appName: "PotatoPad",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "potatopad-demo",
  chains,
  transports: {
    [baseSepolia.id]: http(),
    [hardhat.id]: http("http://127.0.0.1:8545"),
    [robinhoodChain.id]: robinhoodTransport,
  },
  // Every browser RPC read tunnels through /api/rpc → Alchemy. wagmi's 4s default
  // block-poll (balances, block number) multiplies that; 15s is plenty fresh for a
  // launchpad and cuts proxy/Alchemy load ~4x.
  pollingInterval: 30_000,
  ssr: true,
});

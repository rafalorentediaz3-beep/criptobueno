"use client";

// Kept separate from lib/config.ts: RainbowKit's getDefaultConfig is
// client-only, and config.ts is also imported by server components.
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { metaMaskWallet, phantomWallet, zerionWallet } from "@rainbow-me/rainbowkit/wallets";
import { http } from "viem";
import { robinhoodChain } from "./config";
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

const chains = [robinhoodChain] as const;

export const wagmiConfig = getDefaultConfig({
  appName: "PotatoPad",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "potatopad-demo",
  wallets: [
    {
      groupName: "Wallets",
      wallets: [phantomWallet, zerionWallet, metaMaskWallet],
    },
  ],
  chains,
  transports: {
    [robinhoodChain.id]: robinhoodTransport,
  },
  // Every browser RPC read tunnels through /api/rpc → Alchemy. wagmi's 4s default
  // block-poll (balances, block number) multiplies that; 15s is plenty fresh for a
  // launchpad and cuts proxy/Alchemy load ~4x.
  pollingInterval: 30_000,
  ssr: true,
});

"use client";

// Kept separate from lib/config.ts: RainbowKit's getDefaultConfig is
// client-only, and config.ts is also imported by server components.
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "viem";
import { robinhoodChain } from "./config";
import { robinhoodServerTransport } from "./serverRpc";

// Robinhood reads go through our same-origin /api/rpc proxy in the browser, so
// the Alchemy key never ships to the client and can't be scraped. On the server
// (SSR) we hit the Alchemy endpoint directly from the server-only env var.
const robinhoodTransport =
  typeof window === "undefined"
    ? robinhoodServerTransport()
    : http(`${window.location.origin}/api/rpc`);

const chains = [robinhoodChain] as const;

export const wagmiConfig = getDefaultConfig({
  appName: "PotatoPad",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "potatopad-demo",
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

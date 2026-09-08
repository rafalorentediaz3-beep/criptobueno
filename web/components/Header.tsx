"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { BarChart3, User, Wallet } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { getAddress } from "viem";
import { useAccount } from "wagmi";

export function Header() {
  const pathname = usePathname();
  const { address: connected } = useAccount();
  // EVERY connected wallet has a profile now (auto-named until claimed, editable
  // there), so this no longer waits on the launch feed or requires having planted
  // a coin — that older gate left non-planters with no way to reach their profile.
  const myProfileHref = useMemo(() => {
    if (!connected) return null;
    try {
      return `/creator/${getAddress(connected)}`;
    } catch {
      return null;
    }
  }, [connected]);

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-neutral-900/65 shadow-[0_8px_30px_-24px_rgba(0,0,0,0.75)] backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex h-[76px] w-full max-w-6xl items-center gap-5 px-4 sm:px-6">
        <Link href="/" className="flex min-w-0 shrink-0 items-center">
          <img
            src="/header-logo.png"
            alt="PotatoPad"
            className="h-14 w-auto max-w-[240px] object-contain sm:h-16 sm:max-w-[280px]"
          />
        </Link>

        <nav className="hidden items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_-18px_rgba(0,0,0,0.65)] backdrop-blur-xl md:flex">
          <Link
            href="/"
            className={`rounded-full px-4 py-2 text-sm transition-colors ${
              pathname === "/"
                ? "bg-neutral-800 font-medium text-neutral-100 shadow-sm"
                : "text-neutral-500 hover:text-neutral-100"
            }`}
          >
            Explore
          </Link>
          <Link href="/analytics" className={`rounded-full px-4 py-2 text-sm transition-colors ${
            pathname.startsWith("/analytics")
              ? "bg-neutral-800 font-medium text-neutral-100 shadow-sm"
              : "text-neutral-500 hover:text-neutral-100"
          }`}>
            Analytics
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/create"
            className={`hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_14px_-10px_rgba(0,0,0,0.65)] backdrop-blur-xl transition-colors hover:border-white/20 hover:bg-white/10 sm:flex ${
              pathname === "/create"
                ? "ring-2 ring-white/10"
                : "text-neutral-200"
            }`}
          >
            <span className="text-lg leading-none">+</span> Create
          </Link>
          <ConnectButton.Custom>
            {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
              const ready = mounted;
              const connected = ready && account && chain;
              return !connected ? (
                <button type="button" onClick={openConnectModal} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-neutral-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_14px_-10px_rgba(0,0,0,0.65)] backdrop-blur-xl transition-colors hover:bg-white/10">
                  <Wallet className="h-4 w-4" /> <span className="hidden sm:inline">Connect</span>
                </button>
              ) : chain.unsupported ? (
                <button type="button" onClick={openChainModal} className="rounded-full bg-red-950/60 px-4 py-2 text-sm font-medium text-red-400">Wrong network</button>
              ) : (
                <div className="flex items-center gap-2">
                  {myProfileHref && <Link href={myProfileHref} aria-label="My profile" className="hidden h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-neutral-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_14px_-10px_rgba(0,0,0,0.65)] backdrop-blur-xl hover:bg-white/10 sm:flex"><User className="h-4 w-4" /></Link>}
                  <button type="button" onClick={openChainModal} className="hidden h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-neutral-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_14px_-10px_rgba(0,0,0,0.65)] backdrop-blur-xl hover:bg-white/10 lg:flex"><BarChart3 className="h-4 w-4" /></button>
                          <button type="button" onClick={openAccountModal} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-2 font-mono text-xs font-medium text-neutral-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_14px_-10px_rgba(0,0,0,0.65)] backdrop-blur-xl hover:bg-white/10">{account.displayName}</button>
                </div>
              );
            }}
          </ConnectButton.Custom>
        </div>
      </div>
    </header>
  );
}

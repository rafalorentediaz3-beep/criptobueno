"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Bot, LogOut, User, Wallet } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { getAddress } from "viem";
import { useAccount, useDisconnect } from "wagmi";
import { useSearch } from "./SearchContext";

export function Header() {
  const pathname = usePathname();
  const { setQuery } = useSearch();
  const { address: connected } = useAccount();
  const { disconnect } = useDisconnect();
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
        <Link href="/" onClick={() => setQuery("")} className="flex min-w-0 shrink-0 items-center">
          <Image
            src="/header-logo.png"
            alt="Site logo"
            width={64}
            height={64}
            sizes="(min-width: 640px) 64px, 56px"
            priority
            className="h-14 w-14 object-contain sm:h-16 sm:w-16"
          />
        </Link>

        <nav className="hidden rounded-full bg-[linear-gradient(115deg,rgba(255,214,112,0.34),rgba(255,255,255,0.1)_42%,rgba(236,72,153,0.4))] p-px shadow-[0_12px_32px_-20px_rgba(236,72,153,0.55)] md:block">
          <div className="flex items-center gap-1 rounded-full bg-[#171411]/90 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(236,72,153,0.06)] backdrop-blur-2xl backdrop-saturate-150">
            <Link
              href="/"
              className={`relative rounded-full px-5 py-2 text-sm font-semibold transition-all duration-200 ${
                pathname === "/"
                  ? "bg-[linear-gradient(135deg,rgba(255,255,255,0.12),rgba(236,72,153,0.13))] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_5px_18px_-11px_rgba(236,72,153,0.95)] ring-1 ring-pink-400/15"
                  : "text-neutral-100/90 hover:bg-white/[0.055] hover:text-white"
              }`}
            >
              Explore
            </Link>
            <Link
              href="/analytics"
              className={`relative rounded-full px-5 py-2 text-sm font-semibold transition-all duration-200 ${
                pathname.startsWith("/analytics")
                  ? "bg-[linear-gradient(135deg,rgba(255,255,255,0.12),rgba(236,72,153,0.13))] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_5px_18px_-11px_rgba(236,72,153,0.95)] ring-1 ring-pink-400/15"
                  : "text-neutral-100/90 hover:bg-white/[0.055] hover:text-white"
              }`}
            >
              Analytics
            </Link>

            <Link
              href="/bot.html"
              className={`relative inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold transition-all duration-200 ${
                pathname.startsWith("/bot")
                  ? "bg-[linear-gradient(135deg,rgba(255,255,255,0.12),rgba(236,72,153,0.13))] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_5px_18px_-11px_rgba(236,72,153,0.95)] ring-1 ring-pink-400/15"
                  : "text-neutral-100/90 hover:bg-white/[0.055] hover:text-white"
              }`}
            >
              <Bot className="h-4 w-4" /> Bot
            </Link>

            <button
              type="button"
              disabled
              className="group flex cursor-not-allowed items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-[#c5b593]/85"
            >
              Marketplace
              <span className="rounded-full border border-pink-300/30 bg-pink-500/15 px-2 py-0.5 text-[9px] font-bold uppercase leading-none text-pink-200/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_12px_-6px_rgba(236,72,153,0.9)]">
                Soon
              </span>
            </button>
            <button
              type="button"
              disabled
              className="group flex cursor-not-allowed items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-[#c5b593]/85"
            >
              Subscriptions
              <span className="rounded-full border border-pink-300/30 bg-pink-500/15 px-2 py-0.5 text-[9px] font-bold uppercase leading-none text-pink-200/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_12px_-6px_rgba(236,72,153,0.9)]">
                Soon
              </span>
            </button>
          </div>
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <Link
            href="/create"
            className={`hidden items-center gap-2 rounded-full bg-[linear-gradient(180deg,#ffd84a_0%,#f2b90f_48%,#d88a05_100%)] px-5 py-2.5 text-[15px] font-semibold text-[#3a2100] shadow-[inset_0_1px_0_rgba(255,255,218,0.7),0_4px_14px_-8px_rgba(180,108,0,0.9)] transition-all hover:brightness-110 sm:flex ${
              pathname === "/create" ? "ring-2 ring-amber-300/50" : ""
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
                  {myProfileHref && <Link href={myProfileHref} aria-label="My profile" className="hidden items-center justify-center rounded-full px-2 py-2 text-neutral-300 hover:bg-white/10 sm:flex"><User className="h-6 w-6" /></Link>}
                          <button type="button" onClick={() => disconnect()} aria-label="Disconnect" className="inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium text-neutral-300 hover:bg-white/10 hover:text-red-400"><LogOut className="h-4 w-4" /></button>
                </div>
              );
            }}
          </ConnectButton.Custom>
        </div>
      </div>
    </header>
  );
}

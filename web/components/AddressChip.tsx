"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { addressUrl } from "@/lib/config";
import { shortAddress } from "@/lib/format";

/** Shortened mono address with copy-to-clipboard (2s ✓) and explorer link. */
export function AddressChip({
  address,
  chainId,
  className = "",
}: {
  address: string;
  chainId?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const explorer = chainId !== undefined ? addressUrl(chainId, address) : undefined;

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable (e.g. insecure context) — ignore
    }
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-white/80 bg-white/70 px-2.5 py-1 font-mono text-xs text-neutral-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_4px_12px_-10px_rgba(15,23,42,0.45)] backdrop-blur-md ${className}`}
    >
      <span>{shortAddress(address)}</span>
      <button
        type="button"
        onClick={copy}
        className="text-neutral-400 transition-colors hover:text-neutral-900"
        title="Copy address"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer"
          className="text-neutral-400 transition-colors hover:text-neutral-900"
          title="View on explorer"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </span>
  );
}

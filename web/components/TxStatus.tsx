"use client";

import { txUrl } from "@/lib/config";
import type { TxState } from "@/lib/hooks";

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "shortMessage" in error) {
    return String((error as { shortMessage: unknown }).shortMessage);
  }
  if (error instanceof Error) return error.message;
  return "Transaction failed";
}

/** Inline transaction lifecycle indicator for a useTx() flow. */
export function TxStatus({
  tx,
  chainId,
  successLabel = "Transaction confirmed",
  successTone = "green",
}: {
  tx: TxState;
  chainId: number;
  successLabel?: string;
  successTone?: "green" | "gold";
}) {
  const { hash, isPending, isConfirming, confirmed, reverted, error } = tx;
  if (!isPending && !isConfirming && !confirmed && !reverted && !error) return null;
  if (isPending) return null;

  const link = hash ? txUrl(chainId, hash) : undefined;

  let body: React.ReactNode = null;
  let tone = "border-neutral-800 bg-neutral-900 text-neutral-300";

  if (isConfirming) {
    body = "Transaction submitted, waiting for confirmation…";
  } else if (reverted) {
    tone = "border-red-500/30 bg-red-500/10 text-red-400";
    body = "Transaction reverted on-chain.";
  } else if (confirmed) {
    tone = successTone === "gold"
      ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
      : "border-green-500/30 bg-green-500/10 text-green-400";
    body = successLabel;
  } else if (error) {
    tone = "border-red-500/30 bg-red-500/10 text-red-400";
    body = errorMessage(error);
  }

  return (
    <div className={`mt-3 break-words rounded-lg border px-3 py-2 text-xs ${tone}`}>
      {body}
      {link && (
        <>
          {" "}
          <a href={link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            View on explorer
          </a>
        </>
      )}
    </div>
  );
}

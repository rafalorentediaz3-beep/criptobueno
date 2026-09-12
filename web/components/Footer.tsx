import Link from "next/link";
import { PROOF_OF_POTATO_URL } from "@/lib/config";

export function Footer() {
  return (
    <footer className="border-t border-white/5">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 px-4 py-8 text-xs text-neutral-500 sm:flex-row sm:justify-between sm:px-6">
        <nav className="flex items-center gap-5 text-neutral-500">
          <Link href="/analytics" className="transition-colors hover:text-neutral-200">
            Analytics
          </Link>
          <Link href="/privacy" className="transition-colors hover:text-neutral-200">
            Privacy
          </Link>
          <Link href="/terms" className="transition-colors hover:text-neutral-200">
            Terms
          </Link>
        </nav>

        {/* Attribution required by the project license — keep this credit visible. */}
        <div className="flex items-center gap-4">
          <a
            href="https://x.com/onchainscam"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Follow on X"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-white/10 text-neutral-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_10px_24px_-16px_rgba(255,255,255,0.45),0_8px_18px_-12px_rgba(0,0,0,0.8)] backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.16] hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <a
            href={PROOF_OF_POTATO_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-amber-500/80 transition-colors hover:text-amber-400"
          >
            
          </a>
        </div>
      </div>
    </footer>
  );
}


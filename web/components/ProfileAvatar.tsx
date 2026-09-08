"use client";

import { useMemo, useState } from "react";
import { imageProxyCandidates } from "@/lib/format";

const SIZES = {
  sm: { box: "h-8 w-8" },
  md: { box: "h-12 w-12" },
  lg: { box: "h-20 w-20" },
} as const;

/**
 * Profile picture. Falls back to a default avatar image; a claimed avatar is
 * an IPFS URI rendered through the same-origin /api/img cache, and only fades in
 * once loaded so a slow gateway never shows a black circle.
 */
export function ProfileAvatar({
  address,
  avatarUrl,
  size = "md",
  className = "",
}: {
  address: string;
  avatarUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const candidates = useMemo(() => imageProxyCandidates(avatarUrl), [avatarUrl]);
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = idx < candidates.length ? candidates[idx] : undefined;

  const { box } = SIZES[size];

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 shadow-[0_8px_20px_-12px_rgba(0,0,0,0.7)] ${box} ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/wallet-avatar.png" alt="" className="absolute inset-0 h-full w-full object-cover" />
      {src && (
        <>
          {loaded && <div className="absolute inset-0 bg-black" />}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={src}
            src={src}
            alt=""
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
              loaded ? "opacity-100" : "opacity-0"
            }`}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
            onError={() => {
              setLoaded(false);
              setIdx((i) => i + 1);
            }}
          />
        </>
      )}
    </div>
  );
}

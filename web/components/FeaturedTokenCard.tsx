"use client";

import { Check, Copy, Globe, Send } from "lucide-react";
import Link from "next/link";
import { memo, useEffect, useRef, useState } from "react";
import { SOCIAL_OVERRIDES } from "@/lib/config";
import { formatUsd, normalizeSocialUrl } from "@/lib/format";
import { useTokenDescription } from "@/lib/tokenMeta/useTokenDescription";
import { TokenAvatar } from "./TokenAvatar";
import type { TokenRow } from "./TokenCard";
import styles from "./TokenCarousel.module.css";

export const FeaturedTokenCard = memo(function FeaturedTokenCard({ row }: { row: TokenRow }) {
  const description = useTokenDescription(row.address);
  const [copyState, setCopyState] = useState("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const override = SOCIAL_OVERRIDES[row.address.toLowerCase()];
  const socials = [
    { href: normalizeSocialUrl(override?.website ?? row.website, "website"), label: "Website", icon: <Globe size={16} /> },
    { href: normalizeSocialUrl(override?.twitter ?? row.twitter, "twitter"), label: "X", icon: <span className={styles.xIcon}>&#120143;</span> },
    { href: normalizeSocialUrl(override?.telegram ?? row.telegram, "telegram"), label: "Telegram", icon: <Send size={15} /> },
  ].filter((social) => social.href);
  const marketCap = row.marketCapUsd != null && row.marketCapUsd > 0
    ? formatUsd(row.marketCapUsd)
    : row.marketCapEth != null && row.marketCapEth > 0
      ? `${row.marketCapEth.toLocaleString("en-US", { maximumFractionDigits: 2 })} ETH`
      : "--";

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(row.address);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <article className={styles.card}>
      <Link href={`/token/${row.address}`} className={styles.cardLink} aria-label={`Open ${row.name || row.symbol}`} draggable={false} />
      <div className={styles.cardContent}>
        <div className={styles.cardTop}>
          <div className={styles.socials}>
            {socials.map((social) => <a key={social.label} href={social.href} target="_blank" rel="noopener noreferrer" className={styles.social} title={social.label} aria-label={`${row.symbol} ${social.label}`}>{social.icon}</a>)}
          </div>
          <div className={styles.metric}><span>Vol</span><strong>{row.volume24Usd != null ? formatUsd(row.volume24Usd) : "--"}</strong></div>
        </div>
        <div className={styles.identity}>
          <div className={styles.avatar}><TokenAvatar address={row.address} symbol={row.symbol} imageURI={row.imageURI} fill /></div>
          <h3 title={row.symbol}>{row.symbol || row.name}</h3>
          <button type="button" className={styles.copyName} onClick={copyAddress} title={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : `Copy address: ${row.address}`} aria-label={copyState === "copied" ? "Address copied" : `Copy ${row.name} address`}>
            <span>{row.name}</span>{copyState === "copied" ? <Check size={13} /> : <Copy size={13} />}
          </button>
          {description && <p className={styles.description} title={description}>{description}</p>}
          <span className="sr-only" aria-live="polite">{copyState === "copied" ? "Address copied" : copyState === "failed" ? "Could not copy address" : ""}</span>
        </div>
        <div className={`${styles.metric} ${styles.marketCap}`}><span>MC</span><strong>{marketCap}</strong></div>
      </div>
    </article>
  );
});

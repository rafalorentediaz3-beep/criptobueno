import type { Metadata } from "next";
import { isAddress, getAddress } from "viem";
import { shortAddress } from "@/lib/format";
import { CreatorPageClient } from "./CreatorPageClient";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address: raw } = await params;
  if (!isAddress(raw)) {
    return { title: "Creator" };
  }
  const address = getAddress(raw);
  const label = shortAddress(address);
  return {
    title: `Creator ${label}`,
    description: `Coins created by ${label}. Existence metrics from on-chain TokenCreated events — not volume or holdings.`,
    openGraph: {
      title: `Creator ${label}`,
      description: `Creator profile for ${label}.`,
    },
  };
}

export default async function CreatorPage({ params }: Props) {
  const { address } = await params;
  return <CreatorPageClient address={address} />;
}

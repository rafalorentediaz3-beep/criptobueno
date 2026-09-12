import type { Metadata } from "next";
import TokenPageClient from "./TokenPageClient";

// Metadata must never hold up an in-app navigation. The dynamic social image has
// its own route and can resolve richer token data when a crawler requests it.
export const metadata: Metadata = {
  title: "Token",
  description: "Trade a PotatoPad token on Robinhood Chain.",
  openGraph: {
    title: "Token",
    description: "Trade a PotatoPad token on Robinhood Chain.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Token",
    description: "Trade a PotatoPad token on Robinhood Chain.",
  },
};

export default function TokenPage() {
  return <TokenPageClient />;
}

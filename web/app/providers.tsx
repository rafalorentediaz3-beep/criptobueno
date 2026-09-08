"use client";

import "@rainbow-me/rainbowkit/styles.css";

import { RainbowKitProvider, darkTheme, type AvatarComponent } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { User } from "lucide-react";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

const GenericAvatar: AvatarComponent = ({ size }) => (
  <div
    className="flex items-center justify-center rounded-full border border-white/15 bg-white/10 backdrop-blur-md"
    style={{ width: size, height: size }}
  >
    <User className="text-neutral-200" style={{ width: size * 0.55, height: size * 0.55 }} />
  </div>
);

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, staleTime: 5_000 },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          avatar={GenericAvatar}
          theme={darkTheme({
            accentColor: "#f59e0b",
            accentColorForeground: "#171717",
            borderRadius: "medium",
            overlayBlur: "small",
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

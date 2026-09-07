import { requireSupabase } from "@/lib/supabase";

export interface TokenPairing {
  token: string;
  creator: string;
  symbol: string;
  name: string;
  imageUrl: string;
}

export async function getTokenPairings(tokens: string[]): Promise<Record<string, TokenPairing>> {
  const keys = [...new Set(tokens.map((token) => token.toLowerCase()).filter((token) => /^0x[0-9a-f]{40}$/.test(token)))];
  if (keys.length === 0) return {};
  const { data, error } = await requireSupabase()
    .from("token_pairings")
    .select("token_address, creator_address, stock_symbol, stock_name, stock_image_url")
    .in("token_address", keys);
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((row) => [
    row.token_address,
    {
      token: row.token_address,
      creator: row.creator_address,
      symbol: row.stock_symbol,
      name: row.stock_name,
      imageUrl: row.stock_image_url,
    },
  ]));
}

export async function saveTokenPairing(input: TokenPairing) {
  const { error } = await requireSupabase().from("token_pairings").upsert(
    {
      token_address: input.token.toLowerCase(),
      creator_address: input.creator.toLowerCase(),
      stock_symbol: input.symbol.toUpperCase(),
      stock_name: input.name,
      stock_image_url: input.imageUrl,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "token_address" },
  );
  if (error) return { ok: false as const, status: 500, error: error.message };
  return { ok: true as const, value: input };
}

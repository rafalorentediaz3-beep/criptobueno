const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SMALL = "₀₁₂₃₄₅₆₇₈₉";

export function axiomNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  const expanded = value.trim().replace(/0[.,]0([₀-₉]+)\s*(\d+)/g, (_, count, digits) => {
    const zeros = Number([...count].map((digit) => SMALL.indexOf(digit)).join(""));
    return zeros > 0 && zeros <= 20 ? "0." + "0".repeat(zeros) + digits : "invalid";
  });
  if (!/^[+\-]?[\d.,]+$/.test(expanded)) return NaN;
  const normalized = expanded.lastIndexOf(",") > expanded.lastIndexOf(".")
    ? expanded.replace(/\./g, "").replace(",", ".")
    : expanded.replace(/,/g, "");
  return Number(normalized);
}

function taxRange(value, unit) {
  if (typeof value === "string" && value.includes("%")) {
    const match = value.replace(/,/g, ".").match(/%?\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*%?/);
    if (!match) return null;
    const min = Number(match[1]);
    const max = Number(match[2] ?? match[1]);
    return min >= 0 && max <= 100 ? [Math.min(min, max), Math.max(min, max)] : null;
  }
  if (!unit) return null;
  const numeric = axiomNumber(value);
  const pct = unit === "bps" ? numeric / 100 : numeric;
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? [pct, pct] : null;
}

export function extractAxiomObservations(root) {
  const observations = [];
  const visited = new Set();
  let remaining = 50_000;
  const walk = (value, inherited = {}, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 16 || visited.has(value) || remaining-- <= 0) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) walk(child, inherited, depth + 1);
      return;
    }
    const entries = Object.entries(value);
    const mintKeys = ["tokenAddress", "token_address", "mintAddress", "tokenMint", "baseMint", "mint", "contractAddress", "contract_address", "address"];
    const explicitMint = mintKeys.map((key) => value[key]).find((candidate) => typeof candidate === "string" && MINT.test(candidate));
    const mint = explicitMint ?? inherited.mint;
    const sameToken = !explicitMint || explicitMint === inherited.mint;
    const name = value.tokenName ?? value.name ?? value.symbol ?? (sameToken ? inherited.name : "Token");
    const ranges = [];
    for (const [key, child] of entries) {
      if (!/^(?:tax|taxRate|tokenTax|buyTax|sellTax)(?:Pct|Percent|Bps)?$/i.test(key)) continue;
      const unit = /bps$/i.test(key) ? "bps" : /pct|percent/i.test(key) ? "pct" : null;
      const range = taxRange(child, unit);
      if (range) ranges.push(range);
    }
    const tax = ranges.length
      ? [Math.min(...ranges.map((range) => range[0])), Math.max(...ranges.map((range) => range[1]))]
      : sameToken ? inherited.tax : null;
    for (const [key, child] of entries) {
      if (/^(?:total)?global_?fees?_?paid(?:sol|lamports)?$/i.test(key)) {
        const raw = child && typeof child === "object" ? child.sol ?? child.value ?? child.amount : child;
        const amount = axiomNumber(raw) / (/lamports$/i.test(key) ? 1e9 : 1);
        if (mint && Number.isFinite(amount) && amount >= 0 && amount < 1_000_000) {
          observations.push({
            mint, name: String(name || "Token").slice(0, 100),
            symbol: String(value.symbol || "").slice(0, 32),
            globalFeesPaidSol: amount,
            ...(tax ? { taxRatePctMin: tax[0], taxRatePctMax: tax[1] } : {}),
            source: "axiom-session-data",
          });
        }
      } else if (child && typeof child === "object") {
        walk(child, { mint, name, tax }, depth + 1);
      }
    }
  };
  walk(root);
  return observations;
}

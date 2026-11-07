(() => {
  if (window.__moneyPolyAxiomReaderInstalled || location.hostname !== "axiom.trade") return;
  window.__moneyPolyAxiomReaderInstalled = true;
  const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const SMALL = "₀₁₂₃₄₅₆₇₈₉";
  const lastSent = new Map();
  let scheduled;

  function number(value) {
    const text = String(value).trim().replace(/0[.,]0([₀-₉]+)\s*(\d+)/g, (_, count, significant) => {
      const zeros = Number([...count].map((digit) => SMALL.indexOf(digit)).join(""));
      return zeros > 0 && zeros <= 20 ? "0." + "0".repeat(zeros) + significant : "invalid";
    });
    if (!/^[+\-]?[\d.,]+$/.test(text)) return NaN;
    return Number(text.lastIndexOf(",") > text.lastIndexOf(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, ""));
  }

  function formattedText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.tagName === "SUB") return node.textContent.replace(/\d/g, (digit) => SMALL[Number(digit)]);
    return [...node.childNodes].map(formattedText).join("");
  }

  function mintFromUrl(value) {
    try {
      const url = new URL(value, location.href);
      for (const key of ["mint", "contract", "tokenAddress", "ca"]) {
        const candidate = url.searchParams.get(key);
        if (candidate && MINT.test(candidate)) return candidate;
      }
      const match = url.hostname === "solscan.io" ? url.pathname.match(/^\/token\/([^/]+)/)
        : /^(www\.)?axiom\.trade$/.test(url.hostname) ? url.pathname.match(/^\/t\/([^/]+)/) : null;
      return match && MINT.test(match[1]) ? match[1] : null;
    } catch { return null; }
  }

  function mintFromScope(scope) {
    for (const node of scope.querySelectorAll("[data-mint], [data-token-address]")) {
      const mint = node.dataset.mint || node.dataset.tokenAddress;
      if (MINT.test(mint)) return mint;
    }
    for (const link of scope.querySelectorAll("a[href]")) {
      const mint = mintFromUrl(link.href);
      if (mint) return mint;
    }
    return mintFromUrl(location.href);
  }

  function taxFromScope(scope) {
    for (let depth = 0; scope && depth < 6; scope = scope.parentElement, depth++) {
      const candidates = [...scope.querySelectorAll("*")].filter((node) => node.children.length <= 1)
        .map((node) => ({ text: node.textContent.replace(/\s+/g, " ").trim(), title: node.getAttribute("title") || "" }))
        .filter(({ text }) => text.length > 0 && text.length <= 40 && text.includes("%"));
      const candidate = candidates.find(({ title }) => /tax/i.test(title))
        ?? candidates.find(({ text }) => /^%\s*\d/.test(text) || /\d\s*-\s*\d.*%/.test(text));
      if (!candidate) continue;
      const match = candidate.text.replace(/,/g, ".").match(/%?\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*%?/);
      if (!match) continue;
      const first = Number(match[1]), second = Number(match[2] ?? match[1]);
      if (Math.min(first, second) >= 0 && Math.max(first, second) <= 100) return [Math.min(first, second), Math.max(first, second)];
    }
    return null;
  }

  function scan() {
    if (typeof globalThis.__moneyPolyAxiomObservation !== "function") return;
    const labels = [...document.querySelectorAll("span,div,p,label")].filter((node) =>
      node.children.length <= 1 && node.textContent.trim().toLowerCase() === "global fees paid");
    for (const label of labels) {
      for (let scope = label, depth = 0; scope && depth < 8; scope = scope.parentElement, depth++) {
        const match = formattedText(scope).replace(/\s+/g, " ").match(/global fees paid\s*[:：]?\s*([\d][\d.,]*(?:\s*[₀-₉]+\s*\d+)?)/i);
        if (!match) continue;
        const fees = number(match[1]);
        const mint = mintFromScope(scope);
        if (!mint || !Number.isFinite(fees) || fees < 0) continue;
        const tax = taxFromScope(scope);
        const fingerprint = `${fees}|${tax?.join("|") ?? "?"}`;
        const previous = lastSent.get(mint);
        if (!previous || previous.fingerprint !== fingerprint || Date.now() - previous.at >= 30_000) {
          lastSent.set(mint, { fingerprint, at: Date.now() });
          globalThis.__moneyPolyAxiomObservation(JSON.stringify({
            mint, name: scope.querySelector("h1,h2,[role=heading]")?.textContent?.trim().slice(0, 100),
            globalFeesPaidSol: fees,
            ...(tax ? { taxRatePctMin: tax[0], taxRatePctMax: tax[1] } : {}),
            source: "axiom-dom",
          }));
        }
        break;
      }
    }
  }

  new MutationObserver(() => { clearTimeout(scheduled); scheduled = setTimeout(scan, 300); })
    .observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  setInterval(scan, 5_000);
  scan();
})();

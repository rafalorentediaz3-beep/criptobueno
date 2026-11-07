(async () => {
  // Import the exact modules already loaded by this tab, including its deployment
  // query. Importing a different build can create a different, empty Jotai store.
  const resources = performance.getEntriesByType("resource").map((resource) => resource.name);
  const loaded = (stem) => resources.find((url) => url.includes(`/assets/${stem}`) && new URL(url).pathname.endsWith(".js"));
  const urls = {
    app: loaded("boot-app-"), vendor: loaded("boot-vendor-"),
    fees: loaded("platform-public-c27235a4-"), settings: loaded("platform-public-1effc347-"),
  };
  if (Object.values(urls).some((url) => !url)) return { ready: false, reason: "Esperando a que Axiom cargue sus módulos de Pulse." };
  const [app, vendor, fees, settings] = await Promise.all([
    import(urls.app), import(urls.vendor), import(urls.fees), import(urls.settings),
  ]);
  let defaultStore = vendor.Wp, rowAtom = app.Dx, lists = app.Sx;
  if (typeof defaultStore !== "function" || typeof rowAtom !== "function" || !lists?.sol?.migrated) {
    const rowUrl = resources.find((url) => url.includes("/SolUnifiedPulseRow-") && new URL(url).pathname.endsWith(".js"));
    const rowSource = rowUrl ? await (await fetch(rowUrl, { cache: "force-cache" })).text() : "";
    const store = rowSource.match(/([\w$]+)=([\w$]+)\(\);function [\w$]+\([^)]*\)\{return ([\w$]+)\([`'"]sol[`'"]/);
    const list = rowSource.match(/\.get\(([\w$]+)\.sol\[/);
    const imported = new Map();
    for (const entry of rowSource.matchAll(/import\{([^}]+)\}from["']([^"']+)["']/g)) {
      for (const binding of entry[1].split(",")) {
        const parts = binding.trim().split(/\s+as\s+/);
        imported.set(parts[1] || parts[0], { name: parts[0], source: entry[2] });
      }
    }
    const factory = imported.get(store?.[2]), atom = imported.get(store?.[3]), table = imported.get(list?.[1]);
    if (factory && /boot-vendor-/.test(factory.source)) defaultStore = vendor[factory.name];
    if (atom && /boot-app-/.test(atom.source)) rowAtom = app[atom.name];
    if (table && /boot-app-/.test(table.source)) lists = app[table.name];
  }
  if (typeof defaultStore !== "function" || typeof rowAtom !== "function" || !lists?.sol?.migrated
      || ["q", "i", "a", "Q", "R", "o", "d"].some((key) => typeof fees[key] !== "function")) {
    return { ready: false, reason: "Axiom ha cambiado la interfaz de Pulse; no se pueden validar sus campos." };
  }
  const store = defaultStore();
  const workerWindow = globalThis.__moneyPolyWorkerWindow === true || new URL(location.href).searchParams.get("moneypolyReader") === "1";
  let backgroundKeepAlive = false;
  if (workerWindow) {
    const marketUrl = loaded("platform-public-78d9f6c0-");
    const market = marketUrl ? await import(marketUrl) : null;
    const managerType = market && Object.values(market).find((value) => typeof value === "function" && typeof value.getInstance === "function"
      && typeof value.prototype?.facadeFor === "function" && typeof value.prototype?.runningChains === "function");
    const manager = managerType?.getInstance();
    const client = manager?.facadeFor?.("sol");
    if (!client || typeof client.setKeepAliveWhileHidden !== "function") {
      return { ready: false, reason: "Esperando a que Axiom prepare la conexión de Pulse en segundo plano." };
    }
    // This is Axiom's own background subscription API; visibility, authentication,
    // browser properties, and security challenges are left unchanged.
    client.setKeepAliveWhileHidden(true);
    client.setPageActive(true);
    client.setSoundEventsActive(false);
    backgroundKeepAlive = true;
  }
  let selectedFees;
  try { selectedFees = store.get(settings.ck); } catch {}
  if (!selectedFees || !["protocol", "pool", "creator", "rewards", "stock"].every((key) => typeof selectedFees[key] === "boolean")) {
    return { ready: false, reason: "No se puede validar la configuración de tax de Axiom. Esperando datos compatibles." };
  }
  const diagnostics = { chain: "sol", stage: "migrated", protocol: "Meteora AMM V2", migratedLoaded: 0, meteoraLoaded: 0, taxPending: 0, backgroundKeepAlive };
  const pairs = store.get(lists.sol.migrated);
  if (!Array.isArray(pairs)) return { ready: false, reason: "La lista Migrated de Axiom aún no está disponible." };
  diagnostics.migratedLoaded = pairs.length;
  let hash = 2166136261;
  for (const pair of pairs) {
    const item = store.get(rowAtom("sol", "migrated", pair));
    for (const char of `${pair}:${item?.feesSol}:${item?.volumeSol}:${item?.numTxns}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  diagnostics.dataFingerprint = (hash >>> 0).toString(16);
  const rows = [];
  const clock = app.ght && typeof app.ght.read === "function" ? store.get(app.ght) : null;
  const now = typeof clock === "number" && clock > 1e12 ? clock : Date.now();
  for (const pair of pairs) {
    const row = store.get(rowAtom("sol", "migrated", pair));
    if (!row || row.protocol !== "Meteora AMM V2") continue;
    diagnostics.meteoraLoaded++;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.tokenAddress)
        || typeof row.feesSol !== "number" || !Number.isFinite(row.feesSol) || row.feesSol < 0) continue;
    const observation = {
      mint: row.tokenAddress, name: row.tokenName || row.tokenTicker || "Token", symbol: row.tokenTicker || "",
      pairAddress: row.pairAddress, chain: "sol", stage: "migrated", protocol: row.protocol,
      // SolUnifiedPulseRow renders this exact field as "Global Fees Paid".
      globalFeesPaidSol: row.feesSol, source: "axiom-pulse-state",
    };
    try {
      // These are the same pure functions used by Axiom's Pulse tax hook.
      // Do not guess a conversion tax when the quote route has not loaded.
      const transferBps = fees.Q(row.protocolDetails);
      const base = fees.q(row, now, undefined, undefined, row.marketCapSol);
      const conversion = fees.i(row.protocolDetails, undefined, now, fees.p, undefined, {
        pairAddress: row.pairAddress, tokenAddress: row.tokenAddress, protocol: row.protocol, marketCapSol: row.marketCapSol,
      });
      if (conversion?.pending) throw new Error("Tax de conversión pendiente");
      const info = fees.a({
        protocol: row.protocol, protocolDetails: row.protocolDetails, extra: undefined,
        marketCapSol: row.marketCapSol, transferFeeBps: transferBps, memeTaxPct: base, conversion, now,
      });
      const range = fees.o(fees.R(row, now), info);
      const displayed = fees.d(info, base, transferBps / 100, range, selectedFees);
      const min = displayed.taxPercentage;
      const max = displayed.dynamicFeeRangeMax ?? min;
      if (![min, max].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)) {
        throw new Error("Axiom no ha devuelto un tax válido");
      }
      observation.taxRatePctMin = Math.min(min, max);
      observation.taxRatePctMax = Math.max(min, max);
      observation.taxSource = "axiom-frontend";
    } catch {
      observation.taxPending = true;
      diagnostics.taxPending++;
    }
    rows.push(observation);
  }
  return { ready: true, rows, diagnostics };
})()

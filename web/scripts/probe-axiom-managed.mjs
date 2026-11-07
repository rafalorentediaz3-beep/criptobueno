import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { browserEndpoint, CdpConnection } from "./axiom-cdp.mjs";

if (!process.argv.includes("--use-axiom-session")) {
  console.error("Esta prueba requiere autorización explícita del usuario y --use-axiom-session.");
  process.exit(1);
}

// Explicitly authorized diagnostic. Axiom access cookie stays in process memory
// and a disposable incognito context; it is never logged or written to disk.
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const headful = process.argv.includes("--headful");
const tempRoot = await realpath(tmpdir());
let profile, source, managed, contextId, accessCookie;
try {
  source = await CdpConnection.connect(await browserEndpoint(process.env.AXIOM_CHROME_USER_DATA || join(process.env.LOCALAPPDATA, "Google/Chrome/User Data"), true), 120_000);
  const tab = (await source.call("Target.getTargets")).targetInfos.find((tab) => tab.type === "page" && /^https:\/\/axiom\.trade\/pulse/.test(tab.url));
  if (!tab) throw new Error("No se ha encontrado la sesión de Pulse.");
  const original = await source.call("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
  const { cookies } = await source.call("Network.getCookies", { urls: ["https://axiom.trade/", "https://api.axiom.trade/"] }, original.sessionId);
  accessCookie = cookies.find((cookie) => cookie.name === "auth-access-token");
  if (!accessCookie) throw new Error("No hay una sesión de acceso de Axiom disponible.");
  source.close(); source = null;
  console.log(JSON.stringify({ stage: "session_in_memory" }));

  profile = await mkdtemp(join(tempRoot, "moneypoly-axiom-managed-probe-"));
  const child = spawn(join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"), [
    ...(headful ? ["--start-minimized"] : ["--headless"]), `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disk-cache-size=8388608", "about:blank",
  ], { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise((done, fail) => { child.once("spawn", done); child.once("error", fail); });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    try { managed = await CdpConnection.connect(await browserEndpoint(profile)); break; } catch {}
    await delay(250);
  }
  if (!managed) throw new Error("El navegador de prueba no respondió.");
  ({ browserContextId: contextId } = await managed.call("Target.createBrowserContext", { disposeOnDetach: true }));
  const cookie = { name: accessCookie.name, value: accessCookie.value, domain: accessCookie.domain, path: accessCookie.path,
    secure: accessCookie.secure, httpOnly: accessCookie.httpOnly, ...(accessCookie.sameSite ? { sameSite: accessCookie.sameSite } : {}) };
  await managed.call("Storage.setCookies", { browserContextId: contextId, cookies: [cookie] });
  accessCookie = undefined; cookie.value = "";
  const { targetId } = await managed.call("Target.createTarget", { url: "about:blank", browserContextId: contextId });
  const { sessionId } = await managed.call("Target.attachToTarget", { targetId, flatten: true });
  await managed.call("Page.enable", {}, sessionId);
  await managed.call("Page.navigate", { url: "https://axiom.trade/pulse?chains=sol&pulseChains=sol" }, sessionId);
  await delay(20_000);
  const result = await managed.call("Runtime.evaluate", {
    expression: `(() => { const text = document.body?.innerText || ''; return {
      title: document.title, path: location.pathname,
      challenge: /Un momento|Just a moment|Verificación de seguridad|Verify you are human/.test(document.title + ' ' + text),
      login: /The Gateway to DeFi|Start Trading/.test(text) && /Login|Sign up/.test(text),
      pulse: /New Pairs|Final Stretch|Migrated/.test(text)
    }; })()`, returnByValue: true,
  }, sessionId);
  const state = result.result?.value;
  console.log(JSON.stringify({ managedBrowser: true, headful, incognito: true, state }));
  if (state?.pulse && !state.challenge && !state.login) {
    const data = await managed.call("Runtime.evaluate", {
      expression: await readFile(new URL("../axiom-capture/pulse-reader.js", import.meta.url), "utf8"), awaitPromise: true, returnByValue: true,
    }, sessionId);
    console.log(JSON.stringify({ ready: data.result?.value?.ready, diagnostics: data.result?.value?.diagnostics, rows: data.result?.value?.rows?.length }));
  } else process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  accessCookie = undefined;
  source?.close();
  if (managed) {
    if (contextId) await managed.call("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => {});
    await managed.call("Browser.close").catch(() => {});
    managed.close();
    await delay(1_000);
  }
  if (profile) {
    const target = resolve(await realpath(profile));
    if (dirname(target).toLowerCase() !== tempRoot.toLowerCase() || !basename(target).startsWith("moneypoly-axiom-managed-probe-")) {
      throw new Error("La carpeta temporal no está dentro del destino esperado.");
    }
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }).catch(() => {});
  }
}

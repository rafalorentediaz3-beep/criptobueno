import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserEndpoint, CdpConnection } from "./axiom-cdp.mjs";

const PULSE_URL = "https://axiom.trade/pulse?chains=sol&pulseChains=sol&moneypolyReader=1";
const PROFILE = process.env.AXIOM_CHROME_USER_DATA || join(process.env.LOCALAPPDATA || "", "Google/Chrome/User Data");
const WINDOW_FILE = new URL("../data/reader-window.json", import.meta.url);
const isAxiom = (url) => /^https:\/\/(www\.)?axiom\.trade\//.test(url);

export class AxiomReader {
  constructor(onObservation) {
    this.onObservation = onObservation;
    this.lastSent = new Map();
    this.pending = new Set();
    this.status = { state: "starting", message: "Conectando el lector en segundo plano…", observations: 0,
      lastObservationAt: null, connectionsOpened: 0, pollIntervalMs: 5_000, backgroundWindow: false };
    this.timer = setInterval(() => this.tick().catch((error) => { this.status.lastError = error.message; }), 5_000);
  }

  getStatus() { return { ...this.status }; }

  async tick() {
    if (this.stopped || this.starting) return;
    if (this.sessionId && this.connection?.socket.readyState === WebSocket.OPEN) return this.checkPage();
    if (this.status.state === "needs_browser_permission" || this.connection?.socket.readyState === WebSocket.OPEN) {
      return this.start(false);
    }
    // A closed browser requires Chrome's own approval for the new connection.
    // Do not repeatedly open permission requests every time this timer runs.
  }

  async start(show = false) {
    if (this.starting) return this.starting;
    this.stopped = false;
    if (this.sessionId && this.connection?.socket.readyState === WebSocket.OPEN) {
      if (show) {
        this.manualVisible = true;
        await this.setBackground(false);
        await this.connection.call("Target.activateTarget", { targetId: this.targetId });
      }
      return;
    }
    this.starting = this.connect(show).finally(() => { this.starting = null; });
    return this.starting;
  }

  async connect(show) {
    try {
      let connection = this.connection;
      if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
        let endpoint;
        try { endpoint = await browserEndpoint(PROFILE, true); }
        catch {
          this.status.state = "needs_browser_permission";
          this.status.message = "Abre Chrome, activa Depuración remota y autoriza la conexión inicial del lector.";
          if (show) {
            const executable = process.env.AXIOM_CHROME_PATH || join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe");
            const child = spawn(executable, ["chrome://inspect/#remote-debugging"], { detached: true, stdio: "ignore", windowsHide: false });
            child.on("error", (error) => { this.status.lastError = error.message; });
            child.unref();
          }
          return;
        }
        this.status.state = "awaiting_browser_permission";
        this.status.message = "Acepta Permitir en Chrome para esta conexión. El lector la conservará al reiniciar la web.";
        connection = await CdpConnection.connect(endpoint, 120_000);
        this.connection = connection;
        this.status.connectionsOpened++;
        connection.on("close", () => {
          if (this.connection !== connection) return;
          this.connection = null;
          this.sessionId = null;
          this.targetId = null;
          this.windowId = null;
          this.status.state = "disconnected";
          this.status.backgroundWindow = false;
          this.status.message = "Chrome se ha cerrado por completo. Pulsa Conectar y acepta su permiso para reanudar.";
        });
        connection.on("Target.detachedFromTarget", (event) => {
          if (event.sessionId !== this.sessionId) return;
          this.sessionId = null;
          this.status.state = "recovering_tab";
          this.status.message = "Reabriendo la pestaña del lector con la misma conexión…";
        });
      }
      const pages = (await connection.call("Target.getTargets")).targetInfos;
      let saved;
      try { saved = JSON.parse(await readFile(WINDOW_FILE, "utf8")); } catch {}
      let target = pages.find((page) => page.type === "page" && page.targetId === saved?.targetId && (isAxiom(page.url) || page.url === "about:blank"))
        ?? pages.find((page) => page.type === "page" && isAxiom(page.url) && page.url.includes("moneypolyReader=1"));
      if (!target) {
        const signedIn = pages.find((page) => page.type === "page" && isAxiom(page.url));
        const created = await connection.call("Target.createTarget", { url: "about:blank", newWindow: true,
          ...(signedIn?.browserContextId ? { browserContextId: signedIn.browserContextId } : {}) });
        target = { targetId: created.targetId, url: "about:blank" };
      }
      this.targetId = target.targetId;
      const { windowId } = await connection.call("Browser.getWindowForTarget", { targetId: target.targetId });
      this.windowId = windowId;
      await mkdir(new URL("../data/", import.meta.url), { recursive: true });
      await writeFile(WINDOW_FILE, JSON.stringify({ targetId: target.targetId, windowId }), "utf8");
      const { sessionId } = await connection.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      this.sessionId = sessionId;
      await connection.call("Page.enable", {}, sessionId);
      await connection.call("Runtime.enable", {}, sessionId);
      if (target.url === "about:blank") await connection.call("Page.navigate", { url: PULSE_URL }, sessionId);
      this.status.state = "waiting_data";
      this.status.message = "Preparando la ventana del lector…";
      this.manualVisible = show;
      await this.checkPage();
    } catch (error) {
      this.status.state = "connection_error";
      this.status.message = error.message;
      this.status.lastError = error.message;
      this.sessionId = null;
    }
  }

  async setBackground(hidden = true) {
    if (!this.windowId || this.connection?.socket.readyState !== WebSocket.OPEN) return;
    await this.connection.call("Browser.setWindowBounds", { windowId: this.windowId, bounds: { windowState: hidden ? "minimized" : "normal" } });
    this.minimized = hidden;
    this.manualVisible = !hidden;
    this.status.backgroundWindow = hidden;
  }

  async accept(item) {
    if (item.chain !== "sol" || item.stage !== "migrated" || item.protocol !== "Meteora AMM V2") return;
    const fingerprint = `${item.mint}|${item.globalFeesPaidSol}|${item.taxRatePctMin ?? "?"}|${item.taxRatePctMax ?? "?"}`;
    if (this.pending.has(fingerprint) || Date.now() - (this.lastSent.get(fingerprint) || 0) < 30_000) return;
    this.pending.add(fingerprint);
    try {
      await this.onObservation(item);
      this.lastSent.set(fingerprint, Date.now());
      this.status.lastObservationAt = new Date().toISOString();
      this.status.observations++;
    } catch (error) { this.status.lastError = error.message; }
    finally { this.pending.delete(fingerprint); }
    if (this.lastSent.size > 10_000) for (const [key, at] of this.lastSent) if (Date.now() - at > 60_000) this.lastSent.delete(key);
  }

  async checkPage() {
    if (this.checking || !this.sessionId || this.connection?.socket.readyState !== WebSocket.OPEN) return;
    this.checking = true;
    try {
      const result = await this.connection.call("Runtime.evaluate", {
        expression: `(() => { const text = (document.body?.innerText || '').slice(0,3000); return {
          url: location.origin + location.pathname, visible: document.visibilityState,
          login: /The Gateway to DeFi|Start Trading/.test(text) && /Login|Sign up/.test(text),
          challenge: /Just a moment|Verify you are human|Verifying you are human|Un momento|Verificación de seguridad|Esperando a que axiom/.test(document.title + ' ' + text)
        }; })()`, returnByValue: true,
      }, this.sessionId);
      const page = result.result?.value;
      if (!page) return;
      this.status.pageUrl = page.url;
      this.status.backgroundWindow = page.visible === "hidden";
      this.minimized = page.visible === "hidden";
      if (page.challenge || page.login) {
        this.status.state = page.challenge ? "browser_check" : "awaiting_login";
        this.status.message = page.challenge ? "Axiom pide una verificación. La lectura espera a que Axiom dé acceso." : "Axiom pide iniciar sesión en la ventana del lector.";
        if (this.minimized) await this.setBackground(false);
        return;
      }
      if (!isAxiom(page.url)) return;
      if (!page.url.includes("/pulse")) {
        await this.connection.call("Page.navigate", { url: PULSE_URL }, this.sessionId);
        return;
      }
      const source = await readFile(new URL("../axiom-capture/pulse-reader.js", import.meta.url), "utf8");
      const snapshot = await this.connection.call("Runtime.evaluate", {
        expression: `globalThis.__moneyPolyWorkerWindow = true;\n${source}`, awaitPromise: true, returnByValue: true,
      }, this.sessionId);
      const data = snapshot.result?.value;
      if (snapshot.exceptionDetails || !data?.ready) {
        this.status.state = "waiting_data";
        this.status.message = data?.reason || "Esperando a que Axiom cargue Pulse…";
        if (page.visible === "hidden" && !this.warmedUp) {
          this.warmedUp = true;
          await this.setBackground(false);
          this.manualVisible = false;
        }
        return;
      }
      if (this.status.pulse?.dataFingerprint !== data.diagnostics.dataFingerprint) this.status.lastSourceChangeAt = new Date().toISOString();
      this.status.pulse = data.diagnostics;
      this.status.lastPollAt = new Date().toISOString();
      for (const row of data.rows) await this.accept(row);
      if (data.diagnostics.migratedLoaded > 0) {
        this.status.state = "receiving";
        this.status.message = "Recibiendo datos reales de Axiom en segundo plano.";
        if (!this.manualVisible && !this.minimized) await this.setBackground(true);
      } else {
        this.status.state = "waiting_data";
        this.status.message = "Axiom aún no ha entregado la lista Migrated.";
        if (page.visible === "hidden" && !this.warmedUp) {
          this.warmedUp = true;
          await this.setBackground(false);
          this.manualVisible = false;
        }
      }
    } finally { this.checking = false; }
  }

  stop() { this.stopped = true; clearInterval(this.timer); this.connection?.close(); }
}

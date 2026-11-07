import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildNativeHost } from "./build-axiom-native.mjs";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const WORKSPACE = basename(resolve(fileURLToPath(new URL("../../../", import.meta.url))));
const EXE = resolve(WEB, "data/native/bin/MoneyPolyAxiomHost.exe");
const PROFILE = join(process.env.LOCALAPPDATA || process.env.TEMP, "MoneyPoly", "Axiom", WORKSPACE);
const ADAPTER = resolve(WEB, "axiom-capture/pulse-reader.js");

async function build() {
  try {
    const [binary, source] = await Promise.all([stat(EXE), stat(new URL("MoneyPolyAxiomHost.cs", import.meta.url))]);
    if (binary.mtimeMs >= source.mtimeMs) return;
  } catch {}
  await buildNativeHost();
}

export class NativeAxiomReader {
  constructor(onObservation) {
    this.onObservation = onObservation;
    this.lastSent = new Map();
    this.queue = Promise.resolve();
    this.status = { state: "starting", message: "Preparando el lector independiente de Chrome…", engine: "webview2",
      requiresChrome: false, backgroundWindow: true, connectionsOpened: 0, pollIntervalMs: 5000, observations: 0, lastObservationAt: null };
  }
  getStatus() {
    if (this.status.state === "receiving" && Date.now() - Date.parse(this.status.lastPollAt) > 30_000) {
      return { ...this.status, state: "waiting_data", message: "El lector sigue abierto, pero Axiom no ha entregado una lectura válida reciente." };
    }
    return { ...this.status };
  }

  async start(show = false) {
    if (this.starting) return this.starting;
    if (this.child && this.child.exitCode == null && !this.child.killed) { if (show) this.command("show"); return; }
    this.stopped = false;
    this.userStopped = false;
    clearTimeout(this.retryTimer);
    this.starting = this.launch(show).finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch(show) {
    try {
      await build();
      await mkdir(PROFILE, { recursive: true });
      this.status.state = "starting";
      this.status.message = "Abriendo el motor integrado de MoneyPoly…";
      const child = spawn(EXE, [PROFILE, ADAPTER, ...(show ? ["--show"] : [])], { cwd: WEB, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      this.status.hostPid = child.pid;
      this.status.connectionsOpened++;
      child.stdin.on("error", () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        this.queue = this.queue.then(() => this.receive(message)).catch((error) => { this.status.lastError = error.message; });
      });
      child.stderr.on("data", () => { this.status.lastError = "El motor integrado informó de un error nativo."; });
      child.once("error", (error) => {
        this.status.state = "error";
        this.status.message = "No se pudo iniciar el motor integrado: " + error.message;
      });
      child.once("exit", (code) => {
        lines.close();
        if (this.child !== child) return;
        this.child = null;
        this.status.hostPid = null;
        this.status.state = "stopped";
        this.status.message = "El lector integrado está detenido. Los datos guardados se conservan.";
        if (!this.stopped && !this.userStopped && code !== 0) {
          this.status.state = "recovering";
          this.status.message = "Reiniciando el motor integrado después de un cierre inesperado…";
          this.retryTimer = setTimeout(() => this.start(false).catch(() => {}), 10_000);
        }
      });
      await new Promise((done, fail) => { child.once("spawn", done); child.once("error", fail); });
    } catch (error) {
      this.status.state = "error";
      this.status.message = error.message;
      throw error;
    }
  }

  async receive(message) {
    if (message.kind === "initialized") {
      this.status.state = "waiting_data";
      this.status.message = "El lector integrado está abierto. Esperando a Axiom…";
    } else if (message.kind === "state") {
      if (message.state === "awaiting_login" || message.state === "browser_check") {
        this.status.state = message.state;
        this.status.message = message.state === "awaiting_login"
          ? "Inicia sesión una vez en la ventana MoneyPoly del lector. Después no necesitará Chrome."
          : "Axiom está comprobando el lector integrado. Si solicita una verificación, complétala en su ventana.";
      }
      this.status.pagePath = message.path;
      this.status.backgroundWindow = Boolean(message.background);
    } else if (message.kind === "window") {
      this.status.backgroundWindow = Boolean(message.background);
    } else if (message.kind === "user_stop") {
      this.userStopped = true;
    } else if (message.kind === "error") {
      this.status.lastError = message.code;
      this.status.state = "waiting_data";
      this.status.message = "Esperando una lectura válida del lector integrado de Axiom…";
      if (message.code === "initialization_failed") {
        this.status.state = "error";
        this.status.message = "El motor integrado de Windows no se ha podido inicializar.";
      }
    } else if (message.kind === "snapshot") {
      const data = message.data;
      if (!data?.ready) {
        this.status.state = "waiting_data";
        this.status.message = data?.reason || "Esperando los datos de Pulse…";
        return;
      }
      const now = new Date().toISOString();
      this.status.lastError = null;
      if (this.status.pulse?.dataFingerprint !== data.diagnostics?.dataFingerprint) this.status.lastSourceChangeAt = now;
      this.status.pulse = data.diagnostics;
      this.status.lastPollAt = now;
      for (const item of data.rows ?? []) {
        if (item.chain !== "sol" || item.stage !== "migrated" || item.protocol !== "Meteora AMM V2") continue;
        const key = `${item.mint}|${item.globalFeesPaidSol}|${item.taxRatePctMin ?? "?"}|${item.taxRatePctMax ?? "?"}`;
        if (Date.now() - (this.lastSent.get(key) || 0) < 30000) continue;
        await this.onObservation(item);
        this.lastSent.set(key, Date.now());
        this.status.lastObservationAt = now;
        this.status.observations++;
      }
      if ((data.diagnostics?.migratedLoaded ?? 0) > 0) {
        this.status.state = "receiving";
        this.status.message = "Recibiendo datos reales de Axiom con el lector integrado; Chrome no es necesario.";
        this.userStopped = false;
      }
      if (this.lastSent.size > 10000) for (const [key, at] of this.lastSent) if (Date.now() - at > 60000) this.lastSent.delete(key);
    }
  }

  command(type) { this.child?.stdin.write(JSON.stringify({ type }) + "\n"); }
  async setBackground(hidden = true) { this.command(hidden ? "hide" : "show"); }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.command("stop");
  }
}

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const HEALTH = "http://127.0.0.1:3001/api/axiom/health";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function readerHealth() {
  try {
    const response = await fetch(HEALTH, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return null;
    const health = await response.json();
    return health.service === "moneypoly-axiom-reader" ? health : null;
  } catch { return null; }
}

export async function ensureReaderService() {
  const existing = await readerHealth();
  if (existing) return { ...existing, reused: true };
  mkdirSync(resolve(WEB, "data"), { recursive: true });
  const out = openSync(resolve(WEB, "data/reader-service.log"), "a");
  const err = openSync(resolve(WEB, "data/reader-service-error.log"), "a");
  let child;
  try {
    child = spawn(process.execPath, [resolve(WEB, "scripts/bot-proxy.mjs")], {
      cwd: WEB, detached: true, windowsHide: true, stdio: ["ignore", out, err],
    });
    await new Promise((done, fail) => { child.once("spawn", done); child.once("error", fail); });
    child.unref();
  } finally { closeSync(out); closeSync(err); }
  for (let attempt = 0; attempt < 40; attempt++) {
    const health = await readerHealth();
    if (health) return { ...health, reused: false };
    if (child.exitCode != null) break;
    await delay(250);
  }
  throw new Error("No se pudo iniciar el lector local. Consulta data/reader-service-error.log.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || "status";
  try {
    if (action === "start") {
      const state = await ensureReaderService();
      console.log(`Lector ${state.reused ? "ya activo" : "iniciado"} (PID ${state.pid}).`);
    } else if (action === "status") {
      const state = await readerHealth();
      console.log(state ? JSON.stringify(state, null, 2) : "El lector está detenido.");
    } else if (action === "stop") {
      const state = await readerHealth();
      if (state && Number.isInteger(state.pid) && state.pid > 0 && state.pid !== process.pid) {
        process.kill(state.pid);
        console.log("Lector detenido. Los datos guardados se conservan.");
      } else console.log("El lector ya está detenido.");
    } else throw new Error("Acción válida: start, status o stop.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

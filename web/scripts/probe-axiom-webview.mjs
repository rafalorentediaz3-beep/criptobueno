import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserEndpoint, CdpConnection } from "./axiom-cdp.mjs";

const useSession = process.argv.includes("--use-axiom-session");
if (!useSession && !process.argv.includes("--anonymous")) {
  console.error("Usa --anonymous o, con autorización explícita, --use-axiom-session.");
  process.exit(1);
}
const tempRoot = await realpath(tmpdir());
let connection, child, profile, access;
try {
  console.log(JSON.stringify({ stage: "probe_start", authenticated: useSession }));
  if (useSession) {
  connection = await CdpConnection.connect(await browserEndpoint(process.env.AXIOM_CHROME_USER_DATA || join(process.env.LOCALAPPDATA, "Google/Chrome/User Data"), true), 120_000);
  const target = (await connection.call("Target.getTargets")).targetInfos.find((target) => target.type === "page" && /^https:\/\/axiom\.trade\/pulse/.test(target.url));
  if (!target) throw new Error("No hay una sesión de Pulse abierta.");
  const { sessionId } = await connection.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const { cookies } = await connection.call("Network.getCookies", { urls: ["https://axiom.trade/"] }, sessionId);
  access = cookies.find((cookie) => cookie.name === "auth-access-token");
  if (!access) throw new Error("La sesión de Axiom no está disponible.");
  connection.close(); connection = null;
  }
  profile = await mkdtemp(join(tempRoot, "moneypoly-axiom-webview-probe-"));
  const executable = join(tempRoot, "moneypoly-webview2-probe", "MoneyPolyWebViewProbe.exe");
  child = spawn(executable, [profile, fileURLToPath(new URL("../axiom-capture/pulse-reader.js", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", () => console.error("El lector integrado informó de un error nativo."));
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ cookie: access ? { name: access.name, value: access.value, domain: access.domain, path: access.path, sameSite: access.sameSite } : {} }) + "\n");
  access = undefined;
  const timeout = setTimeout(() => child.kill(), 65_000);
  try { await new Promise((done, fail) => { child.once("exit", done); child.once("error", fail); }); }
  finally { clearTimeout(timeout); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  access = undefined; connection?.close();
  if (profile) {
    const target = resolve(await realpath(profile));
    if (dirname(target).toLowerCase() !== tempRoot.toLowerCase() || !basename(target).startsWith("moneypoly-axiom-webview-probe-")) throw new Error("Carpeta temporal inesperada.");
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
  }
}

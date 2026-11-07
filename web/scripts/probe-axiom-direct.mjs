import https from "node:https";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { browserEndpoint, CdpConnection } from "./axiom-cdp.mjs";

// --use-axiom-session requires the user's explicit approval to take the Axiom
// access cookie outside Chrome. Never run that mode based on general browser
// access alone. This diagnostic holds the cookie in memory and never saves or
// prints it. It sends it only to the two Axiom Pulse endpoints listed here.
const HOSTS = ["pulse-unified1.axiom.trade", "pulse-unified2.axiom.trade"];
const useSession = process.argv.includes("--use-axiom-session");

async function sessionCookie() {
  const profile = process.env.AXIOM_CHROME_USER_DATA || join(process.env.LOCALAPPDATA, "Google/Chrome/User Data");
  const connection = await CdpConnection.connect(await browserEndpoint(profile, true), 120_000);
  try {
    const pages = (await connection.call("Target.getTargets")).targetInfos;
    const target = pages.find((page) => page.type === "page" && /^https:\/\/axiom\.trade\/pulse/.test(page.url));
    if (!target) throw new Error("Abre Pulse en tu sesión de Axiom.");
    const { sessionId } = await connection.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const result = await connection.call("Network.getCookies", { urls: HOSTS.map((host) => `https://${host}/ws`) }, sessionId);
    const cookies = result.cookies.filter((cookie) => cookie.name === "auth-access-token");
    if (!cookies.length) throw new Error("No hay una sesión de Axiom válida para esta prueba.");
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } finally { connection.close(); }
}

function probe(host, cookie) {
  return new Promise((resolve) => {
    const request = https.request(`https://${host}/ws?proto=2&view=sol`, {
      method: "GET",
      headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve({ host, authenticated: Boolean(cookie), status: response.statusCode }));
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ host, authenticated: Boolean(cookie), status: response.statusCode });
    });
    request.once("error", (error) => resolve({ host, authenticated: Boolean(cookie), error: error.code || "network_error" }));
    request.setTimeout(8_000, () => { request.destroy(); resolve({ host, authenticated: Boolean(cookie), error: "timeout" }); });
    request.end();
  });
}

let cookie;
try {
  if (useSession) cookie = await sessionCookie();
  const results = await Promise.all(HOSTS.map((host) => probe(host, cookie)));
  for (const result of results) console.log(JSON.stringify(result));
  if (!results.some((result) => result.status === 101)) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { cookie = undefined; }

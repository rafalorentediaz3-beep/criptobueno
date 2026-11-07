import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class CdpConnection {
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();

  static async connect(url, timeoutMs = 10_000) {
    const connection = new CdpConnection(new WebSocket(url));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.close();
        reject(new Error("Chrome no ha autorizado la conexión. Pulsa Permitir en su ventana."));
      }, timeoutMs);
      connection.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      connection.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("No se pudo conectar con Chrome.")); }, { once: true });
    });
    return connection;
  }

  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id != null) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const handler of this.#listeners.get(message.method) ?? []) {
        Promise.resolve().then(() => handler(message.params ?? {}, message.sessionId)).catch(() => {});
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("La conexión con Chrome se ha cerrado."));
      }
      this.#pending.clear();
      for (const handler of this.#listeners.get("close") ?? []) handler();
    });
  }

  call(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chrome está desconectado."));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Chrome agotó el tiempo de ${method}.`));
      }, 15_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, handler) {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(handler);
    this.#listeners.set(method, listeners);
    return () => listeners.delete(handler);
  }

  close() { this.socket.close(); }
}

export async function browserEndpoint(profileDirectory, permissioned = false) {
  const [port, browserPath] = (await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
  if (!/^\d+$/.test(port) || Number(port) < 1024 || !browserPath?.startsWith("/devtools/browser/")) {
    throw new Error("Chrome no ha publicado una conexión local válida.");
  }
  // Native permission based connections expose the WebSocket before /json/version.
  if (permissioned) return `ws://127.0.0.1:${port}${browserPath}`;
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error("Chrome no está disponible.");
  const info = await response.json();
  const endpoint = new URL(info.webSocketDebuggerUrl);
  if (endpoint.pathname !== browserPath) throw new Error("El puerto local ya pertenece a otra sesión.");
  return `ws://127.0.0.1:${port}${browserPath}`;
}

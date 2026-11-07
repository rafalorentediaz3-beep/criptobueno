import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const BIN = resolve(WEB, "data/native/bin");
const VERSION = "1.0.4314.35";
const MEMBERS = ["lib/net462/Microsoft.Web.WebView2.Core.dll", "lib/net462/Microsoft.Web.WebView2.WinForms.dll", "runtimes/win-x64/native/WebView2Loader.dll"];

// Extract only the three exact SDK members required by the host. Arbitrary ZIP
// paths are never written, so a package cannot escape the build directory.
function extractSdkMembers(zip) {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65557); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error("El SDK oficial no contiene un ZIP válido.");
  let at = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  if (count === 65535 || at === 0xffffffff) throw new Error("Formato de SDK no compatible.");
  const files = new Map();
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("Directorio del SDK no válido.");
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), expected = zip.readUInt32LE(at + 24);
    const nameSize = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const name = zip.toString("utf8", at + 46, at + 46 + nameSize);
    if (MEMBERS.includes(name)) {
      const local = zip.readUInt32LE(at + 42);
      if (zip.readUInt32LE(local) !== 0x04034b50 || expected > 20_000_000) throw new Error("Miembro del SDK no válido.");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const compressed = zip.subarray(start, start + size);
      const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: 20_000_000 }) : null;
      if (!content || content.length !== expected) throw new Error("DLL del SDK no válida.");
      files.set(name, content);
    }
    at += 46 + nameSize + extra + comment;
  }
  if (files.size !== MEMBERS.length) throw new Error("Faltan componentes del SDK de WebView2.");
  return files;
}

export async function buildNativeHost() {
  await mkdir(BIN, { recursive: true });
  let available = true;
  for (const member of MEMBERS) { try { await access(join(BIN, basename(member))); } catch { available = false; } }
  if (!available) {
    const cached = join(tmpdir(), "moneypoly-webview2-sdk-" + VERSION);
    let cachedAvailable = true;
    for (const member of MEMBERS) { try { await access(join(cached, member)); } catch { cachedAvailable = false; } }
    if (cachedAvailable) {
      for (const member of MEMBERS) await copyFile(join(cached, member), join(BIN, basename(member)));
    } else {
      const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${VERSION}/microsoft.web.webview2.${VERSION}.nupkg`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("No se pudo descargar el SDK oficial de Microsoft.");
      const zip = Buffer.from(await response.arrayBuffer());
      if (zip.length > 30_000_000) throw new Error("El paquete del SDK supera el tamaño esperado.");
      for (const [name, content] of extractSdkMembers(zip)) await writeFile(join(BIN, basename(name)), content);
    }
  }
  const executable = join(BIN, "MoneyPolyAxiomHost.exe");
  const compiler = join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const args = ["/nologo", "/target:exe", "/platform:x64", "/codepage:65001", "/out:" + executable,
    "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", "/r:System.Web.Extensions.dll",
    "/r:" + join(BIN, "Microsoft.Web.WebView2.Core.dll"), "/r:" + join(BIN, "Microsoft.Web.WebView2.WinForms.dll"),
    resolve(WEB, "scripts/MoneyPolyAxiomHost.cs")];
  await new Promise((done, fail) => {
    const child = spawn(compiler, args, { cwd: WEB, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => { output = (output + chunk.toString()).slice(-4000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", fail);
    child.once("exit", (code) => code === 0 ? done() : fail(new Error(output || "No se pudo compilar el lector nativo.")));
  });
  return executable;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await buildNativeHost(); console.log("MoneyPoly native reader compiled."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

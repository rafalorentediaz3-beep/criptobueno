import { mkdir, writeFile } from "node:fs/promises";
import { NativeAxiomReader } from "./axiom-native-reader.mjs";

const directory = new URL("../data/", import.meta.url);
await mkdir(directory, { recursive: true });
const rows = new Map();
const reader = new NativeAxiomReader(async (row) => {
  rows.set(row.mint, row);
  await writeFile(new URL("native-validation.json", directory), JSON.stringify({ observedAt: new Date().toISOString(), rows: [...rows.values()] }, null, 2), "utf8");
});
const save = async () => writeFile(new URL("native-setup-status.json", directory), JSON.stringify(reader.getStatus(), null, 2), "utf8");
const timer = setInterval(() => save().catch(() => {}), 2000);
process.on("SIGINT", () => { clearInterval(timer); reader.stop(); });
process.on("SIGTERM", () => { clearInterval(timer); reader.stop(); });
await reader.start(true);
await save();
console.log("MoneyPoly native setup started. Authentication stays in its own Windows WebView2 profile.");

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensureReaderService } from "./reader-service.mjs";

const reader = await ensureReaderService();
console.log(`MoneyPoly reader ${reader.reused ? "reused" : "started"} (PID ${reader.pid}).`);

const jobs = [
  spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", "--webpack"], { stdio: "inherit" }),
];

let shuttingDown = false;
function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of jobs) if (!child.killed) child.kill();
  // The reader deliberately survives web/Next restarts, keeping its one
  // native Axiom session. Stop it explicitly with npm run reader:stop.
}

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
for (const child of jobs) {
  child.on("error", (error) => {
    console.error("Failed to start dev service:", error);
    stopAll();
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    if (!shuttingDown) {
      process.exitCode = code || 0;
      stopAll();
    }
  });
}

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const typesDir = path.join(root, ".krate", "native", "types");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: windows });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const krate = (...args) => run("node", [path.join("scripts", "krate.mjs"), ...args]);

if (process.env.CI || !existsSync(typesDir)) krate("native", "build");
krate("native", "check");
run("node", [path.join("node_modules", "typescript", "bin", "tsc"), "--noEmit"]);

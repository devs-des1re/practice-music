import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function goroot() {
  if (process.env.GOROOT) return process.env.GOROOT;
  try {
    return execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const env = { ...process.env };
const resolved = goroot();
if (resolved) env.GOROOT = resolved;

const result = spawnSync("krate", process.argv.slice(2), {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);

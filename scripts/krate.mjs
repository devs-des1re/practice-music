import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const toolchain = process.env.PM_GO_TOOLCHAIN || "go1.26.1";

function goroot() {
  try {
    return execFileSync("go", ["env", "GOROOT"], {
      encoding: "utf8",
      env: { ...process.env, GOTOOLCHAIN: toolchain },
    }).trim();
  } catch {
    return "";
  }
}

const env = { ...process.env, GOTOOLCHAIN: toolchain };
const resolved = goroot();
if (resolved) env.GOROOT = resolved;
else delete env.GOROOT;

const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH";
env[pathKey] = path.join(root, "node_modules", ".bin") + path.delimiter + (env[pathKey] || "");

const result = spawnSync("krate", process.argv.slice(2), {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) console.error("krate could not be started: " + result.error.message);

process.exit(result.status ?? 1);

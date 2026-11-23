import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const engineName = windows ? "pm-engine.exe" : "pm-engine";
const engineBuilt = path.join(root, "engine", "target", "release", engineName);
const payloadDir = path.join(root, "api", "engine", "payload");
const payloadFile = path.join(payloadDir, engineName);
const configPath = path.join(root, "krate.config.ts");

const format = process.argv[2] || (windows ? "nsis" : "zip");
const version = (process.env.PM_VERSION || "").replace(/^v/, "");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: windows });
  if (result.status !== 0) {
    throw new Error(command + " " + args.join(" ") + " exited with " + result.status);
  }
}

function arch() {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

function platform() {
  if (windows) return "windows";
  return process.platform === "darwin" ? "darwin" : "linux";
}

if (!existsSync(engineBuilt)) {
  console.error("The audio engine is not built. Run npm run build:engine first.");
  process.exit(1);
}

const originalConfig = readFileSync(configPath, "utf8");
let status = 0;

try {
  copyFileSync(engineBuilt, payloadFile);
  if (version) {
    if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version)) {
      throw new Error("PM_VERSION is not a version number: " + version);
    }
    writeFileSync(configPath, originalConfig.replace(/version: '[^']*'/, "version: '" + version + "'"));
  }
  run("node", [
    path.join("scripts", "krate.mjs"),
    "native",
    "build",
    "--release",
    "--target",
    platform() + "/" + arch(),
    "--package",
    "--format",
    format,
  ]);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  status = 1;
} finally {
  writeFileSync(configPath, originalConfig);
  for (const file of readdirSync(payloadDir)) {
    if (file !== ".gitkeep") rmSync(path.join(payloadDir, file), { force: true });
  }
}

process.exit(status);

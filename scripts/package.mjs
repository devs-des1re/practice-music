import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setNativeVersion, installerFormats, targetArch } from "./package-options.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const engineName = windows ? "pm-engine.exe" : "pm-engine";
const engineBuilt = path.join(root, "engine", "target", "release", engineName);
const payloadDir = path.join(root, "api", "engine", "payload");
const payloadFile = path.join(payloadDir, engineName);
const configPath = path.join(root, "krate.config.ts");

const version = (process.env.PM_VERSION || "").replace(/^v/, "");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: windows });
  if (result.status !== 0) {
    throw new Error(command + " " + args.join(" ") + " exited with " + result.status);
  }
}

function platform() {
  if (windows) return "windows";
  return process.platform === "darwin" ? "darwin" : "linux";
}

const format = process.argv[2] || installerFormats(platform());
const arch = targetArch(platform(), process.env.PM_ARCH, process.arch);

function onPath(name) {
  const dirs = (process.env.PATH || process.env.Path || "").split(delimiter);
  return dirs.some((d) => d && existsSync(path.join(d, name)));
}

function ensureNsis() {
  if (!windows || format !== "nsis") return;
  const exe = "makensis.exe";
  if (onPath(exe)) return;
  const bases = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.ChocolateyInstall && path.join(process.env.ChocolateyInstall, "bin"),
  ];
  for (const base of bases) {
    if (!base) continue;
    for (const dir of [path.join(base, "NSIS"), base]) {
      if (existsSync(path.join(dir, exe))) {
        process.env.PATH = dir + delimiter + (process.env.PATH || process.env.Path || "");
        console.log("Using NSIS from " + dir);
        return;
      }
    }
  }
  console.error(
    "makensis was not found. Install NSIS (choco install nsis, or winget install NSIS.NSIS), open a new terminal and run this again.",
  );
  console.error("To build without an installer, run: node scripts/package.mjs zip");
  process.exit(1);
}

if (!existsSync(engineBuilt)) {
  console.error("The audio engine is not built. Run npm run build:engine first.");
  process.exit(1);
}

ensureNsis();

const originalConfig = readFileSync(configPath, "utf8");
let status = 0;

try {
  copyFileSync(engineBuilt, payloadFile);
  if (version) {
    if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version)) {
      throw new Error("PM_VERSION is not a version number: " + version);
    }
    writeFileSync(configPath, setNativeVersion(originalConfig, version));
  }
  run("node", [
    path.join("scripts", "krate.mjs"),
    "native",
    "build",
    "--release",
    "--target",
    platform() + "/" + arch,
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

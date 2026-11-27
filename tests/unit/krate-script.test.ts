import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function withoutAnyKrate(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") || "PATH";
  env[key] = (env[key] || "")
    .split(path.delimiter)
    .filter((dir) => !["krate", "krate.cmd", "krate.exe"].some((name) => existsSync(path.join(dir, name))))
    .join(path.delimiter);
  return env;
}

test("the krate script finds the project's own krate when run directly", () => {
  const wanted = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies["@krate/core"];
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "krate.mjs"), "--version"], {
    cwd: root,
    env: withoutAnyKrate(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(wanted), result.stdout);
});

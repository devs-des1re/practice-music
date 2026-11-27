const FORMATS = { windows: "nsis", darwin: "dmg", linux: "deb,rpm" };

export function installerFormats(platform) {
  const found = FORMATS[platform];
  if (!found) throw new Error("There is no installer for " + platform);
  return found;
}

export function targetArch(platform, wanted, host) {
  if (!wanted) return host === "arm64" ? "arm64" : "amd64";
  if (wanted === "universal" && platform !== "darwin") throw new Error("Universal builds are only for macOS");
  if (!["amd64", "arm64", "universal"].includes(wanted))
    throw new Error("PM_ARCH is not a known architecture: " + wanted);
  return wanted;
}

export function setNativeVersion(config, version) {
  const pattern = /(\bversion:\s*)(["'])[^"']*\2/;
  if (!pattern.test(config)) throw new Error("krate.config.ts has no version to replace");
  return config.replace(pattern, (_, key, quote) => key + quote + version + quote);
}

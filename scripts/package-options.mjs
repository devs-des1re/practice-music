export function setNativeVersion(config, version) {
  const pattern = /(\bversion:\s*)(["'])[^"']*\2/;
  if (!pattern.test(config)) throw new Error("krate.config.ts has no version to replace");
  return config.replace(pattern, (_, key, quote) => key + quote + version + quote);
}

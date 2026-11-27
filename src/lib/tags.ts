export function splitTags(text: string): string[] {
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  for (const part of text.split(",")) {
    const name = part.trim();
    const key = name.toLowerCase();
    if (!name || seen[key]) continue;
    seen[key] = true;
    out.push(name);
  }
  return out;
}

export function tagChanges(before: string[], after: string[]): { added: string[]; removed: string[] } {
  return {
    added: after.filter((name) => !before.includes(name)),
    removed: before.filter((name) => !after.includes(name)),
  };
}

export function nameKey(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .join(" ")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function takenName(wanted: string, others: string[], kind: string): string {
  const key = nameKey(wanted);
  const match = others.find((other) => nameKey(other) === key);
  return match === undefined ? "" : "You already have a " + kind + ' called "' + match + '". Pick another name.';
}

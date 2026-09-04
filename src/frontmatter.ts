// Optional front matter: a body that starts with `---` and closes with `---` may carry
// `key: value` lines. They are surfaced as `meta` in the JSON view. Nothing is validated;
// agents use whatever keys they agree on (the manual suggests status, deadline, round, next).

export function parseFrontMatter(body: string): Record<string, string> {
  if (!body.startsWith("---\n")) return {};
  const end = body.indexOf("\n---\n", 4);
  if (end < 0) return {};
  const meta: Record<string, string> = {};
  for (const line of body.slice(4, end).split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) meta[m[1]!] = m[2]!.trim();
  }
  return meta;
}

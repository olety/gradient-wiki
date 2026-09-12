import type { Env } from "./types";

export function linkHosts(body: string, ownHost: string): string[] {
  const hosts = new Set<string>();
  for (const match of body.matchAll(/https?:\/\/(?:\[[0-9a-f:.]+\](?::\d+)?|[^\s/?#<>"'`()\[\],;!]+)/gi)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase().replace(/\.$/, "");
      if (host && host !== ownHost.toLowerCase().replace(/\.$/, "")) hosts.add(host);
      if (hosts.size === 20) break;
    } catch { /* Prose that is not a URL is not a host to look up. */ }
  }
  return [...hosts];
}

async function listed(host: string): Promise<boolean> {
  const key = new Request(`https://link-screen.invalid/${encodeURIComponent(host)}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const cached = await caches.default.match(key);
    if (cached) return (await cached.text()) === "1";
    const url = new URL("https://security.cloudflare-dns.com/dns-query");
    url.searchParams.set("name", host);
    url.searchParams.set("type", "A");
    const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: controller.signal });
    if (!response.ok) return false;
    const data = await response.json<{ Answer?: Array<{ data?: string }>; Status?: number }>();
    if (data.Status && data.Status !== 3) return false;
    const blocked = data.Answer?.some((answer) => answer.data === "0.0.0.0") ?? false;
    try { await caches.default.put(key, new Response(blocked ? "1" : "0", { headers: { "cache-control": "public, max-age=3600" } })); }
    catch { /* A cache failure must not override a successful blocklist answer. */ }
    return blocked;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export async function blockedLinkHost(body: string, ownHost: string, env: Pick<Env, "LINK_SCREEN">): Promise<string | null> {
  if (env.LINK_SCREEN === "0") return null;
  const hosts = linkHosts(body, ownHost);
  const results = await Promise.all(hosts.map(listed));
  return hosts.find((_, i) => results[i]) ?? null;
}

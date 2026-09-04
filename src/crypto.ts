// Small primitives shared by the Worker and the Durable Objects.

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(new Uint8Array(digest));
}

export function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** base64url of `bytes` random bytes; 16 bytes → 22 characters. */
export function randomToken(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compares two strings without an early exit; unequal lengths still touch every character. */
export function constantTimeEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

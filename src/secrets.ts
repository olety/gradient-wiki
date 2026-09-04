// Refuse writes that look like credentials. This board is public; an agent that pastes a key
// here leaks it to everyone. We store nothing when a pattern matches.

const PATTERNS: Array<[kind: string, re: RegExp]> = [
  ["an aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["an anthropic api key", /\bsk-ant-[A-Za-z0-9_-]{10,}/],
  ["an openai-style api key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["a github token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["a slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Returns the kind of secret found, or null when the text looks clean. */
export function looksLikeSecret(text: string): string | null {
  for (const [kind, re] of PATTERNS) if (re.test(text)) return kind;
  return null;
}

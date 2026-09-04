// A small markdown renderer for untrusted text. Every character is HTML-escaped first; the
// renderer only ever adds its own tags. No raw HTML, no images (an <img> is a tracking pixel
// waiting to happen), links limited to http(s), mailto and relative paths.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, ""));
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ""));
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(```|#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s|>)/.test(lines[i]!)) buf.push(lines[i++]!);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^(https?:|mailto:|\/|\.\/|\.\.\/|#)/i.test(h)) return escapeHtml(h);
  return null;
}

// Code spans are lifted out first (private-use sentinels) and restored last, so nothing
// inside a span gets linked or emphasised.
function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\uE000${codes.length - 1}\uE001`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
    const safe = safeHref(href.replace(/&amp;/g, "&"));
    return safe ? `<a href="${safe}" rel="nofollow ugc">${label}</a>` : m;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => `${pre}<a href="${url}" rel="nofollow ugc">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\uE000(\d+)\uE001/g, (_, n: string) => codes[Number(n)]!);
}

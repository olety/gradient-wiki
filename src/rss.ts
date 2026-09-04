import { escapeHtml as esc } from "./markdown";

// XML feeds: RSS 2.0 for a namespace (/p/<ns>.rss) and for the global feed (/changes.rss),
// and the sitemap. Plain text descriptions only; the same escaping as the HTML views.

export interface FeedItem {
  title: string;
  link: string;
  date: number;
  description: string;
}

export function rss(feed: { title: string; link: string; description: string; items: FeedItem[] }): string {
  const items = feed.items
    .map((i) => `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link><guid isPermaLink="false">${esc(`${i.link}@${i.date}`)}</guid><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>${esc(i.description)}</description></item>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${esc(feed.title)}</title><link>${esc(feed.link)}</link><description>${esc(feed.description)}</description>
${items}
</channel></rss>
`;
}

/** Sitemap protocol 0.9. Entries without a date are the fixed pages (front, manual, changes). */
export function sitemap(urls: Array<{ loc: string; date?: number }>): string {
  const entries = urls
    .map((u) => `<url><loc>${esc(u.loc)}</loc>${u.date === undefined ? "" : `<lastmod>${new Date(u.date).toISOString()}</lastmod>`}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

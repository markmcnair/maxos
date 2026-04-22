export interface TrendingRepo {
  slug: string;         // "user/repo"
  url: string;          // "https://github.com/user/repo"
  description: string;
  starsToday: number;
}

const AI_KEYWORDS = [
  "llm", "rag", "agent", "mcp", "claude", "model", "embedding", "vector",
  "prompt", "inference", "fine-tun", "eval", "benchmark", "training",
  "dataset", "framework", "openai", "anthropic", "transformer", "neural",
];

export function parseTrendingHtml(html: string): TrendingRepo[] {
  const repos: TrendingRepo[] = [];
  const articleRegex = /<article\b[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let match;
  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[1];
    const hrefMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)"/);
    if (!hrefMatch) continue;
    const slug = hrefMatch[1].trim();
    if (slug.startsWith("sponsors/")) continue;
    const descMatch = block.match(/<p[^>]*class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const description = descMatch ? stripTags(descMatch[1]).trim() : "";
    const starsMatch = block.match(/([\d,]+)\s+stars? today/);
    const starsToday = starsMatch ? parseInt(starsMatch[1].replace(/,/g, ""), 10) : 0;
    repos.push({
      slug,
      url: `https://github.com/${slug}`,
      description,
      starsToday,
    });
  }
  return repos;
}

export function filterByAIKeywords(repos: TrendingRepo[]): TrendingRepo[] {
  return repos.filter(r => {
    const blob = (r.description + " " + r.slug).toLowerCase();
    return AI_KEYWORDS.some(k => blob.includes(k));
  });
}

export async function fetchTrending(): Promise<TrendingRepo[]> {
  const res = await fetch("https://github.com/trending?since=daily", {
    headers: { "User-Agent": "Mozilla/5.0 (MaxOS brew)" },
  });
  if (!res.ok) throw new Error(`github trending fetch failed: ${res.status}`);
  const html = await res.text();
  const repos = parseTrendingHtml(html);
  const slugShape = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
  const bad = repos.filter(r => !slugShape.test(r.slug));
  if (bad.length > 0) {
    throw new Error(`github trending: unexpected slug format (${bad[0].slug}) — HTML structure may have changed`);
  }
  return repos;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const all = await fetchTrending();
    const ai = filterByAIKeywords(all);
    process.stdout.write(JSON.stringify(ai, null, 2));
  })().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTrendingHtml, filterByAIKeywords, type TrendingRepo } from "../src/brew-github-trending.js";

describe("parseTrendingHtml", () => {
  it("extracts repo title, description, stars-today from sample fragment", () => {
    const html = `
      <article class="Box-row">
        <h2 class="h3 lh-condensed">
          <a href="/user/repo">
            <span>user</span> / <span>repo</span>
          </a>
        </h2>
        <p class="col-9 color-fg-muted my-1 pr-4">Awesome LLM agent toolkit.</p>
        <span class="d-inline-block float-sm-right">1,234 stars today</span>
      </article>
    `;
    const repos = parseTrendingHtml(html);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].slug, "user/repo");
    assert.equal(repos[0].url, "https://github.com/user/repo");
    assert.equal(repos[0].description, "Awesome LLM agent toolkit.");
    assert.equal(repos[0].starsToday, 1234);
  });

  it("returns empty array for empty html", () => {
    assert.deepEqual(parseTrendingHtml(""), []);
  });
});

describe("filterByAIKeywords", () => {
  const repos: TrendingRepo[] = [
    { slug: "a/b", url: "https://github.com/a/b", description: "An LLM wrapper with RAG support.", starsToday: 100 },
    { slug: "c/d", url: "https://github.com/c/d", description: "Simple CLI for photo editing.", starsToday: 200 },
    { slug: "e/f", url: "https://github.com/e/f", description: "MCP server for Obsidian.", starsToday: 50 },
  ];

  it("keeps only repos matching AI keywords", () => {
    const filtered = filterByAIKeywords(repos);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.find(r => r.slug === "a/b"));
    assert.ok(filtered.find(r => r.slug === "e/f"));
  });

  it("is case-insensitive", () => {
    const filtered = filterByAIKeywords([
      { slug: "x/y", url: "u", description: "llm EVAL harness", starsToday: 0 },
    ]);
    assert.equal(filtered.length, 1);
  });
});

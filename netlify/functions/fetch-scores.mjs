// netlify/functions/fetch-scores.mjs
// Called directly by the frontend every 2 minutes.
// Fetches all 4 CHSAA bracket pages, parses scores, and returns JSON.
// No Blobs needed — frontend calls this function directly.

import { getStore } from "@netlify/blobs";

const SOURCES = {
  b2a: "https://chsaa.co/basketball/2026/boys/2A",
  g2a: "https://chsaa.co/basketball/2026/girls/2A",
  b1a: "https://chsaa.co/basketball/2026/boys/1A",
  g1a: "https://chsaa.co/basketball/2026/girls/1A",
};

function parseChsaaPage(html, bracketKey) {
  const results = {};
  if (!html) return results;

  const gameLinkRe = /<a[^>]+href="\/basketball\/2026\/(?:boys|girls)\/[^"]+\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = gameLinkRe.exec(html)) !== null) {
    const chsaaGameNum = parseInt(match[1], 10);
    const text = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const scores = extractScores(text);
    if (scores) {
      results[`${bracketKey}-G${chsaaGameNum}`] = { sc1: scores.sc1, sc2: scores.sc2, final: true };
    }
  }
  return results;
}

function extractScores(text) {
  const nums = [...text.matchAll(/\b(\d{1,3})\b/g)].map(m => parseInt(m[1], 10));
  if (nums.length < 4) return null;
  if (/\bW\d+\b/.test(text)) return null;
  const scoreCandidates = nums.filter(n => n >= 10 && n <= 150);
  if (scoreCandidates.length < 2) return null;
  const sc1 = scoreCandidates[scoreCandidates.length - 2];
  const sc2 = scoreCandidates[scoreCandidates.length - 1];
  if (sc1 === sc2) return null;
  return { sc1, sc2 };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CHSAABracketBot/2.0)",
          "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        if (attempt < 3) await sleep(2000 * attempt);
        continue;
      }
      return await r.text();
    } catch (e) {
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  return "";
}

export default async (req, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  };

  try {
    const [b2aHtml, g2aHtml, b1aHtml, g1aHtml] = await Promise.all([
      fetchPage(SOURCES.b2a),
      fetchPage(SOURCES.g2a),
      fetchPage(SOURCES.b1a),
      fetchPage(SOURCES.g1a),
    ]);

    const scores = {
      ...parseChsaaPage(b2aHtml, "b2a"),
      ...parseChsaaPage(g2aHtml, "g2a"),
      ...parseChsaaPage(b1aHtml, "b1a"),
      ...parseChsaaPage(g1aHtml, "g1a"),
    };

    const output = { updated: new Date().toISOString(), scores };
    return new Response(JSON.stringify(output), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, scores: {}, updated: null }), { status: 500, headers });
  }
};

export const config = { path: "/api/scores" };

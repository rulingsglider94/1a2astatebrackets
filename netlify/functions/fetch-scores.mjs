// netlify/functions/fetch-scores.mjs
// Scheduled every 5 minutes — fetches all 4 CHSAA bracket pages,
// parses game scores, and writes results to Netlify Blobs.

import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// ─── CHSAA SOURCE URLS ────────────────────────────────────────────────────
const SOURCES = {
  b2a: "https://chsaa.co/basketball/2026/boys/2A",
  g2a: "https://chsaa.co/basketball/2026/girls/2A",
  b1a: "https://chsaa.co/basketball/2026/boys/1A",
  g1a: "https://chsaa.co/basketball/2026/girls/1A",
};

// ─── PARSE ONE CHSAA BRACKET PAGE ────────────────────────────────────────
// CHSAA renders each game as an anchor tag. Completed games have scores
// embedded as plain text numbers inside the block. The structure is:
//   G{N} {date} {seed1}{team1} {score1} {seed2}{team2} {score2}
// Incomplete games show "W{N}" placeholders instead of scores.

function parseChsaaPage(html, bracketKey) {
  const results = {};
  if (!html) return results;

  // Each game is an <a> tag with href containing the game number
  const gameLinkRe = /<a[^>]+href="\/basketball\/2026\/(?:boys|girls)\/[^"]+\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = gameLinkRe.exec(html)) !== null) {
    const chsaaGameNum = parseInt(match[1], 10);
    // Strip HTML tags to get plain text
    const text = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    const scores = extractScores(text);
    if (scores) {
      const key = `${bracketKey}-G${chsaaGameNum}`;
      results[key] = { sc1: scores.sc1, sc2: scores.sc2, final: true };
    }
  }

  return results;
}

// Extract two basketball scores from CHSAA plain-text game block.
// Text example: "G1 3/6 1 Sanford 69 32 Ridgway 26"
// Scores are the last two numbers in the 10-150 range.
function extractScores(text) {
  const nums = [...text.matchAll(/\b(\d{1,3})\b/g)].map(m => parseInt(m[1], 10));

  // Need at least seed + score for each team
  if (nums.length < 4) return null;

  // Skip if text contains "W" followed by a number (TBD/winner placeholder)
  if (/\bW\d+\b/.test(text)) return null;

  // Score candidates: 10–150 (realistic basketball range, excludes seeds 1–32)
  const scoreCandidates = nums.filter(n => n >= 10 && n <= 150);
  if (scoreCandidates.length < 2) return null;

  // Take the last two — in CHSAA text layout scores appear after team names
  const sc1 = scoreCandidates[scoreCandidates.length - 2];
  const sc2 = scoreCandidates[scoreCandidates.length - 1];

  // Ties don't happen in basketball, both must be valid
  if (sc1 === sc2) return null;

  return { sc1, sc2 };
}

// ─── HTTP FETCH WITH RETRIES ──────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CHSAABracketBot/2.0)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        console.warn(`HTTP ${r.status} for ${url} (attempt ${attempt})`);
        if (attempt < 3) await sleep(2000 * attempt);
        continue;
      }
      return await r.text();
    } catch (e) {
      console.warn(`Fetch failed ${url} (attempt ${attempt}): ${e.message}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  console.error(`All retries failed for ${url}`);
  return "";
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────
const handler = async () => {
  console.log("fetch-scores START", new Date().toISOString());

  try {
    // Fetch all 4 CHSAA pages in parallel
    const [b2aHtml, g2aHtml, b1aHtml, g1aHtml] = await Promise.all([
      fetchPage(SOURCES.b2a),
      fetchPage(SOURCES.g2a),
      fetchPage(SOURCES.b1a),
      fetchPage(SOURCES.g1a),
    ]);

    // Log page sizes to confirm pages loaded
    console.log("Page sizes (chars):", {
      b2a: b2aHtml.length, g2a: g2aHtml.length,
      b1a: b1aHtml.length, g1a: g1aHtml.length,
    });

    const scores = {
      ...parseChsaaPage(b2aHtml, "b2a"),
      ...parseChsaaPage(g2aHtml, "g2a"),
      ...parseChsaaPage(b1aHtml, "b1a"),
      ...parseChsaaPage(g1aHtml, "g1a"),
    };

    const count = Object.keys(scores).length;
    console.log(`Parsed ${count} completed games:`, JSON.stringify(scores));

    const output = { updated: new Date().toISOString(), scores };

    const store = getStore("scores");
    await store.setJSON("latest", output);
    console.log("Saved to Netlify Blobs OK");

    return { statusCode: 200, body: JSON.stringify({ ok: true, count }) };
  } catch (err) {
    console.error("fetch-scores ERROR:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

const scheduledHandler = schedule("*/5 * * * *", handler);
export { scheduledHandler as handler };

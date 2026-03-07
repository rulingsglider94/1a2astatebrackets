// netlify/functions/fetch-scores.mjs
// Called by the frontend every 2 minutes via /api/scores.
// Fetches all 4 CHSAA bracket pages, parses completed game scores, returns JSON.

const SOURCES = {
  b2a: "https://chsaa.co/basketball/2026/boys/2A",
  g2a: "https://chsaa.co/basketball/2026/girls/2A",
  b1a: "https://chsaa.co/basketball/2026/boys/1A",
  g1a: "https://chsaa.co/basketball/2026/girls/1A",
};

// ─── PARSER ───────────────────────────────────────────────────────────────
// CHSAA renders each game as an anchor block. Plain text after stripping tags:
//
//   PLAYED:     "1 Sanford 69 32 Ridgway 26"       → seed score seed score
//   NOT PLAYED: "8 Merino 9 Limon"                 → only 2 numbers (seeds)
//               "29 Akron W6"                       → W-placeholder present
//               "6 Prairie 11 Peetz"                → only seeds, no scores
//
// Pattern: seed(1-32)  score(≥10)  seed(1-32)  score(≥10), scores differ.

function parseChsaaPage(html, bracketKey) {
  const results = {};
  if (!html) return results;

  const gameLinkRe = /<a[^>]+href="\/basketball\/2026\/(?:boys|girls)\/[^"]+\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = gameLinkRe.exec(html)) !== null) {
    const gameNum = parseInt(match[1], 10);
    const text = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const scores = extractScores(text);
    if (scores) {
      results[`${bracketKey}-G${gameNum}`] = { sc1: scores.sc1, sc2: scores.sc2, final: true };
    }
  }
  return results;
}

function extractScores(text) {
  // Reject any game with W-placeholders (not yet played)
  if (/\bW\d+\b/i.test(text)) return null;

  // Extract all numbers 1–150 (covers seeds 1-32 and basketball scores)
  const nums = [...text.matchAll(/\b(\d+)\b/g)]
    .map(m => parseInt(m[1], 10))
    .filter(n => n >= 1 && n <= 150);

  // Need at least 4 numbers for seed/score/seed/score pattern
  if (nums.length < 4) return null;

  // Scan for the pattern: a(seed) b(score) c(seed) d(score)
  for (let i = 0; i <= nums.length - 4; i++) {
    const [a, b, c, d] = nums.slice(i, i + 4);
    if (!(1 <= a && a <= 32)) continue;   // a must be a seed
    if (!(1 <= c && c <= 32)) continue;   // c must be a seed
    if (b < 10 || d < 10) continue;       // scores must be >= 10
    if (b === d) continue;                 // scores must differ (no ties)
    if (b <= 32 && b === c) continue;     // b looks like seed2, not score1
    if (d <= 32 && d === a) continue;     // d looks like seed1, not score2
    return { sc1: b, sc2: d };
  }
  return null;
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

// ─── HANDLER ──────────────────────────────────────────────────────────────
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
    return new Response(
      JSON.stringify({ error: err.message, scores: {}, updated: null }),
      { status: 500, headers }
    );
  }
};

export const config = { path: "/api/scores" };

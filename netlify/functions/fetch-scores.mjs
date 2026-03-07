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
// CHSAA HTML structure for each game link block (plain text after stripping tags):
//
// COMPLETED:  "1 Sanford 69 32 Ridgway 26"
//             seed1 team1 score1 seed2 team2 score2
//
// NOT PLAYED: "13 Plateau Valley 20 Trinidad"   ← only 3 numbers (seed, seed, time)
//             "29 Akron W6"                      ← has W-placeholder
//             "W7 W8"                            ← all placeholders
//             "8 Merino 9 Limon"                 ← only 2 numbers, no scores yet
//
// Key insight: a completed game has EXACTLY 4 numbers in order:
//   seed1 (1-32), score1 (10-199), seed2 (1-32), score2 (10-199)
// An unplayed game has only 2 numbers (the seeds) or contains W-placeholders.

function parseChsaaPage(html, bracketKey) {
  const results = {};
  if (!html) return results;

  // Match each game anchor block
  const gameLinkRe = /<a[^>]+href="\/basketball\/2026\/(?:boys|girls)\/[^"]+\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = gameLinkRe.exec(html)) !== null) {
    const gameNum = parseInt(match[1], 10);
    // Strip all HTML tags to get plain text
    const text = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    const scores = extractScores(text);
    if (scores) {
      results[`${bracketKey}-G${gameNum}`] = { sc1: scores.sc1, sc2: scores.sc2, final: true };
    }
  }
  return results;
}

function extractScores(text) {
  // Immediately reject if any W-placeholder exists (unplayed game)
  if (/\bW\d+\b/i.test(text)) return null;

  // Extract all numbers from the text
  const allNums = [...text.matchAll(/\b(\d+)\b/g)].map(m => parseInt(m[1], 10));

  // A completed game block produces exactly 4 numbers: seed1 score1 seed2 score2
  // (sometimes 5+ if date like "3" "6" or "7" appear — so we look for the pattern)
  // Filter to only numbers that could be seeds (1-32) or scores (10-199)
  const relevant = allNums.filter(n => n >= 1 && n <= 199);

  if (relevant.length < 4) return null;

  // Find the pattern: low(seed), high(score), low(seed), high(score)
  // where seed <= 32 and score >= 33 (no basketball score is 33 or less... 
  // actually scores CAN be low. Better approach:
  // Seeds are always 1-32. Scores in 1A/2A are realistically 20-120.
  // The key is: in CHSAA text, numbers appear in ORDER: seed1, score1, seed2, score2.
  // So we look for the last 4 numbers where positions [0] and [2] are seeds (1-32)
  // and positions [1] and [3] are plausible scores (different from seeds pattern).

  // Strategy: scan through relevant numbers looking for seed, score, seed, score pattern
  for (let i = 0; i <= relevant.length - 4; i++) {
    const [a, b, c, d] = relevant.slice(i, i + 4);
    const aIsSeed = a >= 1 && a <= 32;
    const cIsSeed = c >= 1 && c <= 32;
    const bIsScore = b >= 20 && b <= 150;
    const dIsScore = d >= 20 && d <= 150;
    const scoresAreDifferent = b !== d;
    const scoresNotEqualSeeds = b !== a && b !== c && d !== a && d !== c;

    if (aIsSeed && cIsSeed && bIsScore && dIsScore && scoresAreDifferent && scoresNotEqualSeeds) {
      return { sc1: b, sc2: d };
    }
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

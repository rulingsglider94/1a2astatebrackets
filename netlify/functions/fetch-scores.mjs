// netlify/functions/fetch-scores.mjs
// Fetches all 4 CHSAA bracket pages live and returns parsed scores as JSON.
const SOURCES = {
  b2a: "https://chsaa.co/basketball/2026/boys/2A",
  g2a: "https://chsaa.co/basketball/2026/girls/2A",
  b1a: "https://chsaa.co/basketball/2026/boys/1A",
  g1a: "https://chsaa.co/basketball/2026/girls/1A",
};

function extractGameTime(text) {
  // Match patterns like "3/8 11:00A", "3/12 2:30PM", "Mar 8 11:00AM", etc.
  const dateTimeRe = /\b(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2}\s*[APap][Mm]?)/;
  const timeOnlyRe = /\b(\d{1,2}:\d{2}\s*[APap][Mm]?)/;
  const dtMatch = text.match(dateTimeRe);
  if (dtMatch) return `${dtMatch[1]} ${dtMatch[2].trim()}`;
  const tMatch = text.match(timeOnlyRe);
  if (tMatch) return tMatch[1].trim();
  return null;
}

function parseChsaaPage(html, bracketKey) {
  const results = {};
  if (!html) return results;
  const gameLinkRe = /<a[^>]+href="\/basketball\/2026\/(?:boys|girls)\/[^"]+\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = gameLinkRe.exec(html)) !== null) {
    const chsaaGameNum = parseInt(match[1], 10);
    const text = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const key = `${bracketKey}-G${chsaaGameNum}`;

    // Unplayed game — try to extract a scheduled time
    if (/\bW\d+\b/i.test(text)) {
      const time = extractGameTime(text);
      if (time) {
        results[key] = { time };
      }
      continue;
    }

    // Played game — extract scores
    const scores = extractScores(text);
    if (scores) {
      results[key] = { sc1: scores.sc1, sc2: scores.sc2, final: true };
    }
  }
  return results;
}

function extractScores(text) {
  // Skip unplayed games — CHSAA uses "W1", "W2" etc. as TBD placeholders
  if (/\bW\d+\b/i.test(text)) return null;
  // Strip date and time patterns BEFORE scanning for numbers.
  let clean = text;
  clean = clean.replace(/\b\d{1,2}\/\d{1,2}\b/g, "");           // e.g. 3/6, 3/12
  clean = clean.replace(/\b\d{1,2}:\d{2}\s*[APap][Mm]?\b/g, ""); // e.g. 11:00A, 2:30PM
  const nums = [...clean.matchAll(/\b(\d+)\b/g)].map(m => parseInt(m[1], 10));
  if (nums.length < 4) return null;
  // Scan for pattern: seed(1-32) score(>=10) seed(1-32) score(>=10)
  // At least one score must exceed 32 so we can distinguish it from a seed.
  for (let i = 0; i <= nums.length - 4; i++) {
    const [a, b, c, d] = nums.slice(i, i + 4);
    if (!(1 <= a && a <= 32)) continue;
    if (!(1 <= c && c <= 32)) continue;
    if (b < 10 || d < 10) continue;
    if (b === d) continue;
    if (b <= 32 && d <= 32) continue;
    if (b === c) continue;
    if (d === a) continue;
    return { sc1: b, sc2: d };
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CHSAABracketBot/2.0; +https://1a2astatebrackets.netlify.app)",
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

export const handler = async () => {
  console.log("fetch-scores START", new Date().toISOString());
  try {
    const [b2aHtml, g2aHtml, b1aHtml, g1aHtml] = await Promise.all([
      fetchPage(SOURCES.b2a),
      fetchPage(SOURCES.g2a),
      fetchPage(SOURCES.b1a),
      fetchPage(SOURCES.g1a),
    ]);
    console.log("Page sizes:", {
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
    console.log(`Parsed ${count} games (scores + times):`, JSON.stringify(scores));
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ updated: new Date().toISOString(), scores }),
    };
  } catch (err) {
    console.error("fetch-scores ERROR:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

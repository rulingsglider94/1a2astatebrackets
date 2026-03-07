// netlify/functions/fetch-scores.mjs
// Fetches all 4 CHSAA bracket pages live and returns parsed scores as JSON.

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
      const key = `${bracketKey}-G${chsaaGameNum}`;
      results[key] = { sc1: scores.sc1, sc2: scores.sc2, final: true };
    }
  }

  return results;
}

function extractScores(text) {
  // Skip unplayed games — CHSAA uses "W1", "W2" etc. as TBD placeholders
  if (/\bW\d+\b/i.test(text)) return null;

  // Strip date and time patterns BEFORE scanning for numbers.
  // Without this, "12:30P" injects 12 and 30 into the number stream,
  // which causes them to be mistaken for scores.
  let clean = text;
  clean = clean.replace(/\b\d{1,2}\/\d{1,2}\b/g, "");          // e.g. 3/6, 3/12
  clean = clean.replace(/\b\d{1,2}:\d{2}\s*[APap][Mm]?\b/g, ""); // e.g. 11:00A, 2:30PM

  const nums = [...clean.matchAll(/\b(\d+)\b/g)].map(m => parseInt(m[1], 10));
  if (nums.length < 4) return null;

  // Scan for pattern: seed(1-32) score(>=10) seed(1-32) score(>=10)
  // At least one score must exceed 32 so we can distinguish it from a seed.
  for (let i = 0; i <= nums.length - 4; i++) {
    const [a, b, c, d] = nums.slice(i, i + 4);
    if (!(1 <= a && a <= 32)) continue;   // a must be a seed
    if (!(1 <= c && c <= 32)) continue;   // c must be a seed
    if (b < 10 || d < 10) continue;       // scores must be >= 10
    if (b === d) continue;                 // no ties
    if (b <= 32 && d <= 32) continue;     // at least one score must beat seed range
    if (b === c) continue;                 // score can't equal next seed
    if (d === a) continue;                 // score can't equal prior seed
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
    console.log(`Parsed ${count} completed games:`, JSON.stringify(scores));

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

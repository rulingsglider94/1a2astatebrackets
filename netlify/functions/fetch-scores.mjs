// netlify/functions/fetch-scores.mjs
// Runs every 10 minutes via Netlify scheduled functions
// Fetches MileHighPrepReport and MaxPreps, parses 1A/2A scores, writes scores.json to /public

import { schedule } from "@netlify/functions";

const SOURCES = {
  boys_today: "https://milehighprepreport.com/2026/03/07/boys-basketball-regional-schedule-results-class-1a-thru-4a-saturday/",
  girls_today: "https://milehighprepreport.com/2026/03/07/girls-basketball-regional-schedule-results-class-1a-thru-4a-saturday/",
  boys_fri: "https://milehighprepreport.com/2026/03/06/boys-basketball-regional-schedule-results-class-1a-thru-4a-updated-3-6-11pm/",
  girls_fri: "https://milehighprepreport.com/2026/03/06/girls-basketball-regional-schedule-results-class-1a-thru-4a-updated-3-6-11pm/",
};

// Known game matchups — used to match parsed scores back to game IDs
const GAME_MATCHUPS = {
  // Boys 2A Sweet 16
  "b2a-G17": ["Sanford", "Center"],
  "b2a-G18": ["Merino", "Limon"],
  "b2a-G19": ["Plateau Valley", "Akron"],
  "b2a-G20": ["Golden View Classical", "Front Range Christian"],
  "b2a-G21": ["Simla", "Caprock Academy"],
  "b2a-G22": ["Vail Christian", "Haxtun"],
  "b2a-G23": ["Heritage Christian", "Campion Academy"],
  "b2a-G24": ["Byers", "Swallows Charter"],
  // Girls 2A Sweet 16
  "g2a-G17": ["Merino", "Center"],
  "g2a-G18": ["Akron", "James Irwin"],
  "g2a-G19": ["Sargent", "Hoehne"],
  "g2a-G20": ["Sedgwick County", "Calhan"],
  "g2a-G21": ["Simla", "Dayspring Christian"],
  "g2a-G22": ["Heritage Christian", "Holyoke"],
  "g2a-G23": ["Sanford", "Swink"],
  "g2a-G24": ["Plateau Valley", "Del Norte"],
  // Boys 1A Sweet 16
  "b1a-G17": ["McClave", "Granada"],
  "b1a-G18": ["Elbert", "Otis"],
  "b1a-G19": ["Flatirons Academy", "Holly"],
  "b1a-G20": ["Stratton", "Sangre de Cristo"],
  "b1a-G21": ["Nucla", "De Beque"],
  "b1a-G22": ["Denver Waldorf", "Sierra Grande"],
  "b1a-G23": ["Cheyenne Wells", "Wiley"],
  // Girls 1A Sweet 16
  "g1a-G17": ["McClave", "Granada"],
  "g1a-G19": ["Stratton", "Genoa-Hugo/Karval"],
  "g1a-G20": ["Fleming", "Idalia"],
  "g1a-G23": ["Evangel Christian", "Flagler"],
  "g1a-G24": ["Nucla", "Briggsdale"],
};

function normName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function teamMatch(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Parse score lines like "Sanford 69, Ridgway 26" or "Sanford over Ridgway, 69 to 26"
function parseScoresFromHTML(html) {
  const results = [];
  if (!html) return results;

  // Pattern 1: "Team1 over Team2, XX to XX" (MileHigh format)
  const p1 = /([A-Z][A-Za-z\s\/\.\-']+?)\s+over\s+([A-Z][A-Za-z\s\/\.\-']+?),\s*(\d+)\s+to\s+(\d+)/g;
  let m;
  while ((m = p1.exec(html)) !== null) {
    results.push({ t1: m[1].trim(), sc1: parseInt(m[3]), t2: m[2].trim(), sc2: parseInt(m[4]), final: true });
  }

  // Pattern 2: "#N Team1 over #N Team2, XX to XX"
  const p2 = /#\d+\s+([A-Z][A-Za-z\s\/\.\-']+?)\s+over\s+#\d+\s+([A-Z][A-Za-z\s\/\.\-']+?),\s*(\d+)\s+to\s+(\d+)/g;
  while ((m = p2.exec(html)) !== null) {
    results.push({ t1: m[1].trim(), sc1: parseInt(m[3]), t2: m[2].trim(), sc2: parseInt(m[4]), final: true });
  }

  // Pattern 3: "Team1 XX, Team2 XX" (score line format)
  const p3 = /([A-Z][A-Za-z\s\/\-']+?)\s+(\d{2,3}),\s*([A-Z][A-Za-z\s\/\-']+?)\s+(\d{2,3})/g;
  while ((m = p3.exec(html)) !== null) {
    const sc1 = parseInt(m[2]), sc2 = parseInt(m[4]);
    if (sc1 >= 10 && sc1 <= 199 && sc2 >= 10 && sc2 <= 199) {
      results.push({ t1: m[1].trim(), sc1, t2: m[3].trim(), sc2, final: true });
    }
  }

  return results;
}

function matchScoresToGames(parsedScores) {
  const matched = {};
  for (const [gameId, [teamA, teamB]] of Object.entries(GAME_MATCHUPS)) {
    for (const s of parsedScores) {
      const fwd = teamMatch(s.t1, teamA) && teamMatch(s.t2, teamB);
      const rev = teamMatch(s.t1, teamB) && teamMatch(s.t2, teamA);
      if (fwd) {
        matched[gameId] = { sc1: s.sc1, sc2: s.sc2, final: s.final };
        break;
      }
      if (rev) {
        matched[gameId] = { sc1: s.sc2, sc2: s.sc1, final: s.final };
        break;
      }
    }
  }
  return matched;
}

async function fetchPage(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ScoreFetcher/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return "";
    return r.text();
  } catch (e) {
    console.log(`Failed to fetch ${url}:`, e.message);
    return "";
  }
}

const handler = async () => {
  console.log("fetch-scores running at", new Date().toISOString());

  try {
    // Fetch all sources
    const [boysToday, girlsToday, boysFri, girlsFri] = await Promise.all([
      fetchPage(SOURCES.boys_today),
      fetchPage(SOURCES.girls_today),
      fetchPage(SOURCES.boys_fri),
      fetchPage(SOURCES.girls_fri),
    ]);

    const combined = [boysToday, girlsToday, boysFri, girlsFri].join("\n\n");
    const parsed = parseScoresFromHTML(combined);
    console.log(`Parsed ${parsed.length} raw score entries`);

    const scores = matchScoresToGames(parsed);
    console.log(`Matched ${Object.keys(scores).length} games`);

    const output = {
      updated: new Date().toISOString(),
      scores,
    };

    // Write to public/scores.json via Netlify Blobs or just return it
    // Since we can't write files directly, we use the response to update via a deploy hook
    // Instead: write to Netlify Blobs (key-value store built into Netlify)
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("scores");
    await store.setJSON("latest", output);
    console.log("Saved scores to Netlify Blobs");

    return { statusCode: 200, body: JSON.stringify(output) };
  } catch (err) {
    console.error("fetch-scores error:", err);
    return { statusCode: 500, body: err.message };
  }
};

export { handler };
export const config = {
  schedule: "*/10 * * * *", // every 10 minutes
};

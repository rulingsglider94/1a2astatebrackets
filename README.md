# 2026 CHSAA 1A/2A Colorado State Basketball Brackets

Live bracket site for Colorado's Class 1A and 2A state basketball tournaments.

**Live site:** https://1a2astatebrackets.netlify.app

## How it works

- `public/index.html` — the bracket page, served statically by Netlify
- `netlify/functions/fetch-scores.mjs` — scheduled function (every 10 min) that scrapes MileHighPrepReport and stores scores in Netlify Blobs
- `netlify/functions/get-scores.mjs` — API endpoint (`/api/scores`) that serves the stored scores to the frontend
- The frontend polls `/api/scores` every 2 minutes and updates scores automatically

## Setup

1. Connect this repo to Netlify
2. Netlify auto-deploys on every push
3. The scheduled function runs automatically — no extra config needed

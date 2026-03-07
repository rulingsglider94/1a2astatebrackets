// netlify/functions/get-scores.mjs
// Called by the frontend to retrieve latest scores from Netlify Blobs

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  try {
    const store = getStore("scores");
    const data = await store.get("latest", { type: "json" });

    if (!data) {
      return new Response(JSON.stringify({ scores: {}, updated: null }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error("get-scores error:", err);
    return new Response(JSON.stringify({ error: err.message, scores: {}, updated: null }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = {
  path: "/api/scores",
};

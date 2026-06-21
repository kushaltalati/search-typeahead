// demo.js — generates a log proving the key behaviours of the system.
// Run the server first (node server.js), then: node demo.js
// Output is printed AND saved to demo-output.log.
//
// It demonstrates the 4 things the assignment asks to "show with sample data or logs":
//   1. Cache hit speedup (low latency)
//   2. Consistent-hashing routing (which node owns which prefix)
//   3. Basic vs recency-aware ranking difference
//   4. Batch writes reducing the number of DB writes

const fs = require("fs");

const BASE = "http://localhost:4000";
const lines = [];
function log(s = "") { console.log(s); lines.push(s); }

const get = (path) => fetch(BASE + path).then((r) => r.json());
const post = (query) =>
  fetch(BASE + "/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log("=".repeat(60));
  log("SEARCH TYPEAHEAD — DEMO LOG");
  log("=".repeat(60));

  // ---- 1. Cache hit speedup --------------------------------------------
  log("\n[1] CACHE HIT SPEEDUP (low latency)");
  const cold = await get("/suggest?q=iphone&rank=basic");
  const warm = await get("/suggest?q=iphone&rank=basic");
  log(`  1st call  -> source: ${cold.source.padEnd(5)}  latency: ${cold.latencyMs} ms`);
  log(`  2nd call  -> source: ${warm.source.padEnd(5)}  latency: ${warm.latencyMs} ms`);
  log(`  speedup   -> ~${Math.round(cold.latencyMs / Math.max(warm.latencyMs, 0.001))}x faster from cache`);

  // ---- 2. Consistent hashing -------------------------------------------
  log("\n[2] CONSISTENT HASHING (prefix -> owner cache node)");
  for (const p of ["iphone", "samsung", "laptop", "java", "python", "tv"]) {
    const d = await get(`/cache/debug?prefix=${p}`);
    log(`  ${p.padEnd(8)} -> ${d.ownerNode}  (${d.status})`);
  }

  // ---- 3. Basic vs recency ranking -------------------------------------
  log("\n[3] BASIC vs RECENCY RANKING for prefix 'iphone'");
  log("    (searching 'iphone 15' several times to make it recently active)");
  for (let i = 0; i < 8; i++) await post("iphone 15");
  await sleep(2500); // let the batch flush + recency update

  const basic = await get("/suggest?q=iphone&rank=basic");
  const recency = await get("/suggest?q=iphone&rank=recency");
  log("  BASIC   top 5: " + basic.suggestions.slice(0, 5).map((s) => s.query).join(", "));
  log("  RECENCY top 5: " + recency.suggestions.slice(0, 5).map((s) => s.query).join(", "));
  log("  -> 'iphone 15' is low by all-time count but jumps up under recency,");
  log("     then fades back as its recent score decays over time.");

  // ---- 4. Batch write reduction ----------------------------------------
  log("\n[4] BATCH WRITES REDUCE DB WRITES");
  const before = await get("/stats");
  log(`  submitting 50 searches (many repeated)...`);
  for (let i = 0; i < 50; i++) await post(i % 2 === 0 ? "laptop" : "headphones");
  await sleep(2500); // let the batch flush
  const after = await get("/stats");
  const submitted = after.batchWrites.searchesReceived - before.batchWrites.searchesReceived;
  const writes = after.db.writes - before.db.writes;
  log(`  searches submitted : ${submitted}`);
  log(`  actual DB writes   : ${writes}`);
  log(`  write reduction    : ${after.batchWrites.writeReductionPct}%  (fewer writes = less load)`);

  // ---- Summary stats ----------------------------------------------------
  log("\n[STATS SNAPSHOT]");
  log(`  cache hit rate : ${after.cache.hitRatePct}%`);
  log(`  latency p50/p95/p99 : ${after.suggestLatencyMs.p50}/${after.suggestLatencyMs.p95}/${after.suggestLatencyMs.p99} ms`);
  log(`  total DB writes : ${after.db.writes}`);
  log("=".repeat(60));

  fs.writeFileSync("demo-output.log", lines.join("\n") + "\n");
  log("\nSaved to demo-output.log");
}

main().catch((e) => {
  log("ERROR: is the server running on :4000?  (node server.js)");
  log(String(e));
  process.exit(1);
});

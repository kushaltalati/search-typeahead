// server.js — Search Typeahead System (intentionally simple, single file).
//
// Pieces (all in-process, no external services):
//   * Primary store        -> a Map (treated as "the database"); we count writes to it.
//   * Distributed cache    -> N in-memory cache nodes chosen by CONSISTENT HASHING.
//   * Batch writes         -> search submissions buffer + aggregate, flush periodically.
//   * Trending + recency   -> time-decayed recent-activity score.
//   * Metrics              -> cache hit rate, db write reduction, suggest latency p50/p95/p99.

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Config (tweak freely)
// ---------------------------------------------------------------------------
const PORT = 4000;
const MAX_SUGGESTIONS = 10;
const CACHE_TTL_MS = 30_000;        // suggestion cache expiry
const CACHE_NODE_COUNT = 3;         // logical/distributed cache nodes
const VNODES_PER_NODE = 50;         // virtual nodes for even consistent-hash spread
const BATCH_SIZE = 50;              // flush when buffer reaches this many submissions
const FLUSH_INTERVAL_MS = 2_000;    // ...or flush on this timer, whichever comes first
const RECENCY_WEIGHT = 8000;        // how strongly recent activity boosts ranking
const RECENCY_HALF_LIFE_MS = 60_000;// recent-activity score halves every minute (so bursts fade)

// ---------------------------------------------------------------------------
// 1) PRIMARY STORE  (this is our "database")
// ---------------------------------------------------------------------------
// query -> { count }
const store = new Map();
let dbWriteOps = 0;   // every record we write during a flush counts as one DB write
let dbReadOps = 0;    // every full scan of the store counts as one DB read

function loadDataset() {
  const file = path.join(__dirname, "data.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const { query, count } of rows) store.set(query, { count });
  console.log(`Loaded ${store.size} queries into primary store.`);
}

// ---------------------------------------------------------------------------
// 2) RECENT ACTIVITY (for trending + recency-aware ranking)
// ---------------------------------------------------------------------------
// query -> { score, ts }  ; score decays exponentially with time.
const recent = new Map();

function decayed(entry, now) {
  if (!entry) return 0;
  const age = now - entry.ts;
  return entry.score * Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}
function bumpRecent(query, delta, now) {
  const cur = decayed(recent.get(query), now);
  recent.set(query, { score: cur + delta, ts: now });
}
function recentScore(query, now) {
  return decayed(recent.get(query), now);
}

// ---------------------------------------------------------------------------
// 3) CONSISTENT HASHING + DISTRIBUTED CACHE
// ---------------------------------------------------------------------------
function hash32(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Each cache node is its own Map -> simulates a separate cache server.
const cacheNodes = Array.from({ length: CACHE_NODE_COUNT }, (_, i) => ({
  name: `cache-node-${i}`,
  data: new Map(), // prefix -> { suggestions, expires }
}));

// Build the hash ring: sorted [{ hash, nodeIndex }] with virtual nodes.
let ring = [];
function buildRing() {
  ring = [];
  cacheNodes.forEach((node, idx) => {
    for (let v = 0; v < VNODES_PER_NODE; v++) {
      ring.push({ hash: hash32(`${node.name}#${v}`), nodeIndex: idx });
    }
  });
  ring.sort((a, b) => a.hash - b.hash);
}
function nodeForKey(key) {
  const h = hash32(key);
  // first ring point with hash >= h, else wrap to the first point
  let lo = 0, hi = ring.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid].hash >= h) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  if (lo === ring.length) ans = 0;
  return cacheNodes[ring[ans % ring.length].nodeIndex];
}

let cacheHits = 0, cacheMisses = 0;

// The cache NODE is chosen by the prefix (consistent hashing owns a "prefix key").
// The storage key inside the node also includes the ranking mode, so basic and
// recency results don't clobber each other.
function storeKey(prefix, mode) { return `${mode}|${prefix}`; }

function cacheGet(prefix, mode) {
  const node = nodeForKey(prefix);
  const key = storeKey(prefix, mode);
  const entry = node.data.get(key);
  if (entry && entry.expires > Date.now()) return { node, hit: true, value: entry.suggestions };
  if (entry) node.data.delete(key); // expired
  return { node, hit: false, value: null };
}
function cacheSet(prefix, mode, suggestions) {
  const node = nodeForKey(prefix);
  node.data.set(storeKey(prefix, mode), { suggestions, expires: Date.now() + CACHE_TTL_MS });
}
function cacheInvalidateForQuery(query) {
  // A changed query can affect any prefix that is a prefix of it. Drop those
  // (keys look like "mode|prefix", so compare against the prefix part).
  for (const node of cacheNodes) {
    for (const key of node.data.keys()) {
      const prefix = key.slice(key.indexOf("|") + 1);
      if (query.startsWith(prefix)) node.data.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// 4) SUGGESTION COMPUTATION
// ---------------------------------------------------------------------------
function computeSuggestions(prefix, mode) {
  const now = Date.now();
  dbReadOps++; // a scan of the primary store
  const matches = [];
  for (const [query, rec] of store) {
    if (query.startsWith(prefix)) {
      const score = mode === "recency"
        ? rec.count + RECENCY_WEIGHT * recentScore(query, now)
        : rec.count;
      matches.push({ query, count: rec.count, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, MAX_SUGGESTIONS)
    .map(({ query, count }) => ({ query, count }));
}

// ---------------------------------------------------------------------------
// 5) BATCH WRITES
// ---------------------------------------------------------------------------
const buffer = new Map(); // query -> pending count delta
let searchesReceived = 0; // total submissions (= writes we'd do WITHOUT batching)
let flushCount = 0;

function enqueueSearch(query) {
  searchesReceived++;
  buffer.set(query, (buffer.get(query) || 0) + 1);
  if (buffer.size >= BATCH_SIZE) flush();
}

function flush() {
  if (buffer.size === 0) return;
  const now = Date.now();
  for (const [query, delta] of buffer) {
    const rec = store.get(query) || { count: 0 };
    rec.count += delta;
    store.set(query, rec);          // write to primary store
    dbWriteOps++;                   // one DB write per aggregated record
    bumpRecent(query, delta, now);  // feed trending / recency
    cacheInvalidateForQuery(query); // keep cache fresh when rankings change
  }
  flushCount++;
  buffer.clear();
}
setInterval(flush, FLUSH_INTERVAL_MS);

// ---------------------------------------------------------------------------
// 6) METRICS (latency)
// ---------------------------------------------------------------------------
const latencies = []; // recent /suggest durations (ms)
function recordLatency(ms) {
  latencies.push(ms);
  if (latencies.length > 2000) latencies.shift();
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(3);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// GET /suggest?q=<prefix>&rank=basic|recency
app.get("/suggest", (req, res) => {
  const start = process.hrtime.bigint();
  const raw = (req.query.q || "").toString();
  const mode = req.query.rank === "basic" ? "basic" : "recency"; // recency default
  const prefix = raw.trim().toLowerCase();

  if (!prefix) {
    recordLatency(Number(process.hrtime.bigint() - start) / 1e6);
    return res.json({ prefix: "", source: "none", suggestions: [] });
  }

  const cached = cacheGet(prefix, mode);
  let suggestions, source;
  if (cached.hit) {
    suggestions = cached.value;
    source = "cache";
  } else {
    suggestions = computeSuggestions(prefix, mode);
    cacheSet(prefix, mode, suggestions);
    source = "store";
  }
  cached.hit ? cacheHits++ : cacheMisses++;

  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  recordLatency(ms);
  res.json({ prefix, rank: mode, source, node: cached.node.name, latencyMs: +ms.toFixed(3), suggestions });
});

// POST /search { query }  -> dummy response + queue the count update (batched)
app.post("/search", (req, res) => {
  const query = ((req.body && req.body.query) || "").toString().trim().toLowerCase();
  if (!query) return res.status(400).json({ error: "query is required" });
  enqueueSearch(query);
  res.json({ message: "Searched", query });
});

// GET /trending  -> top queries by recent (decayed) activity
app.get("/trending", (req, res) => {
  const now = Date.now();
  const list = [...recent.keys()]
    .map((q) => ({ query: q, recentScore: +recentScore(q, now).toFixed(2) }))
    .filter((x) => x.recentScore > 0)
    .sort((a, b) => b.recentScore - a.recentScore)
    .slice(0, MAX_SUGGESTIONS);
  res.json({ trending: list });
});

// GET /cache/debug?prefix=<prefix>  -> which node owns it + hit/miss
app.get("/cache/debug", (req, res) => {
  const prefix = (req.query.prefix || "").toString().trim().toLowerCase();
  const mode = req.query.rank === "basic" ? "basic" : "recency";
  const node = nodeForKey(prefix);                 // consistent hashing -> owner node
  const entry = node.data.get(storeKey(prefix, mode));
  const hit = !!(entry && entry.expires > Date.now());
  res.json({
    prefix,
    rank: mode,
    ownerNode: node.name,
    status: hit ? "HIT" : "MISS",
    expiresInMs: hit ? entry.expires - Date.now() : null,
    ring: cacheNodes.map((n) => ({ node: n.name, cachedKeys: n.data.size })),
  });
});

// GET /stats  -> performance report numbers
app.get("/stats", (req, res) => {
  const totalReqs = cacheHits + cacheMisses;
  const hitRate = totalReqs ? (cacheHits / totalReqs) : 0;
  // Without batching we'd write once per submission. With batching we wrote dbWriteOps times.
  const writeReduction = searchesReceived ? 1 - dbWriteOps / searchesReceived : 0;
  res.json({
    cache: {
      hits: cacheHits, misses: cacheMisses,
      hitRatePct: +(hitRate * 100).toFixed(1),
      nodes: cacheNodes.map((n) => ({ node: n.name, cachedPrefixes: n.data.size })),
    },
    batchWrites: {
      searchesReceived,
      dbWriteOps,
      flushCount,
      pendingInBuffer: buffer.size,
      writeReductionPct: +(writeReduction * 100).toFixed(1),
    },
    db: { reads: dbReadOps, writes: dbWriteOps, storeSize: store.size },
    suggestLatencyMs: {
      samples: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadDataset();
buildRing();
app.listen(PORT, () => {
  console.log(`Search Typeahead running -> http://localhost:${PORT}`);
  console.log(`Cache nodes: ${cacheNodes.map((n) => n.name).join(", ")} (consistent hashing)`);
});

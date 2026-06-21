# How This Works — Simple Explanation (for the viva)

> Read this once and you can explain the whole project. Plain English, no jargon.
> Every section also says **WHY** I built it that way (that's what they grade you on).

---

## 30-second pitch (memorise this)

> "It's a search autocomplete. As you type, it shows the 10 most popular matching
> queries. Popular queries are stored with a count. To make it fast, finished
> suggestion lists are kept in a cache that's split across 3 cache nodes, and a
> consistent-hashing function decides which node holds which prefix. When you submit
> a search, I don't write to the store immediately — I collect searches in a buffer
> and write them in batches to cut down writes. Trending and ranking also use a
> 'recent activity' score that fades over time, so a query that was hot for a minute
> doesn't stay on top forever."

That single paragraph covers all 6 things they want you to explain.

---

## 1. What data I store (data model)

A simple table of `query → count`. In code it's a `Map`:

```js
const store = new Map();   // "iphone" -> { count: 100000 }
```

**WHY:** A Map gives instant `O(1)` lookup by query and is the simplest possible
"database". The assignment is about the *system design* (caching, hashing, batching),
not about which database engine I picked.

---

## 2. How suggestions are found

When you type a prefix (e.g. "iph"), I go through the store, keep the queries that
**start with** that prefix, sort them by count (highest first), and return the top 10.

```js
for (const [query, rec] of store)
  if (query.startsWith(prefix)) matches.push(...);
matches.sort((a,b) => b.score - a.score);
return matches.slice(0, 10);
```

**WHY a simple scan:** going through 110k rows takes only a few milliseconds, and the
cache (next point) makes repeat lookups basically free — so a fancy data structure
(like a trie) wasn't worth the extra complexity.

---

## 3. Caching (for speed)

The first time someone types "iph", I compute the top-10 and **save that list in a
cache**. Next time anyone types "iph", I return the saved list instead of scanning
again. Each cached entry expires after 30 seconds (TTL).

- First call: `source: store` (~5 ms)
- Repeat call: `source: cache` (~0.03 ms) → about 200× faster.

**WHY:** Most people type the same popular prefixes. Caching those answers makes the
common case extremely fast. TTL means stale data eventually clears itself.

---

## 4. Distributed cache + consistent hashing

Instead of one cache, I use **3 cache nodes** (just 3 Maps, pretending to be 3 cache
servers). A hash function decides which node "owns" a given prefix:

```js
const node = nodeForKey(prefix);   // always sends "iph" to the same node
```

I use **consistent hashing**: all nodes are placed on an imaginary ring, and each
prefix lands on the next node clockwise.

**WHY consistent hashing (this is the key point):** if I add or remove a cache node,
only about 1/N of the keys move to a new node — not all of them. With plain
`hash % 3`, changing the node count would reshuffle *every* key and wipe the whole
cache. Consistent hashing avoids that.

You can see it live: `GET /cache/debug?prefix=iph` tells you which node owns it and
whether it's a HIT or MISS.

---

## 5. Trending + recency-aware ranking

I keep a second small table: `query → recent activity score`. Every time a query is
searched, its score goes up — but the score **decays** (halves every 60 seconds).

- **Trending** = the queries with the highest recent score right now.
- **Ranking** has two modes (same `/suggest` API, `rank=basic` or `rank=recency`):
  - `basic` → sort by all-time count only.
  - `recency` → `score = count + (weight × recent score)`, so a query being searched a
    lot *right now* gets pushed up.

**WHY the decay:** it stops a query that was popular for only a short burst from
staying at the top forever. As searching stops, the boost fades and it drops back to
its normal popularity. When ranking changes, I clear the affected cached prefixes so
the new order shows up.

**Demo I can show:** I searched "iphone 15" a few times; under `basic` it's around
rank 9, but under `recency` it jumps to **#1** — then falls back as the score decays.

---

## 6. Batch writes

When you submit a search, I do **not** write to the store right away. I put it in a
buffer. The buffer is flushed (written) either every 2 seconds **or** once it holds 50
searches — whichever comes first. Repeated queries are merged before writing.

```js
buffer.set(query, (buffer.get(query) || 0) + 1);   // collect + merge
// flush(): apply all buffered counts to the store at once
```

**WHY:** without batching, every single search = 1 write. With batching, 60 searches
might become ~33 writes (see `/stats` → ~46% fewer writes). Fewer writes = less load.

**The trade-off I must mention:** if the app crashes *before* a flush, the buffered
searches are lost. That's acceptable here because these are just popularity counters —
being slightly approximate is fine. A durable log/queue would fix it but adds
complexity.

---

## 7. The APIs (all 5)

| API | What it does |
|---|---|
| `GET /suggest?q=iph&rank=recency` | top-10 suggestions for a prefix |
| `POST /search {query}` | returns `{"message":"Searched"}` and queues a count update |
| `GET /trending` | most-active queries right now |
| `GET /cache/debug?prefix=iph` | which cache node owns the prefix + HIT/MISS |
| `GET /stats` | cache hit rate, p95 latency, write reduction, DB writes |

---

## 8. Likely viva questions + 1-line answers

- **Why a Map and not a real DB?** Simplicity; the focus is the data-system design, and a Map lets me clearly count reads/writes.
- **Why consistent hashing?** Adding/removing a cache node only remaps ~1/N keys instead of all of them.
- **How do you keep the cache fresh?** 30s expiry (TTL) plus active invalidation: when a query's count changes on flush, I drop the cached prefixes it affects.
- **How does recency avoid permanent over-ranking?** The recent score decays exponentially (half-life 60s), so short bursts fade.
- **What happens if it crashes mid-batch?** Buffered counts are lost (at-most-once); fine for approximate popularity counters.
- **How is it low-latency?** Cache-first: repeat prefixes return in ~0.03 ms; `/stats` reports p95.

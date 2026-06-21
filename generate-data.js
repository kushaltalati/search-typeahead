// generate-data.js
// Builds a synthetic open dataset of 100k+ search queries with counts.
// Output: data.json  ->  [{ "query": "iphone 15", "count": 85000 }, ...]
//
// Why synthetic: the assignment allows ANY dataset and lets us derive counts.
// This keeps the project fully self-contained (no downloads) and reproducible.

const fs = require("fs");
const path = require("path");

// Building blocks combined into realistic-looking search queries.
const brands = ["apple", "samsung", "sony", "dell", "hp", "lenovo", "nike",
  "adidas", "google", "microsoft", "amazon", "logitech", "canon", "lg",
  "asus", "acer", "bosch", "philips", "xiaomi", "oneplus"];

const products = ["iphone", "laptop", "headphones", "charger", "monitor",
  "keyboard", "mouse", "tv", "camera", "watch", "shoes", "tablet", "router",
  "speaker", "earbuds", "ssd", "printer", "webcam", "microphone", "drone"];

const topics = ["java tutorial", "python tutorial", "javascript", "react",
  "node js", "system design", "machine learning", "data structures",
  "sql query", "docker", "kubernetes", "aws", "git", "linux commands",
  "html css", "rest api", "algorithms", "interview questions", "leetcode",
  "spring boot"];

const modifiers = ["", " 15", " pro", " max", " 2024", " cheap", " best",
  " review", " price", " under 500", " wireless", " gaming", " for sale",
  " near me", " online", " deals", " refurbished", " 4k", " mini", " plus",
  " case", " stand", " bundle", " black", " white"];

// Deterministic seeded RNG so the dataset is reproducible.
// xorshift32 with Math.imul to stay within 32-bit integer math (no float overflow).
let seed = 42 | 0;
function rand() {
  seed ^= seed << 13; seed |= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed |= 0;
  return ((seed >>> 0) % 1000000) / 1000000;
}

const counts = new Map();
function add(q, c) {
  q = q.trim().toLowerCase();
  if (!q) return;
  counts.set(q, (counts.get(q) || 0) + c);
}

// 1) brand + product + modifier combinations
for (const b of brands) {
  for (const p of products) {
    for (const m of modifiers) {
      // Zipf-ish: shorter queries are far more popular.
      const base = Math.floor(100000 / (1 + (b + p + m).length));
      const noise = Math.floor(rand() * base);
      add(`${b} ${p}${m}`, base + noise);
    }
  }
}

// 2) product alone + modifiers (very popular head terms)
for (const p of products) {
  for (const m of modifiers) {
    add(`${p}${m}`, 50000 + Math.floor(rand() * 50000));
  }
}

// 3) learning/tech topics + modifiers
for (const t of topics) {
  for (const m of modifiers) {
    add(`${t}${m}`, 20000 + Math.floor(rand() * 40000));
  }
}

// 4) pad with extra combos until we comfortably exceed 100k unique queries
while (counts.size < 110000) {
  const b = brands[Math.floor(rand() * brands.length)];
  const p = products[Math.floor(rand() * products.length)];
  const m = modifiers[Math.floor(rand() * modifiers.length)];
  const extra = `${b} ${p}${m} ${Math.floor(rand() * 9999)}`;
  add(extra, 1 + Math.floor(rand() * 5000));
}

const rows = [...counts.entries()].map(([query, count]) => ({ query, count }));
rows.sort((a, b) => b.count - a.count);

const out = path.join(__dirname, "data.json");
fs.writeFileSync(out, JSON.stringify(rows));
console.log(`Wrote ${rows.length} queries to ${out}`);
console.log("Top 5:", rows.slice(0, 5));

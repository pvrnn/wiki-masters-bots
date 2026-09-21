#!/usr/bin/env node
// Reads data/collection-raw.json (written by fetch-collection.mjs) and
// produces data/collection-grouped.json: cards grouped by rarity, then by a
// theme derived from each card's Wikipedia category (classify-theme.mjs).
//
// Run from the repo root:
//   node .claude/skills/collection-cleanup/scripts/build-grouped.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyTheme } from './classify-theme.mjs';
import { classifyOrigin } from './classify-origin.mjs';

const REPO_ROOT = resolve(new URL('../../../../', import.meta.url).pathname);
const rawPath = resolve(REPO_ROOT, 'data/collection-raw.json');
const outPath = resolve(REPO_ROOT, 'data/collection-grouped.json');

let raw;
try {
  raw = JSON.parse(readFileSync(rawPath, 'utf8'));
} catch (error) {
  console.error(`Could not read ${rawPath}: ${error.message}`);
  console.error('Run fetch-collection.mjs first.');
  process.exit(1);
}

// Empirically observed order for sort=rarity (highest first), from a live
// collection: L > UR > SR > R > PC > C. If wiki-masters adds a rarity tier
// this list doesn't know about, unknownRarities below will report it instead
// of silently mis-sorting or dropping cards.
const RARITY_ORDER = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
const rarityRank = new Map(RARITY_ORDER.map((r, i) => [r, i]));

const unknownRarities = new Set();
function rankOf(rarity) {
  if (rarityRank.has(rarity)) return rarityRank.get(rarity);
  unknownRarities.add(rarity);
  return RARITY_ORDER.length; // unknown tiers sort after all known ones
}

// rarity -> theme key -> { label, cards: [] }
const buckets = new Map();
const originCounts = { france: 0, etranger: 0, inconnu: 0 };

for (const item of raw.collection) {
  const card = item.card ?? {};
  const rarity = card.rarity ?? '?';
  const theme = classifyTheme(card.category, card.wikipedia_title);
  const origin = classifyOrigin(card.category, card.wikipedia_title);
  originCounts[origin] += 1;

  if (!buckets.has(rarity)) buckets.set(rarity, new Map());
  const byTheme = buckets.get(rarity);
  if (!byTheme.has(theme.key)) byTheme.set(theme.key, { label: theme.label, cards: [] });

  byTheme.get(theme.key).cards.push({
    // Both ids are kept, but serve-review.mjs's discard call uses row_id
    // (the collection row's own id) -- see that file for why.
    row_id: item.id,
    card_id: item.card_id,
    title: card.wikipedia_title ?? '(untitled)',
    category: card.category ?? null,
    rarity,
    // 'france' | 'etranger' | 'inconnu' -- see classify-origin.mjs. A
    // separate axis from theme: cuts across Géographie, Personnalités,
    // Transports etc. rather than being a theme of its own.
    origin,
    atk: card.atk ?? null,
    def: card.def ?? null,
    q_score: card.q_score ?? null,
    pageviews: card.pageviews ?? null,
    image_url: card.image_url ?? null,
    wikipedia_url: card.wikipedia_url ?? null,
    starred: Boolean(item.starred),
    obtained_at: item.obtained_at ?? null,
  });
}

const rarities = [...buckets.keys()].sort((a, b) => rankOf(a) - rankOf(b));

const groups = rarities.map((rarity) => {
  const byTheme = buckets.get(rarity);
  // Themes ordered by size, largest first, except "Autres / non classé"
  // which always sorts last regardless of size -- it's the catch-all, not a
  // real theme, and burying it at the end keeps the meaningful groups first.
  const themeEntries = [...byTheme.entries()].sort((a, b) => {
    if (a[0] === 'autres') return 1;
    if (b[0] === 'autres') return -1;
    return b[1].cards.length - a[1].cards.length;
  });

  const themes = themeEntries.map(([key, { label, cards }]) => ({
    key,
    label,
    count: cards.length,
    // Highest q_score (roughly: how notable/valuable the underlying
    // Wikipedia topic is) first within a theme, so the most interesting
    // cards in a group surface at the top.
    cards: cards.sort((a, b) => (b.q_score ?? 0) - (a.q_score ?? 0)),
  }));

  const count = themes.reduce((sum, t) => sum + t.count, 0);
  return { rarity, count, themes };
});

const total = groups.reduce((sum, g) => sum + g.count, 0);

writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceCollectionFetchedAt: raw.fetchedAt,
      total,
      rarityOrder: RARITY_ORDER,
      groups,
    },
    null,
    2,
  ),
);

console.log(`Wrote ${outPath}`);
console.log(`${total} cards across ${groups.length} rarity tiers.`);
for (const g of groups) {
  console.log(`  ${g.rarity.padEnd(3)} ${String(g.count).padStart(4)} cards, ${g.themes.length} themes`);
}
console.log(
  `\nOrigine: France ${originCounts.france} · Étranger ${originCounts.etranger} · ` +
    `Inconnu ${originCounts.inconnu} (${((originCounts.inconnu / total) * 100).toFixed(1)}%)`,
);
const autresTotal = groups.flatMap((g) => g.themes).find((t) => t.key === 'autres');
if (autresTotal) {
  const totalAutres = groups
    .flatMap((g) => g.themes)
    .filter((t) => t.key === 'autres')
    .reduce((s, t) => s + t.count, 0);
  const pct = ((totalAutres / total) * 100).toFixed(1);
  console.log(
    `\n"Autres / non classé": ${totalAutres} cards (${pct}%). If this is large, extend ` +
      `classify-theme.mjs's rules using data/collection-categories.json.`,
  );
}
if (unknownRarities.size > 0) {
  console.warn(`\nWARNING: unrecognised rarity code(s) not in RARITY_ORDER: ${[...unknownRarities].join(', ')}`);
}

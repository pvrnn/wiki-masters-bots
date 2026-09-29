#!/usr/bin/env node
// Reads data/collection-raw.json (written by fetch-collection.mjs) and
// produces data/collection-grouped.json: cards grouped by rarity, then by a
// theme derived from each card's Wikipedia category (classify-theme.mjs).
//
// If data/collection-ai.json exists (written by classify-laya.py), its answers
// fill the gaps the lookup table and the regex rules leave -- a theme for
// cards that would land in "Autres", and a real country instead of just
// France / Étranger -- and feed each card's keep score. Without that file
// every card is classified exactly as before; only the keep score is added.
//
// Run from the repo root:
//   node .claude/skills/collection-cleanup/scripts/build-grouped.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyTheme, THEMES, FALLBACK_THEME } from './classify-theme.mjs';
import { classifyOrigin } from './classify-origin.mjs';

const REPO_ROOT = resolve(new URL('../../../../', import.meta.url).pathname);
const rawPath = resolve(REPO_ROOT, 'data/collection-raw.json');
const outPath = resolve(REPO_ROOT, 'data/collection-grouped.json');
const lookupPath = resolve(REPO_ROOT, '.claude/skills/collection-cleanup/category-lookup.json');
const aiPath = resolve(REPO_ROOT, 'data/collection-ai.json');
const prefsPath = resolve(REPO_ROOT, 'data/keep-preferences.json');
const prefsExamplePath = resolve(REPO_ROOT, '.claude/skills/collection-cleanup/preferences.example.json');
const countriesPath = resolve(REPO_ROOT, '.claude/skills/collection-cleanup/countries.json');

// Laya ships over-confident (its README says so), so an answer is only used
// above these calibrated answer_confidence floors. country_conf is the
// probability of the whole continent -> subregion -> country path, hence the
// lower bar. Tune both against a hand spot-check, not by feel.
const LAYA_THEME_MIN_CONFIDENCE = 0.6;
const LAYA_COUNTRY_MIN_CONFIDENCE = 0.4;

// key -> label, so a lookup hit (which only stores the key, to stay a plain
// flat JSON file) can still produce the {key, label} pair classifyTheme
// returns.
const THEME_LABEL = new Map([...THEMES, FALLBACK_THEME].map((t) => [t.key, t.label]));

/**
 * Direct, agent-curated classifications ("The Residents are American",
 * "Yannick Noah is French") for exactly the categories the regex
 * classifiers cannot place -- things no keyword list can know without
 * external knowledge. Checked FIRST; classify-theme.mjs/classify-origin.mjs
 * are the fallback for anything not in here yet (new categories from future
 * pulls, or ones not worth a person's time to look up).
 *
 * Committed to the repo (unlike data/*.json): these are facts about the
 * world, not personal collection data, and are exactly as reusable for
 * anyone else's wiki-masters collection as the regex rules are.
 */
let lookup = {};
try {
  lookup = JSON.parse(readFileSync(lookupPath, 'utf8'));
} catch {
  // Missing/corrupt lookup file is not fatal -- everything just falls back
  // to the regex classifiers, same as before this existed.
}

/** Parsed JSON, or `fallback` if the file is missing/corrupt -- every input below is optional. */
function readOptionalJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

// card_id -> Laya's answers. See classify-laya.py for the fields.
const aiCards = readOptionalJson(aiPath, { cards: {} }).cards ?? {};
const countriesData = readOptionalJson(countriesPath, { names: {}, continents: [] });
const countryNames = countriesData.names ?? {};

// Country names spelled out in the category text ("ville de Norvège") are a
// literal fact, so they beat Laya's guess. Longest name first, so "Guinée
// équatoriale" wins over "Guinée". The boundaries are Unicode-letter
// lookarounds rather than \b, which never fires next to an accented letter
// (see classify-theme.mjs), and they keep "Oman" from matching inside
// "roman" or "Chine" inside "machine".
const COUNTRY_NAME_PATTERNS = (countriesData.continents ?? [])
  .flatMap((c) => c.subregions.flatMap((s) => s.countries))
  .filter(([code, name]) => code !== 'FR' && !name.includes('historique'))
  .map(([code, name]) => [code, name.split(' (')[0]])
  .sort((a, b) => b[1].length - a[1].length)
  .map(([code, name]) => [code, new RegExp(`(?<!\\p{L})${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'iu')]);

function countryFromText(text) {
  if (!text) return null;
  for (const [code, re] of COUNTRY_NAME_PATTERNS) {
    if (re.test(text)) return code;
  }
  return null;
}
const prefs = { ...readOptionalJson(prefsExamplePath, {}), ...readOptionalJson(prefsPath, {}) };

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
const themeSources = { lookup: 0, regex: 0, laya: 0, none: 0 };
const countryCounts = new Map();
const allCards = [];

let lookupHits = 0;

/**
 * Picks the country, keeping lookup/regex's France-vs-foreign call in charge:
 * those read the category text literally ("joueur de tennis français"), so a
 * Laya country that contradicts them is dropped rather than trusted. A
 * country named in the text itself comes next (conf 1: it's a literal match),
 * and Laya's answer only fills what's left.
 */
function resolveCountry(baseOrigin, text, ai) {
  const layaCode =
    ai && ai.country_conf >= LAYA_COUNTRY_MIN_CONFIDENCE && ai.country !== 'NONE' ? ai.country : null;
  const layaConf = layaCode ? ai.country_conf : null;
  if (baseOrigin === 'france') return { code: 'FR', conf: layaCode === 'FR' ? layaConf : null, origin: 'france' };
  const textCode = countryFromText(text);
  if (textCode) return { code: textCode, conf: 1, origin: 'etranger' };
  if (baseOrigin === 'etranger') {
    return layaCode && layaCode !== 'FR' && layaCode !== 'INT'
      ? { code: layaCode, conf: layaConf, origin: 'etranger' }
      : { code: null, conf: null, origin: 'etranger' };
  }
  if (!layaCode) return { code: null, conf: null, origin: 'inconnu' };
  const origin = layaCode === 'FR' ? 'france' : layaCode === 'INT' ? 'inconnu' : 'etranger';
  return { code: layaCode, conf: layaConf, origin };
}

for (const item of raw.collection) {
  const card = item.card ?? {};
  const rarity = card.rarity ?? '?';

  // Same key resolution classifyTheme/classifyOrigin use internally
  // (category, falling back to title when category is null), so a lookup
  // entry lines up with whichever text the regex path would have matched
  // against too.
  const lookupKey = card.category?.trim() || card.wikipedia_title?.trim();
  const hit = lookupKey ? lookup[lookupKey] : undefined;

  let theme;
  let origin;
  if (hit) {
    lookupHits += 1;
    const [themeKey, hitOrigin] = hit;
    theme = { key: themeKey, label: THEME_LABEL.get(themeKey) ?? themeKey };
    origin = hitOrigin;
  } else {
    theme = classifyTheme(card.category, card.wikipedia_title);
    origin = classifyOrigin(card.category, card.wikipedia_title);
  }

  // Laya only fills gaps: the lookup is hand-checked facts and a regex hit is
  // a literal match on the category text, both more precise than a
  // zero-shot model.
  const ai = aiCards[item.card_id];
  let themeSource = hit ? 'lookup' : theme.key !== 'autres' ? 'regex' : 'none';
  if (
    themeSource === 'none' &&
    ai &&
    ai.theme !== 'autres' &&
    THEME_LABEL.has(ai.theme) &&
    ai.theme_conf >= LAYA_THEME_MIN_CONFIDENCE
  ) {
    theme = { key: ai.theme, label: THEME_LABEL.get(ai.theme) };
    themeSource = 'laya';
  }
  themeSources[themeSource] += 1;

  const country = resolveCountry(origin, lookupKey, ai);
  origin = country.origin;
  originCounts[origin] += 1;
  if (country.code) countryCounts.set(country.code, (countryCounts.get(country.code) ?? 0) + 1);

  if (!buckets.has(rarity)) buckets.set(rarity, new Map());
  const byTheme = buckets.get(rarity);
  if (!byTheme.has(theme.key)) byTheme.set(theme.key, { label: theme.label, cards: [] });

  const cardOut = {
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
    // ISO code from countries.json, 'INT' for international subjects, or
    // null when neither the rules nor a confident Laya answer know it.
    country: country.code,
    country_label: country.code ? countryNames[country.code] ?? country.code : null,
    country_conf: country.conf,
    theme_key: theme.key,
    theme_source: themeSource,
    ai_interest: ai?.interest ?? null,
    atk: card.atk ?? null,
    def: card.def ?? null,
    q_score: card.q_score ?? null,
    pageviews: card.pageviews ?? null,
    image_url: card.image_url ?? null,
    wikipedia_url: card.wikipedia_url ?? null,
    starred: Boolean(item.starred),
    obtained_at: item.obtained_at ?? null,
  };
  byTheme.get(theme.key).cards.push(cardOut);
  allCards.push(cardOut);
}

computeKeepScores(allCards);

/**
 * keep_score, 0-100: how much a card is worth keeping. A weighted mean of up
 * to three parts, each 0-1 -- a part with no data (no Laya file, no
 * preferences set) drops out and the others are re-weighted, rather than
 * counting as a neutral 0.5:
 *   stats  rarity, q_score, pageviews and atk+def, as percentiles of this collection
 *   ai     Laya's interest answer
 *   prefs  favourite/disliked themes and countries from data/keep-preferences.json
 * Then every extra copy of a card you already own is multiplied by
 * prefs.duplicateFactor, and a starred card is always 100.
 *
 * Computed here, not in classify-laya.py, so the weights can be tuned and
 * re-applied in a second without re-running the model.
 */
function computeKeepScores(cards) {
  const weights = { stats: 45, ai: 25, prefs: 30, ...(prefs.weights ?? {}) };
  const duplicateFactor = typeof prefs.duplicateFactor === 'number' ? prefs.duplicateFactor : 0.3;
  const lists = {
    favThemes: new Set(prefs.favoriteThemes ?? []),
    badThemes: new Set(prefs.dislikedThemes ?? []),
    favCountries: new Set(prefs.favoriteCountries ?? []),
    badCountries: new Set(prefs.dislikedCountries ?? []),
  };
  const hasPrefs = Object.values(lists).some((s) => s.size > 0);

  const pct = {
    q: percentileOf(cards.map((c) => c.q_score)),
    views: percentileOf(cards.map((c) => c.pageviews)),
    power: percentileOf(cards.map(power)),
  };

  for (const c of cards) {
    const rank = rarityRank.get(c.rarity);
    const stats = weightedMean([
      [0.4, rank === undefined ? null : 1 - rank / (RARITY_ORDER.length - 1)],
      [0.3, pct.q(c.q_score)],
      [0.15, pct.views(c.pageviews)],
      [0.15, pct.power(power(c))],
    ]);
    const ai = typeof c.ai_interest === 'number' ? c.ai_interest / 100 : null;
    let pref = null;
    if (hasPrefs) {
      pref = 0.5;
      if (lists.favThemes.has(c.theme_key)) pref += 0.5;
      if (lists.badThemes.has(c.theme_key)) pref -= 0.5;
      if (c.country && lists.favCountries.has(c.country)) pref += 0.5;
      if (c.country && lists.badCountries.has(c.country)) pref -= 0.5;
      pref = Math.min(1, Math.max(0, pref));
    }
    const score = weightedMean([
      [weights.stats, stats],
      [weights.ai, ai],
      [weights.prefs, pref],
    ]);
    c.keep_score = score === null ? null : Math.round(score * 100);
    c.keep_breakdown = {
      stats: toPct(stats),
      ai: toPct(ai),
      prefs: toPct(pref),
      duplicate: false,
    };
  }

  // Duplicates: the best copy keeps its score, every other copy is marked down.
  const copies = new Map();
  for (const c of cards) {
    if (!copies.has(c.card_id)) copies.set(c.card_id, []);
    copies.get(c.card_id).push(c);
  }
  for (const group of copies.values()) {
    if (group.length < 2) continue;
    group.sort(
      (a, b) =>
        Number(b.starred) - Number(a.starred) ||
        (b.keep_score ?? 0) - (a.keep_score ?? 0) ||
        String(a.obtained_at).localeCompare(String(b.obtained_at)),
    );
    for (const extra of group.slice(1)) {
      extra.keep_breakdown.duplicate = true;
      if (extra.keep_score !== null) extra.keep_score = Math.round(extra.keep_score * duplicateFactor);
    }
  }

  for (const c of cards) {
    if (c.starred) c.keep_score = 100;
  }
}

function power(c) {
  return typeof c.atk === 'number' || typeof c.def === 'number' ? (c.atk ?? 0) + (c.def ?? 0) : null;
}

/** Returns v -> share of values <= v (0-1), or null for a missing v. */
function percentileOf(values) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  return (v) => {
    if (typeof v !== 'number' || sorted.length === 0) return null;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo / sorted.length;
  };
}

/** Mean of [weight, value] pairs, skipping null values; null if none are left. */
function weightedMean(pairs) {
  let sum = 0;
  let total = 0;
  for (const [w, v] of pairs) {
    if (v === null || !(w > 0)) continue;
    sum += w * v;
    total += w;
  }
  return total > 0 ? sum / total : null;
}

function toPct(v) {
  return v === null ? null : Math.round(v * 100);
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
console.log(`Lookup table: ${lookupHits}/${total} cards classified from category-lookup.json (${Object.keys(lookup).length} entries known)`);
console.log(`${total} cards across ${groups.length} rarity tiers.`);
for (const g of groups) {
  console.log(`  ${g.rarity.padEnd(3)} ${String(g.count).padStart(4)} cards, ${g.themes.length} themes`);
}
console.log(
  `\nOrigine: France ${originCounts.france} · Étranger ${originCounts.etranger} · ` +
    `Inconnu ${originCounts.inconnu} (${((originCounts.inconnu / total) * 100).toFixed(1)}%)`,
);
if (Object.keys(aiCards).length > 0) {
  console.log(
    `\nThème : lookup ${themeSources.lookup} · regex ${themeSources.regex} · ` +
      `Laya ${themeSources.laya} · non classé ${themeSources.none}`,
  );
  const topCountries = [...countryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`Pays (top 15) : ${topCountries.map(([code, n]) => `${countryNames[code] ?? code} ${n}`).join(', ')}`);
}
const histogram = [0, 0, 0, 0, 0];
for (const c of allCards) {
  if (c.keep_score !== null) histogram[Math.min(4, Math.floor(c.keep_score / 20))] += 1;
}
console.log(
  `Score de conservation : ${['0-19', '20-39', '40-59', '60-79', '80-100']
    .map((label, i) => `${label}: ${histogram[i]}`)
    .join(' · ')}`,
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

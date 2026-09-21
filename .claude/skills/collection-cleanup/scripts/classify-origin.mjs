// Tags each card with whether it's about France or not, from its category
// text (title as fallback when category is null) -- a separate axis from
// classify-theme.mjs's theme, since "is this French" cuts across themes
// (villages, routes, actors, footballers... are French or aren't, regardless
// of which theme bucket they land in).
//
// Built the same way classify-theme.mjs was: surveyed the real category data
// rather than guessed. french/française appears 79+ times and is by far the
// strongest signal; "de France"/"en France" catches a few more. Deliberately
// NOT using a generic nationality-suffix regex (e.g. anything ending "-ien",
// "-ais") -- a real survey of this data turned up "parisien", "alsacien",
// "strasbourgeois" among the -ien/-ois matches, which are FRENCH regional
// demonyms, not foreign ones; a suffix guess would have misclassified them.
// Same reasoning killed a bare "département" rule: the real data has
// "département du Burkina Faso" and a US Army "department" translated the
// same way, so "département" alone says nothing about France.
//
// Three outcomes, not two: most cards (dates, species, abstract concepts,
// "acteur" with no nationality given) carry no origin signal at all, and
// forcing those into "france" or "étranger" would be a guess dressed up as a
// classification. `inconnu` is the honest answer for those.

const FRANCE = /fran[çc]ais|\bde france\b|\ben france\b/i;

// A curated whitelist, not a suffix pattern -- see the file comment for why.
//
// Two kinds of signal, both needed: nationality adjectives ("acteur
// américain") AND bare country/place names ("village de Belgique", "île des
// Seychelles"). The country-name list turned out to matter far more than
// expected -- a first pass covering only adjectives plus a handful of hand-
// picked "de/du <country>" phrases left roughly half of Géographie & Lieux
// as "inconnu", and nearly all of that half was checkably foreign
// (Belgique, Tchéquie, Sénégal, Bosnie, Espagne, Cameroun, Serbie, Croatie,
// Estonie, Luxembourg, Colombie, Russie, Mexique, Norvège, Mali...) just
// using a preposition ("de", "du", "en", "au", "aux") this file hadn't
// anticipated for that specific country. Matching the country NAME itself
// sidesteps needing every preposition/gender combination.
//
// No \b around any entry, deliberately: several of these start with an
// accented letter (Écosse, Égypte, Équateur, États-Unis), and JS `\b` never
// fires next to one (see classify-theme.mjs's file comment for the full
// explanation) -- so a leading \b here would silently exclude exactly the
// entries most likely to need it. Plain substring matching is safe: these
// are distinctive enough proper nouns that an accidental false match inside
// an unrelated word is not a realistic risk in this data.
const FOREIGN = new RegExp(
  [
    // Nationality adjectives.
    'am[ée]ricain', 'allemand', 'italien', 'canadien', 'qu[ée]b[ée]cois',
    'japonais', 'chinois', 'alg[ée]rien', 'finlandais', 'autrichien',
    'n[ée]erlandais', 'camerounais', 'africain', 'irlandais', 'malien',
    'polonais', 'portugais', 'congolais', 'isra[ée]lien', 'ha[iï]tien',
    'z[ée]landais', 'australien', 'hongrois', 'br[ée]silien', 'mexicain',
    'togolais', '[ée]gyptien', 'islandais', 'p[ée]ruvien', 'danois',
    'guin[ée]en', 'w[uü]rtembergois', 'g[ée]orgien', 'syrien', 'marocain',
    'chilien', '[ée]cossais', 'espagnol', 'britannique', 'su[ée]dois',
    'norv[ée]gien', '\\bgrec\\b', 'turque?\\b', 'indien', 'argentin',
    'cor[ée]en', 'tunisien', 's[ée]n[ée]galais', 'ivoirien', 'ghan[ée]en',
    'nig[ée]rian', 'suisse', 'belge', 'russe', 'ukrainien', 'roumain',
    'bulgare', 'slovaque', 'slov[èe]ne', 'croate', 'serbe', 'bosniaque',
    'estonien', 'letton', 'lituanien', 'gallois', 'anglais',
    // Country and place names (any preposition, any gender). Not
    // exhaustive -- extend it the way classify-theme.mjs's rules were
    // extended, from what actually lands in "inconnu".
    'allemagne', 'angleterre', 'argentine', 'australie', 'autriche',
    'belgique', 'biélorussie', 'birmanie', 'bolivie', 'bosnie-herzégovine',
    'bosnie', 'brésil', 'bulgarie', 'burkina faso', 'cameroun', 'canada',
    'chypre', 'colombie', 'congo', 'corée du nord',
    'corée du sud', 'costa rica', "côte d'ivoire", 'croatie', 'cuba',
    'danemark', 'égypte', 'émirats arabes unis', 'équateur', 'espagne',
    'estonie', "états-unis", 'éthiopie', 'finlande', 'ghana', 'grèce',
    'guatemala', 'guinée', 'haïti', 'hongrie', 'indonésie', 'irak',
    'iran', 'irlande', 'islande', 'israël', 'italie', 'jamaïque', 'japon',
    'jordanie', 'kazakhstan', 'kenya', 'kosovo', 'lettonie', 'liban',
    'libye', 'lituanie', 'luxembourg', 'madagascar', 'malaisie',
    'malte', 'maroc', 'mexique', 'moldavie', 'mongolie', 'monténégro',
    'nigeria', 'norvège', 'nouvelle-zélande', 'ouganda',
    'pakistan', 'panama', 'paraguay', "pays de galles", 'pays-bas',
    'pérou', 'philippines', 'pologne', 'portugal', 'qatar',
    'république dominicaine', 'république tchèque', 'roumanie',
    'royaume-uni', 'russie', 'écosse', 'sénégal', 'serbie', 'singapour',
    'slovaquie', 'slovénie', 'soudan', 'suède', 'syrie', 'tanzanie',
    'tchéquie', 'thaïlande', 'tunisie', 'turquie', 'ukraine',
    'uruguay', 'venezuela', 'vietnam', 'yémen', 'zambie', 'zimbabwe',
    'québec', 'seychelles', 'kibboutz',
    // Short enough to risk a false substring match inside an unrelated word
    // (real ones caught in this data: "indice", "individu" both contain
    // "inde") -- word-boundary these specifically. Safe to \b here, unlike
    // the accented entries above: all-ASCII, no accent-adjacency issue.
    '\\bchine\\b', '\\binde\\b', '\\bmali\\b', '\\btogo\\b', '\\bniger\\b',
    '\\bchili\\b',
  ].join('|'),
  'i',
);

/**
 * @param {string | null | undefined} category
 * @param {string | null | undefined} titleFallback used when category is null
 * @returns {'france' | 'etranger' | 'inconnu'}
 */
export function classifyOrigin(category, titleFallback) {
  const text = category?.trim() || titleFallback?.trim() || '';
  if (!text) return 'inconnu';
  if (FRANCE.test(text)) return 'france';
  if (FOREIGN.test(text)) return 'etranger';
  return 'inconnu';
}

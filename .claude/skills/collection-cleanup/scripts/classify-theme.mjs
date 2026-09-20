// Assigns each card a "theme" bucket from its Wikipedia category string (or
// its title, for the handful of cards with a null category).
//
// This is a plain keyword/regex classifier, not an LLM call: French Wikipedia
// short-description categories are highly systematic ("espèce d'oiseaux",
// "commune française du département de X", "film de Y, sorti en Z"), so a
// rule list gets good coverage cheaply and -- unlike an LLM pass -- is
// deterministic and free to re-run.
//
// Rules are tried IN ORDER, first match wins. More specific patterns must
// come before broader ones that would otherwise shadow them (e.g. "navire de
// guerre" is matched by the Militaire rule before the generic "navire"
// pattern in Transports gets a chance at it; "association d'églises" is
// matched by Religion before the plain building sense of "église" in
// Géographie).
//
// This taxonomy was tuned against one real wiki-masters collection (~530
// unique categories, iterated twice against the actual "Autres / non classé"
// fallout -- see git history of this file for what round 1 missed). It will
// not be perfect for every account. If "Autres" is large after a run, read
// data/collection-categories.json for what's landing there and add a rule
// rather than re-deriving the whole taxonomy from scratch.

export const THEMES = [
  {
    key: 'wiki-meta',
    label: 'Pages Wikimédia (homonymie / listes / définitions)',
    test: /page d.homonymie|page de liste|nom de famille|groupe de mots servant à|^jour$/i,
  },
  {
    key: 'astronomie',
    label: 'Astronomie & Espace',
    test: /cratère sur|éclipse (solaire|lunaire)|astéroïde|comète|galaxie|\bNGC\s?\d/i,
  },
  {
    key: 'religion',
    label: 'Religion & Mythologie',
    test: /religion|mythologi|divinité|\bdieu(x)?\b|évêque|textes sacrés|discordianisme|\bsacré|chrétien|christianisme|association d.églises|confession religieuse|missionnaire|\bmoine\b|\bcardinal\b|Église catholique/i,
  },
  {
    key: 'militaire',
    label: 'Militaire & Guerre',
    test: /militaire|régiment|\bbataille\b|\bguerre\b|bombe (à|nucléaire)|accident aérien|navire de guerre|groupe armé|terroriste|forces coloniales|attaque de missiles/i,
  },
  {
    key: 'histoire-royaute',
    label: 'Histoire & Royauté',
    test: /\bpharaon\b|émir\b|\broi\b|\breine\b|\bempereur\b|\bprince(sse)?\b|\bduc(hesse)?\b|\bcalife\b|noblesse|historien|ancienne (commune|circonscription)|\bmois de \d|stade de la vie|événements survenus/i,
  },
  {
    key: 'politique',
    label: 'Politique & Administration',
    test: /politi(que|cien)|parti (politique|travailliste|communiste|socialiste)|circonscription (électorale|législative)|\bconstitution\b|coopération intercommunale|\bmaire\b|trotskyste|femme d.[ée]tat|homme d.[ée]tat|haut fonctionnaire|diplomate|économiste.*(socialiste|communiste)|conseil de sécurité|\btraité|\bsommet\b|\bsyndicat\b|droit appliqué|élections|résultats électoraux/i,
  },
  {
    key: 'sport',
    label: 'Sport',
    test: /footballeur|footballeuse|\bjoueur(se)?\b|sportif|athlète|délégation olympique|jeux (olympiques|paralympiques)|compétition de|équipe de football|saison d.une équipe|[ée]dition\b.*(championnat|ligue|coupe|course|tournoi)|course cycliste|échecs|\bcycliste\b|nageu(r|se)\b|coureu(r|se)\b|taekwondoïste|basket-ball|arts martiaux/i,
  },
  {
    key: 'faune-flore',
    label: 'Faune & Flore',
    test: /espèce d[e'’]|genre d[e'’]|\btaxon\b|dinosaure|changement évolutif des organismes|\bcépage\b/i,
  },
  {
    key: 'sciences',
    label: 'Sciences & Techniques',
    test: /chimiste|composé chimique|physicien|biologiste|zoologiste|botaniste|naturaliste|phénomène|\bprocessus\b|ingénierie|université|établissement d.enseignement|école\b|théorème|\balgorithme\b|\bformule\b|blockchain|\bgène\b|médicament|unité de mesure|\blangue\b|famille de langues|technique d.observation|\bsatellite\b/i,
  },
  {
    key: 'cinema-tv',
    label: 'Cinéma & Télévision',
    test: /\bfilm\b|série télévisée|série d.animation|émission de télévision|épisode d.|réalisateur|scénariste|cinéaste|série cinématographique/i,
  },
  {
    key: 'musique',
    label: 'Musique',
    test: /\balbum\b|\bchanson\b|musicien|chef d.orchestre|auteur-compositeur|compositeur|guitariste|festival de musique|école (supérieure )?de musique/i,
  },
  {
    key: 'litterature',
    label: 'Littérature',
    test: /écrivain|romancier|po[eè]te|\bnouvelle\b|\blivre\b|\broman\b|\brecueil\b|auteur de (bande dessinée|science fiction)|philosophe|essayiste|journaliste|personnage de bande dessinée|éditeur de livres/i,
  },
  {
    key: 'art',
    label: 'Art & Peinture',
    test: /tableau de|artiste peintre|\bpeintre\b|illustrateur|sculpteur|œuvre de\b|céramiste/i,
  },
  {
    key: 'jeux',
    label: 'Jeux vidéo & Jeux de société',
    test: /jeu vidéo|jeu de société|service de jeux/i,
  },
  {
    key: 'personnalites',
    label: 'Personnalités (arts, spectacle & autres métiers)',
    test: /\bacteur\b|\bactrice\b|comédien|mannequin|présentat(eur|rice)|chanteur|chanteuse|directeur artistique|producteur|fonctionnaire|parfumeur|artiste\b|avocate?\b|entrepreneur|meurtrier|constructeur de|médecin|psychiatre|archéologue|entomologiste|ichtyologue|philologue|astronome|sociologue|érudit|pilote d.avion|navigateur|ingénieur|bibliophile|militante|collectionneu(r|se)/i,
  },
  {
    key: 'entreprises',
    label: 'Entreprises, Organisations & Économie',
    test: /\bentreprise\b|\bcamion\b|catégorie d.entreprise|indemnisation|société( anonyme)?\b|club\b|système de transport en commun/i,
  },
  {
    key: 'transports',
    label: 'Transports',
    test: /gare (ferroviaire)?|station de m[ée]tro|ligne de chemin de fer|\bnavire\b|\baéroport\b/i,
  },
  {
    key: 'geographie',
    label: 'Géographie & Lieux',
    test: /\bcommune\b|\bvillage\b|\bville d[eu]\b|\bcanton\b|[îi]le d[eu']|\blac (au|du|de)\b|région géographique|établissement humain|municipalité|église (située|à)|\bbâtiment\b|\bchâteau\b|\bmaison à|\bboulevard\b|site archéologique|zaouïa|station de ski|\bpont\b|\bmonument\b|\bparc\b|\bmusée\b|\bthéâtre\b|\bstade\b|département (du|de)|\broute\b|\brivière\b|\bfleuve\b|\bmontagne\b|\bcap de\b|kibboutz|chef-lieu|localité d[eu]|région administrative|zone de gouvernement|gratte-ciel|port fluvial|borne milliaire|croix de chemin|\bmenhir\b|station du métro|\bdistrict\b|massif montagneux/i,
  },
];

const FALLBACK = { key: 'autres', label: 'Autres / non classé' };

/**
 * @param {string | null | undefined} category
 * @param {string | null | undefined} titleFallback used when category is null
 * @returns {{ key: string, label: string }}
 */
export function classifyTheme(category, titleFallback) {
  const text = (category?.trim() || titleFallback?.trim() || '').toLowerCase();
  if (!text) return FALLBACK;
  for (const theme of THEMES) {
    if (theme.test.test(text)) return { key: theme.key, label: theme.label };
  }
  return FALLBACK;
}

export { FALLBACK as FALLBACK_THEME };

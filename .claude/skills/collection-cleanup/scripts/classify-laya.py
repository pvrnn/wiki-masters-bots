#!/usr/bin/env python3
"""Classify every card in data/collection-raw.json with Laya, a local AI model.

Laya (convaiinnovations/laya, Apache-2.0) answers typed questions about a piece
of text in one forward pass -- no text generation, so nothing to parse. For
each distinct card it answers:

  theme      one of classify-theme.mjs's THEMES keys (or "autres")
  country    an ISO code from countries.json, "INT" or "NONE", picked in three
             steps: continent -> subregion -> country
  interest   0-100, how well-known / collectible the subject is

and writes them to data/collection-ai.json. build-grouped.mjs reads that file
to fill the gaps the lookup table and the regex rules leave, and to compute
each card's keep score. This script never talks to wiki-masters.com and never
discards anything.

Why it is shaped this way -- all from Laya's own README ("Honest limits"):

- It's a 322M-parameter encoder that picks the option the text best
  supports. It has no world knowledge: it cannot know that "Yannick Noah" is
  French from the title. So each card's state includes the first paragraph of
  its Wikipedia article, which usually says it outright ("joueur de tennis
  français"). Those extracts are fetched once and cached in
  data/wiki-extracts.json.
- Accuracy falls off sharply past ~20 options in one choice question, and
  there are ~200 countries. So the country is asked as continent (7 options),
  then subregion (<= 5), then country (<= 19), each level from countries.json.
- `score` questions are its weakest primitive, and the multilingual checkpoint
  has a position bias on them. So "interest" is a 3-option choice with neutral
  A/B/C keys, and build-grouped.mjs only uses it as one weighted part of the
  keep score.
- The checkpoints ship over-confident. Every answer keeps its calibrated
  `answer_confidence`, and build-grouped.mjs only trusts answers above a
  threshold.

The categories are French, so this always uses the `multilingual` checkpoint.

Setup (once, from the repo root):
    python3 -m venv .venv
    .venv/bin/python -m pip install laya

Run from the repo root:
    .venv/bin/python .claude/skills/collection-cleanup/scripts/classify-laya.py [--limit N] [--force]

The first run downloads the checkpoint from Hugging Face. Runs are incremental:
only cards missing from data/collection-ai.json, or classified under a
different prompt version, are sent to the model again.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SKILL_DIR.parent.parent.parent
DATA_DIR = REPO_ROOT / "data"
RAW_PATH = DATA_DIR / "collection-raw.json"
OUT_PATH = DATA_DIR / "collection-ai.json"
WIKI_CACHE_PATH = DATA_DIR / "wiki-extracts.json"
PREFS_PATH = DATA_DIR / "keep-preferences.json"
COUNTRIES_PATH = SKILL_DIR / "countries.json"
THEMES_MODULE = SKILL_DIR / "scripts" / "classify-theme.mjs"

MODEL_REPO = "convaiinnovations/laya"
MODEL_SUBFOLDER = "multilingual"

# Wikimedia's API policy asks for a User-Agent that identifies the client.
USER_AGENT = "wiki-masters-bots/1.0 (personal card-collection classifier; https://github.com/pvrnn/wiki-masters-bots)"
WIKI_MIN_INTERVAL_S = 0.2  # ~5 requests/second, well under Wikimedia's limits
# Stop asking Wikipedia after this many network failures in a row: when it's
# unreachable, every card would otherwise cost ~7s of retries.
WIKI_MAX_CONSECUTIVE_FAILURES = 5
EXTRACT_MAX_CHARS = 700  # the first paragraph is where nationality/location is stated

# Bump when the question wording or the state shape changes in a way that
# should re-classify every card.
SCHEMA_VERSION = 1

LOCATION_INSTRUCTIONS = (
    "À quel pays ce sujet est-il rattaché ? Pour une personne : sa nationalité. "
    "Pour un lieu : où il se trouve. Pour une œuvre, une entreprise, un club ou un "
    "événement : son pays d'origine."
)

INTEREST_CRITERIA = {
    "A": "sujet obscur, anecdotique ou très local",
    "B": "sujet moyennement connu",
    "C": "sujet célèbre, emblématique, connu du grand public",
}
INTEREST_VALUE = {"A": 0.0, "B": 50.0, "C": 100.0}


def log(msg):
    # stderr, so --dry-run's JSON on stdout stays machine-readable.
    print(msg, file=sys.stderr, flush=True)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json_atomic(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load_themes():
    """THEMES straight from classify-theme.mjs, so the keys can never drift apart."""
    code = (
        "const m = await import(process.argv[1]);"
        "console.log(JSON.stringify([...m.THEMES, m.FALLBACK_THEME]"
        ".map((t) => ({ key: t.key, label: t.label }))));"
    )
    out = subprocess.run(
        ["node", "--input-type=module", "-e", code, THEMES_MODULE.as_uri()],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


# --- Wikipedia extracts ------------------------------------------------------

def wiki_target(card):
    """(host, title) of the card's Wikipedia article, or (None, None)."""
    url = card.get("wikipedia_url") or ""
    parsed = urllib.parse.urlparse(url)
    if parsed.netloc.endswith(".wikipedia.org") and "/wiki/" in parsed.path:
        return parsed.netloc, urllib.parse.unquote(parsed.path.split("/wiki/", 1)[1])
    title = card.get("wikipedia_title")
    return ("fr.wikipedia.org", title) if title else (None, None)


class WikiFetcher:
    def __init__(self, cache):
        self.cache = cache  # "host/title" -> {"extract": str | None, "status": int}
        self.last_request = 0.0
        self.fetched = 0
        self.consecutive_failures = 0
        self.gave_up = False

    def get(self, card):
        host, title = wiki_target(card)
        if not title:
            return None
        key = f"{host}/{title}"
        if key in self.cache:
            return self.cache[key]["extract"]
        if self.gave_up:
            return None
        result = self._fetch(host, title)
        self.fetched += 1
        if result["status"] == 0:
            # Not cached: the next run retries it.
            self.consecutive_failures += 1
            if self.consecutive_failures >= WIKI_MAX_CONSECUTIVE_FAILURES:
                self.gave_up = True
                log(f"  Wikipédia injoignable ({self.consecutive_failures} échecs d'affilée) -- "
                    "classement sans résumés pour le reste de cette passe.")
            return None
        self.consecutive_failures = 0
        self.cache[key] = result
        return result["extract"]

    def _fetch(self, host, title):
        path = urllib.parse.quote(title.replace(" ", "_"), safe="")
        url = f"https://{host}/api/rest_v1/page/summary/{path}?redirect=true"
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        for attempt in range(3):
            wait = WIKI_MIN_INTERVAL_S - (time.monotonic() - self.last_request)
            if wait > 0:
                time.sleep(wait)
            self.last_request = time.monotonic()
            try:
                with urllib.request.urlopen(req, timeout=15) as res:
                    body = json.load(res)
                extract = (body.get("extract") or "").strip()[:EXTRACT_MAX_CHARS] or None
                return {"extract": extract, "status": 200}
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    time.sleep(2 ** attempt)
                    continue
                # 404 and friends are permanent: cache the miss so it isn't retried every run.
                return {"extract": None, "status": e.code}
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == 2:
                    log(f"  wikipedia: {title}: {str(e).splitlines()[0]}")
                time.sleep(2 ** attempt)
        return {"extract": None, "status": 0}  # transient: get() doesn't cache it


# --- Questions ---------------------------------------------------------------

def build_questions(themes, countries, notes):
    theme_q = {
        "type": "choice",
        "instructions": "Quel est le thème principal de ce sujet Wikipédia ?",
        "criteria": {
            t["key"]: ("aucun des autres thèmes" if t["key"] == "autres" else t["label"])
            for t in themes
        },
    }
    continent_q = {
        "type": "choice",
        "instructions": LOCATION_INSTRUCTIONS + " Choisissez d'abord la région du monde.",
        "criteria": {
            **{c["key"]: f'{c["label"]} : {c["hint"]}' for c in countries["continents"]},
            **countries["noCountry"],
        },
    }
    interest_instructions = "À quel point ce sujet est-il connu et intéressant pour un collectionneur de cartes ?"
    if notes:
        interest_instructions += f" Goûts du collectionneur : {notes}"
    interest_q = {"type": "choice", "instructions": interest_instructions, "criteria": INTEREST_CRITERIA}

    subregion_qs = {}
    country_qs = {}
    for c in countries["continents"]:
        if len(c["subregions"]) > 1:
            subregion_qs[c["key"]] = {
                "type": "choice",
                "instructions": LOCATION_INSTRUCTIONS + f' Le sujet est en {c["label"]} : dans quelle partie ?',
                "criteria": {s["key"]: f'{s["label"]} : {s["hint"]}' for s in c["subregions"]},
            }
        for s in c["subregions"]:
            country_qs[s["key"]] = {
                "type": "choice",
                "instructions": LOCATION_INSTRUCTIONS,
                "criteria": {code: name for code, name in s["countries"]},
            }
    return {
        "first": {"theme": theme_q, "continent": continent_q, "interest": interest_q},
        "subregion": subregion_qs,
        "country": country_qs,
    }


def prompt_version(questions):
    blob = json.dumps(
        {"schema": SCHEMA_VERSION, "model": f"{MODEL_REPO}/{MODEL_SUBFOLDER}",
         "extract": EXTRACT_MAX_CHARS, "questions": questions},
        sort_keys=True, ensure_ascii=False,
    )
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def card_state(card, extract):
    state = {"titre": card.get("wikipedia_title") or "", "catégorie": card.get("category") or ""}
    if extract:
        state["résumé"] = extract
    return state


# --- Model -------------------------------------------------------------------

def load_agent(device):
    try:
        import laya  # noqa: PLC0415 -- heavy import (torch), only when actually needed
    except ImportError:
        sys.exit(
            "Le paquet Python `laya` est introuvable. Depuis la racine du dépôt :\n"
            "  python3 -m venv .venv && .venv/bin/python -m pip install laya\n"
            "puis relancez ce script avec .venv/bin/python."
        )
    log(f"Chargement de {MODEL_REPO}/{MODEL_SUBFOLDER} (téléchargé au premier lancement)…")
    return laya.load(MODEL_REPO, subfolder=MODEL_SUBFOLDER, device=device)


def ask(agent, states, questions, batch_size):
    """One predict_batch call; returns a list of answer dicts aligned with states."""
    if not states:
        return []
    results = agent.predict_batch(states, questions, batch_size=batch_size, sort_by_length=True)
    return [r["answers"] for r in results]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--limit", type=int, help="only classify this many new cards (for a trial run)")
    ap.add_argument("--force", action="store_true", help="re-classify every card, ignoring the cache")
    ap.add_argument("--dry-run", action="store_true", help="print the questions and one state, load no model")
    ap.add_argument("--no-wiki", action="store_true", help="don't fetch Wikipedia extracts (weaker country answers)")
    ap.add_argument("--device", help="cpu / cuda / mps (default: Laya picks)")
    ap.add_argument("--batch-size", type=int, default=32)
    args = ap.parse_args()

    raw = read_json(RAW_PATH)
    if raw is None:
        sys.exit(f"{RAW_PATH} introuvable -- lancez d'abord fetch-collection.mjs.")

    # One entry per distinct card: duplicates share every answer.
    cards = {}
    for item in raw["collection"]:
        card = item.get("card") or {}
        cards.setdefault(item["card_id"], card)

    prefs = read_json(PREFS_PATH, {}) or {}
    countries = read_json(COUNTRIES_PATH)
    questions = build_questions(load_themes(), countries, (prefs.get("notes") or "").strip())
    version = prompt_version(questions)

    previous = read_json(OUT_PATH, {}) or {}
    cached = previous.get("cards", {})
    todo = [cid for cid in cards if args.force or cached.get(cid, {}).get("promptVersion") != version]
    if args.limit is not None:
        todo = todo[: args.limit]
    log(f"{len(cards)} cartes distinctes, {len(cards) - len(todo)} déjà classées, {len(todo)} à classer.")

    wiki = WikiFetcher({} if args.no_wiki else read_json(WIKI_CACHE_PATH, {}) or {})
    extracts = {}
    if not args.no_wiki and todo:
        log("Récupération des résumés Wikipédia…")
        for i, cid in enumerate(todo, 1):
            extracts[cid] = wiki.get(cards[cid])
            if wiki.fetched and wiki.fetched % 50 == 0:
                write_json_atomic(WIKI_CACHE_PATH, wiki.cache)
            if i % 100 == 0:
                log(f"  {i}/{len(todo)}")
        write_json_atomic(WIKI_CACHE_PATH, wiki.cache)
        found = sum(1 for cid in todo if extracts.get(cid))
        log(f"  {found}/{len(todo)} résumés trouvés ({wiki.fetched} demandés à Wikipédia, le reste depuis le cache).")

    states = [card_state(cards[cid], extracts.get(cid)) for cid in todo]

    if args.dry_run:
        print(json.dumps({"promptVersion": version, "questions": questions,
                          "sampleState": states[0] if states else None}, ensure_ascii=False, indent=1))
        return

    out_cards = {cid: v for cid, v in cached.items() if cid in cards}  # drop discarded cards
    if not todo:
        write_json_atomic(OUT_PATH, {**previous, "cards": out_cards})
        log("Rien à faire.")
        return

    agent = load_agent(args.device)
    t0 = time.monotonic()

    # Pass 1: theme, continent and interest share one forward pass per batch.
    log("Passe 1/3 : thème, continent, intérêt…")
    first = ask(agent, states, questions["first"], args.batch_size)

    # Pass 2: subregion, one batch per continent (each has its own option list).
    continent_of = {s["key"]: c["key"] for c in countries["continents"] for s in c["subregions"]}
    single_subregion = {c["key"]: c["subregions"][0]["key"] for c in countries["continents"] if len(c["subregions"]) == 1}
    subregion = [None] * len(todo)  # (key, answer_confidence)
    log("Passe 2/3 : sous-région…")
    for cont, q in questions["subregion"].items():
        idx = [i for i, a in enumerate(first) if a["continent"]["choice"] == cont]
        for i, ans in zip(idx, ask(agent, [states[i] for i in idx], {"subregion": q}, args.batch_size)):
            subregion[i] = (ans["subregion"]["choice"], ans["subregion"]["answer_confidence"])
    for i, a in enumerate(first):
        if a["continent"]["choice"] in single_subregion:
            subregion[i] = (single_subregion[a["continent"]["choice"]], 1.0)

    # Pass 3: country, one batch per subregion.
    country = [None] * len(todo)
    log("Passe 3/3 : pays…")
    for sub, q in questions["country"].items():
        idx = [i for i, s in enumerate(subregion) if s and s[0] == sub]
        for i, ans in zip(idx, ask(agent, [states[i] for i in idx], {"country": q}, args.batch_size)):
            country[i] = (ans["country"]["choice"], ans["country"]["answer_confidence"])

    now = datetime.now(timezone.utc).isoformat()
    for i, cid in enumerate(todo):
        a = first[i]
        cont = a["continent"]["choice"]
        cont_conf = a["continent"]["answer_confidence"]
        if cont in countries["noCountry"]:
            code, path_conf, sub_key = ("INT" if cont == "international" else "NONE"), cont_conf, None
        else:
            sub_key, sub_conf = subregion[i]
            code, c_conf = country[i]
            # Probability of the whole continent -> subregion -> country path.
            path_conf = cont_conf * sub_conf * c_conf
        probs = a["interest"]["probabilities"]
        out_cards[cid] = {
            "theme": a["theme"]["choice"],
            "theme_conf": a["theme"]["answer_confidence"],
            "continent": cont,
            "subregion": sub_key,
            "country": code,
            "country_conf": round(path_conf, 4),
            "interest": round(sum(INTEREST_VALUE[k] * p for k, p in probs.items()), 1),
            "interest_conf": a["interest"]["answer_confidence"],
            "had_extract": bool(extracts.get(cid)),
            "promptVersion": version,
            "at": now,
        }

    write_json_atomic(OUT_PATH, {
        "model": f"{MODEL_REPO}/{MODEL_SUBFOLDER}",
        "promptVersion": version,
        "generatedAt": now,
        "cards": out_cards,
    })

    elapsed = time.monotonic() - t0
    log(f"\nÉcrit {OUT_PATH} -- {len(todo)} cartes classées en {elapsed:.1f}s.")
    new = [out_cards[cid] for cid in todo]
    log("Pays les plus fréquents : " + ", ".join(
        f"{code} {n}" for code, n in Counter(r["country"] for r in new).most_common(10)))
    log("Thèmes : " + ", ".join(f"{k} {n}" for k, n in Counter(r["theme"] for r in new).most_common(8)))
    log("Exemples :")
    for cid in todo[:5]:
        r = out_cards[cid]
        log(f'  {cards[cid].get("wikipedia_title")!r}: {r["theme"]} ({r["theme_conf"]:.2f}), '
            f'{r["country"]} ({r["country_conf"]:.2f}), intérêt {r["interest"]:.0f}')


if __name__ == "__main__":
    main()

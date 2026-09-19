# wiki-masters-bots

Logs in to [wiki-masters.com](https://www.wiki-masters.com) with Playwright and opens
every available card pack, on a repeating schedule, unattended.

The site has no API token, so authentication goes through the real login form. Once a
session exists the bot talks to `POST /api/packs/open` directly over HTTP — no browser —
until the response reports `"packs_remaining": 0`.

## How it works

Session reuse is the whole design:

```
saved session on disk?
  ├─ yes → POST /api/packs/open ... until packs_remaining == 0   (no browser at all)
  └─ no  → launch Chrome → fill the login form → solve Turnstile → save cookies → drain
```

A browser only starts when there is no session, or when the API actually rejects the one
we have. In steady state a run is a handful of HTTP calls, which is why an hourly cadence
costs nothing. It also means the Cloudflare checkbox is touched once every few days rather
than every hour.

Everything that can loop is bounded: a per-request timeout, a 3–4 s gap between opens, an
iteration cap, a wall-clock budget, backoff on transient errors, and a stall detector that
gives up if `packs_remaining` stops going down.

## Quick start

```bash
npm ci
npx playwright install chromium chrome     # chrome is the better fingerprint
npm run build

cp .env.example .env                       # then fill in WM_EMAIL and WM_PASSWORD

npm run login       # watch it log in; solve the checkbox if it appears. Opens no packs.
npm run probe       # confirm the saved session. Opens no packs.
WM_MAX_PACKS=1 npm run run:once            # open exactly one, and read the response
npm run run:once                           # drain the queue
```

Run `WM_HEADLESS=false npm run login` the first time on a desktop machine so you can see
what the form actually does.

## Modes

| Command | What it does |
|---|---|
| `npm run run:once` | Open every available pack once, then exit. |
| `npm start` | Daemon: run now, then every `WM_INTERVAL_MINUTES`. Used by the container. |
| `npm run login` | Force a fresh browser login and save the session. Opens no packs. |
| `npm run probe` | Check the saved session. Opens no packs. |

Exit codes: `0` success, no-op, skipped or in backoff · `1` configuration error ·
`2` authentication or Turnstile failure · `3` API failure or stopped mid-drain.

### Why 61 minutes, not 60

Packs refill on a rolling one-hour timer, so a 60-minute schedule races it and can arrive
a second early. 61 minutes always lands past the boundary. Plain cron cannot express a
61-minute interval, which is why the daemon schedules itself rather than shipping a
crontab line. The wait is anchored to when each run *started*, so the period stays a true
61 minutes instead of drifting by however long the run took.

## Deploying

```bash
mkdir -p data && sudo chown -R 1000:1000 data   # the container runs as uid 1000
cp .env.example .env                            # fill it in
docker compose up --build -d
docker compose logs -f
```

The `./data` volume matters: it holds the session, the browser profile and the backoff
ledger. Without it every restart forces a fresh login.

Inside the container the browser runs **headed under Xvfb** (`docker/entrypoint.sh`),
because headless is the single biggest automation tell.

## Cloudflare Turnstile — read this

The login form carries a Turnstile checkbox, and the bot handles it like this:

1. Waits ~15 s to see whether the widget issues a token on its own. It often does.
2. Otherwise clicks the checkbox inside the widget's iframe.
3. Waits up to `WM_TURNSTILE_TIMEOUT_MS`, then gives up.

"Solved" is judged only by the hidden `cf-turnstile-response` field actually holding a
token — never by how the checkbox looks.

**Be realistic about a cloud VPS.** A datacenter IP is itself a reason Cloudflare
challenges you, so Turnstile will sometimes refuse to issue a token no matter how clean
the browser looks. The bot is built for that rather than against it:

- A refused challenge is **never** retried inside a run — that only degrades the IP
  further. It is a hard stop with a screenshot and the page HTML in `data/debug/`.
- Failures are recorded in `data/auth-ledger.json` and the next login attempt is pushed
  out 2 h → 4 h → 8 h → capped at 24 h. Opening packs on a session that still works is
  never suppressed; only login attempts are.
- Set `WM_NOTIFY_WEBHOOK_URL` (Discord, Slack or ntfy) so you hear about it instead of
  finding out a week later.

### When Turnstile won't budge: move a session in by hand

This is the reliable fix, and it needs no code changes. It works because the challenge
guards the **login form only**, not the whole site — so what authorises the API is an
ordinary session cookie, not Cloudflare's IP-bound `cf_clearance`.

```bash
# on your own machine, on your home connection
npm run login
scp data/storage-state.json data/session-meta.json  you@vps:/srv/wiki-masters-bots/data/
```

The container picks the session up on its next run and never touches the login form.
`session-meta.json` carries the User-Agent the login used, and the API calls reuse it
exactly — copy both files, or the session may be rejected.

If you hit the wall repeatedly, the escalations in order of effectiveness are: a
residential or sticky proxy, then `playwright-extra` with the stealth plugin, then doing
the login by hand as above. A paid solver service is deliberately not built in.

## Configuration

Everything is environment variables; `.env` is loaded automatically. `.env.example`
documents every one. The essentials:

| Variable | Default | Meaning |
|---|---|---|
| `WM_EMAIL` | — | **required** |
| `WM_PASSWORD` | — | **required** |
| `WM_BASE_URL` | `https://www.wiki-masters.com` | |
| `WM_INTERVAL_MINUTES` | `61` | Daemon period. |
| `WM_OPEN_DELAY_MIN_MS` / `_MAX_MS` | `3000` / `4000` | Gap between opens. |
| `WM_REQUEST_TIMEOUT_MS` | `180000` | Per request — the open endpoint is slow. |
| `WM_MAX_PACKS` | `200` | Iteration cap. |
| `WM_RUN_BUDGET_MS` | `2700000` | Wall clock per run; must be under the interval. |
| `WM_STALL_LIMIT` | `3` | Give up if `packs_remaining` stops falling. |
| `WM_TURNSTILE_TIMEOUT_MS` | `60000` | Bounded: Turnstile can stall forever. |
| `WM_BROWSER_CHANNEL` | `chrome` | Empty to use bundled Chromium. |
| `WM_HEADLESS` | `false` | Headed under Xvfb in Docker; `true` to debug. |
| `WM_USER_AGENT` | unset | Leave unset — the real browser UA is recorded instead. |
| `WM_NOTIFY_WEBHOOK_URL` | unset | Alert on hard auth failure. |
| `WM_PROBE_PATH` | unset | See below. |

### `WM_PROBE_PATH`

`npm run probe` can only confirm that a session *exists*, because the one API call we know
about opens a pack and that is irreversible. If you know an authenticated `GET` that
doesn't change anything (a profile or pack-count endpoint), set `WM_PROBE_PATH` to it and
`probe` becomes a genuine end-to-end check. It is the single most useful thing you could
add here.

## Troubleshooting

**`could not find the email field on the login page`** — the form's markup differs from
the fallbacks in `src/login.ts`. Look at `data/debug/login-failed-*.png` and `.html`, then
add a selector to `emailCandidates` / `passwordCandidates` / `submitCandidates`.

**`cannot find packs_remaining in the response`** — the payload nests the count somewhere
unexpected. `readRemaining()` in `src/packs.ts` is the only place to change; the log line
above the error shows the real response.

**`packs_remaining stuck at N`** — deliberate. The count stopped falling, so the bot
stopped instead of hammering a slow endpoint. Check whether opens are actually failing
server-side.

**`another run holds the lock`** — a previous run is still going. Expected, not an error;
the run is skipped.

**Chrome missing** — the bot falls back to bundled Chromium with a warning. Fix with
`npx playwright install chrome`.

## A note on terms of service

Automating an account — and in particular automating past a bot check — may breach
wiki-masters.com's terms and could put your account at risk. The conservative delays,
caps and stall detection keep the traffic modest, but the decision to run this is yours.

# wiki-masters-bots

Opens every available card pack on [wiki-masters.com](https://www.wiki-masters.com) on a
repeating schedule, unattended.

## How it works

The site is a Next.js app on Vercel with **Supabase** auth. The bot:

1. holds a Supabase session (from a cookie you paste, or from a browser login);
2. refreshes the access token when it expires — they last **60 minutes**;
3. reads the account profile to see whether there is anything to do (read-only);
4. `POST`s `/api/packs/open` until `packs_remaining` is 0, 3–4 s apart. Each open
   yields five cards.

No browser is launched on a normal run — it is a handful of plain HTTP calls, which is
why an hourly cadence costs nothing.

## Quick start (cookie flow — recommended)

The login form carries a Cloudflare Turnstile checkbox that is painful to automate. Handing
the bot a session you already have avoids it entirely.

In the browser where you are logged in, open the devtools console and run:

```js
document.cookie
```

Copy the whole output into `cookie.txt`, then:

```bash
npm ci && npm run build
cp .env.example .env            # nothing required in it for the cookie flow
npm run import-cookie -- --file cookie.txt
npm run probe                   # confirms the session; opens no packs
npm run run:once                # drains the queue
```

`import-cookie` also reads from stdin (`pbpaste | npm run import-cookie`) or from
`WM_COOKIE`, which is how you feed a container without a shell.

**You do not need to re-paste this every hour.** The cookie carries a refresh token, and
the bot mints a new 60-minute access token each run, persisting the rotated one.

## Two things you should know

**Pack opening requires periodic human verification.** The account profile carries
`pack_human_verified_at`, and the site gates opening behind it — observed holding for
roughly 12 hours. When it lapses, `/api/packs/open` returns a verification error, the bot
stops with a clear message, and you need to open one pack by hand in a browser and
re-import the cookie. **The cookie flow defers this captcha; it does not remove it.**

**The site tracks and sanctions automation.** The profile exposes `cheat_strikes`,
`last_sanction_type` and `activity_blocked_until`. The bot refuses to run against an
account showing any of these (override with `WM_ALLOW_WHEN_STRUCK=true`), but it cannot
stop you from earning one. Running this may get the account struck or blocked.

## Modes

| Command | What it does |
|---|---|
| `npm run import-cookie` | Store a session cookie from your browser. Opens no packs. |
| `npm run probe` | Verify the session and print the pack count. Opens no packs. |
| `npm run run:once` | Open every available pack once, then exit. |
| `npm start` | Daemon: run now, then every `WM_INTERVAL_MINUTES`. The container's default. |
| `npm run login` | Password + Turnstile login. Needs `WM_EMAIL`/`WM_PASSWORD`. |

Exit codes: `0` success, no-op, skipped or in backoff · `1` configuration ·
`2` auth, session or verification problem · `3` API failure or stopped mid-drain.

### Why 61 minutes, not 60

Packs refill on a rolling hour, so a 60-minute schedule races it. 61 always lands past the
boundary. Cron cannot express 61 minutes, so the daemon schedules itself, anchoring each
wait to when the run *started* so the period does not drift.

## Deploying

```bash
mkdir -p data && sudo chown -R 1000:1000 data   # the container runs as uid 1000
cp .env.example .env                            # set WM_COOKIE
docker compose up --build -d
docker compose logs -f
```

The `./data` volume holds the session, so restarts do not lose it. With `WM_COOKIE` set
the container imports on first boot and never launches a browser.

## Configuration

All environment variables; `.env` is loaded automatically and `.env.example` documents
every one. The ones that matter:

| Variable | Default | Meaning |
|---|---|---|
| `WM_COOKIE` | unset | Session cookie; imported on first boot |
| `WM_EMAIL` / `WM_PASSWORD` | unset | Only for `login` mode |
| `WM_INTERVAL_MINUTES` | `61` | Daemon period |
| `WM_OPEN_DELAY_MIN_MS` / `_MAX_MS` | `3000` / `4000` | Gap between opens |
| `WM_REQUEST_TIMEOUT_MS` | `180000` | Per request |
| `WM_MAX_PACKS` | `200` | Iteration cap |
| `WM_RUN_BUDGET_MS` | `2700000` | Wall clock per run; must be under the interval |
| `WM_STALL_LIMIT` | `3` | Give up if `packs_remaining` stops falling |
| `WM_PREFLIGHT` | `true` | Check the profile before opening anything |
| `WM_ALLOW_WHEN_STRUCK` | `false` | Run even if the account is flagged |
| `WM_TOKEN_SKEW_MS` | `120000` | Refresh this far before expiry |
| `WM_NOTIFY_WEBHOOK_URL` | unset | Alert on anything needing a human |

The Supabase URL and anon key are defaulted in `src/config.ts`. The anon key is public by
design — shipped to every visitor's browser — and is overridable.

## Troubleshooting

**`no Supabase auth cookie found`** — the paste is missing the `sb-<project>-auth-token`
entries. Copy the *entire* `document.cookie` output; it is ~3.4 KB and usually splits into
`.0` and `.1`.

**`refresh failed ... refresh token is probably spent`** — the chain is broken (the cookie
was used elsewhere, or you logged out). Re-import a fresh cookie.

**`the site wants a fresh human verification`** — expected periodically. Open a pack by
hand in a browser, then re-import.

**`the account shows cheat_strikes=N`** — the site has flagged the account. Deliberate
stop; think before overriding.

**`cannot find packs_remaining in the response`** — the payload changed shape.
`readRemaining()` in `src/packs.ts` is the only place to adjust.

**`another run holds the lock`** — a previous run is still going. Expected, not an error.

## A note on terms of service

Automating an account — and especially automating around a bot check — may breach
wiki-masters.com's terms, and the site has explicit machinery for penalising it. The
conservative delays, caps, stall detection and the pre-flight keep the traffic modest and
well-behaved, but the decision to run this is yours.

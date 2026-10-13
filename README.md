# Mandate Matcher

Watches firms on regulatory registers and tracks their people. On each run it:

1. Fetches each firm and its listed individuals. FCA comes through the official API; other sites can be scraped.
2. Compares the result with the previous run. People who are new are **added**. People who left the list, or whose status became inactive, are **revoked**. Active people whose status or role category changed are **changed**.
3. Looks up each newly added person's roles (controlled functions) and their **cross-firm history**.
4. Writes `Companies`, `Employees` and an append-only `Changes` log to Google Sheets.
5. Posts a summary to Slack.

The first run for a firm only records a **baseline**, so you don't get a flood of "added" alerts.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
```

| Variable | What |
|---|---|
| `FCA_API_EMAIL` / `FCA_API_KEY` | From https://register.fca.org.uk/Developer. The API needs **both**: the email you registered with and the key. |
| `SLACK_WEBHOOK_URL` | Slack app → Incoming Webhooks → add to channel |
| `GOOGLE_SHEET_ID` | ID from the sheet URL |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Google Cloud → enable the Sheets API → create a service account → JSON key. Share the sheet with the service account email as **Editor**. |
| `ENRICH_MODE` | `new` (default: look up roles and history for new joiners only), `all` (everyone; this means many API calls), `none` |
| `CRON_SCHEDULE` / `TZ` | When `npm start` runs (default 07:00 Europe/London) |

## Choosing firms

```bash
npm run search -- "Barclays"              # find FRNs
npm run search -- "John Smith" --individual
```

Add them to `config/firms.json`:

```json
[{ "source": "fca", "id": "122702", "name": "Barclays Bank UK PLC" }]
```

## Running

```bash
npm run run-once   # single run (good for Windows Task Scheduler / cron / CI)
npm start          # runs now, then on CRON_SCHEDULE
```

## Sources

| Source | Market | Access | Who is listed |
|---|---|---|---|
| `fca` | UK | Official API (`FCA_API_EMAIL` + `FCA_API_KEY`) | Approved and certified persons, with roles and cross-firm history |
| `sfc` | Hong Kong | Public register pages, no key and no captcha (`SFC_MIN_INTERVAL_MS`, default 600) | Licensed corporations: Responsible Officers and Licensed Representatives. Registered institutions (banks): Executive Officers only, because a bank's relevant individuals are on the HKMA register. |
| `fsra` | UAE – ADGM (Abu Dhabi) | The site's own JSON endpoints, no key and no captcha (`FSRA_MIN_INTERVAL_MS`, default 500). Firm id is the FSP/permission number. | Approved Persons and Key Individuals (SEO, Licensed Director, CO, MLRO, …), with start and withdrawal dates |
| `dfsa` | UAE – DIFC (Dubai) | Drives your installed Chrome in a **visible window**, because Cloudflare refuses scripted and headless clients (`DFSA_MIN_INTERVAL_MS`, default 1500). Firm id is the DFSA reference (F000001); `slug` is the page name. | Authorised Individuals (including Licensed Representatives) and Key Individuals, with effective and withdrawn dates |
| `html` | any | Generic CSS-selector scraper | Whatever the page lists |

Find SFC CE numbers with `npm run search -- "Julius Baer" --sfc`.

DFSA needs a logged-in Windows desktop session while it runs, because a Chrome window opens and closes by itself. If Cloudflare ever shows a challenge, the DFSA firms report an error in Slack. The bot does not try to get round the challenge.

### News feeds (people moves)

`config/news.json` lists RSS feeds: Finews.asia and Asian Private Banker. Each daily run does the following:
1. Reads new headlines and their short summaries. Article pages are never fetched.
2. Keeps the ones that look like people moves.
3. Sends them to **Claude Haiku 4.5** (`ANTHROPIC_API_KEY`) to extract the person, role, from-firm, to-firm, market and seniority.
4. Stars moves that involve a watched firm, and links names found on the registers.
5. Appends the moves to the **News Moves** tab and the Slack digest.

Headlines are remembered in `data/news-seen.json`, so nothing is reported twice. Headlines that couldn't be classified are retried on the next run. To test without writing anything, run `npm run news` (or `npm run news -- --no-ai` to skip the API). Set `NEWS_ENABLED=false` to turn it off.

MAS (Singapore) is covered through the **Financial Institutions Directory**: for each firm, the licence types and the **key personnel** MAS publishes (Chief Executive, Branch Manager, Head of Treasury and so on). Key personnel have no register ID, so a person is matched by name within the firm. Find a firm's id with `npm run search -- "Julius Baer" --mas`. The full Representatives Register is not automated: it only lets you search one person by name or number, and every search is protected by Cloudflare Turnstile.

## Adding more sources

Every source lives in `src/sources/` and exposes `fetchFirm(cfg)`, `fetchEmployees(cfg)` and, optionally, `enrichEmployee(emp)`. All of them return the same normalised fields. Register a new source in `src/sources/index.js`.

- **API sources**: copy `fca.js` as a template.
- **Scraped sources**: for simple static pages, use `"source": "html"` with CSS selectors in `firms.json` (see the disabled example there). For sites that render with JavaScript or need a login, write a dedicated source, for example with Playwright.

## Files

```
src/index.js           entry point and scheduler
src/run.js             one run: fetch → diff → enrich → Sheets → Slack
src/diff.js            added / revoked / changed logic
src/sources/           fca (API), sfc, fsra, dfsa, mas, html (scrapers)
src/storage/state.js   local snapshot (data/state.json) used for diffing
src/storage/sheets.js  Google Sheets writer
src/notify/slack.js    Slack Block Kit message
```

Do not delete `data/state.json`. It is the baseline for the next run's comparison.

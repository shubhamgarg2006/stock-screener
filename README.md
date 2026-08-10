# Ledger — Equity Screener

A sector-relative fundamental screener with a static frontend hosted on GitHub
Pages. Browse the US equity universe, filter by sector/sub-industry/cap tier,
star tickers to build a watchlist, and compare a stock's trailing PE against
its sub-industry average over the last 5 years.

## How it's put together

GitHub Pages can only serve static files — it can't run Python. So the data
fetching (NASDAQ Trader FTP for the ticker universe, `yfinance` for
fundamentals/PE history) happens offline, and the results are written out as
JSON that the frontend reads:

```
backend/
  screener.py       core screening engine (universe, factor scores, news sentiment, PE history)
  build_data.py      runs the pipeline end-to-end, writes docs/data/*.json
  requirements.txt

docs/                 <- this is what GitHub Pages serves
  index.html
  styles.css
  app.js
  data/
    stocks.json        one row per ticker: sector, sub-industry, cap tier, PE, ROE, fundamental score
    pe_history.json     { ticker: [{date, pe}, ...] } for up to 5 years
    industry_pe.json    { sub-industry: [{date, avg_pe}, ...] } monthly average
    meta.json           build timestamp + universe size

.github/workflows/update-data.yml   rebuilds docs/data/*.json on a schedule and commits it
```

The repo ships with **synthetic sample data** in `docs/data/` (flagged
`is_sample_data: true` in `meta.json`) so the site works the moment you turn
on Pages. Run the pipeline once (locally or via the Action) to replace it
with real data.

## 1. Deploy the frontend

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Source**: deploy from branch `main`, folder
   `/docs`.
3. Your screener is live at `https://<you>.github.io/<repo>/` within a
   minute or two.

That's the whole hosting story — no server, no build step for the frontend
itself.

## 2. Generate real data

Locally:

```bash
cd backend
pip install -r requirements.txt
python build_data.py --max-tickers 500 --pe-history-limit 200
```

- `--max-tickers` caps how many tickers get pulled into the main universe
  table (fundamentals + sentiment-ready). Omit it to process the *entire*
  NASDAQ + NYSE/AMEX/ARCA directory — expect that to take a long time and to
  occasionally hit Yahoo rate limits; add `--pause-seconds 0.2` if you see
  failures pile up.
- `--pe-history-limit` caps how many tickers (ranked by market cap) get the
  more expensive 5-year PE history pull. 5-year history requires an extra
  quarterly-financials + monthly-price call per ticker, so this is kept
  smaller than the main universe by default.
- Commit the regenerated `docs/data/*.json` and push — Pages picks it up
  automatically.

### Keeping it fresh automatically

`.github/workflows/update-data.yml` runs the same pipeline every Saturday and
commits the refreshed JSON. Trigger it manually any time from the repo's
**Actions** tab (`Rebuild screener data → Run workflow`). Tune the
`--max-tickers` / `--pe-history-limit` flags in that file to trade off
coverage against how long each run takes on GitHub's free runners.

## 3. Using the screener

- **Filters** (left panel): search by ticker/name, sector, sub-industry, cap
  tier, or "starred only."
- **Star** any row (or the star button inside a stock's detail view) to pin
  it to the watchlist and the scrolling ticker tape at the top — starring is
  stored in your browser's `localStorage`, so it's per-device and persists
  across visits without an account.
- **Sub-industry PE chart** in the sidebar plots the 5-year average trailing
  PE across every stock in the selected sub-industry.
- **Click a row** to open a stock's detail view: its own PE line against a
  dashed sub-industry-average line, over the same 5-year window.

## What's fixed from the original draft

- The FTP host was malformed (`"://nasdaqtrader.com"`) and always raised, so
  the "complete universe" download silently fell back to a 10-ticker basket
  every run. Fixed to the real host, and the NYSE/AMEX/ARCA "other listed"
  file was added so the universe isn't NASDAQ-only.
- `ticker_list[:60]` silently capped every run. That's now an explicit
  `max_tickers` argument you control per-run instead of a buried constant.
- The sector/tier z-scores could emit `NaN` for a zero-variance peer group
  (e.g. a sub-industry with only one stock); now explicitly guarded to `0.0`.
- A stray `[Liga := [...]]` walrus assignment used as a column-selector list
  was replaced with a plain list — same result, no unused variable, no
  confusing style.
- Added `get_pe_history()`, which didn't exist before — it reconstructs
  monthly historical PE from quarterly diluted EPS (as a trailing-twelve-
  month step function) divided into monthly close price, since `yfinance`
  doesn't expose historical PE directly.

## Known limitations / roadmap

- **PE history is an approximation.** Yahoo doesn't publish historical PE
  directly; it's reconstructed from quarterly diluted EPS aligned to report
  dates. Thinly-covered or newly-listed tickers may have gaps or no history
  at all (the UI notes this per-stock rather than showing a misleading
  chart).
- **News sentiment scoring** (`score_news_impact` / `isolate_results_with_news`
  in `screener.py`) is implemented but not yet wired into the frontend — it's
  a natural next "deeper screening level" for starred tickers, since it needs
  a live fetch rather than a static snapshot.
- **Full-universe runs are slow.** Thousands of tickers × multiple Yahoo
  calls each adds up; the default GitHub Action caps at 800 tickers / 300 PE
  histories to fit comfortably in a scheduled run. Widen those caps if you
  have the patience (or split into multiple scheduled jobs by cap tier).
- Sub-industry granularity comes from `yfinance`'s `industry` field, which
  approximates but isn't identical to a formal GICS sub-industry taxonomy.

Since you mentioned you'll keep adding to this: `screener.py` and
`build_data.py` are the two files to extend on the data side (new factors,
the news-sentiment wiring, additional screens), and `app.js` / `styles.css`
on the frontend side. The JSON contract between them (`docs/data/*.json`) is
intentionally simple so new fields can be added without restructuring
anything.

"""
build_data.py
--------------
Runs the screener end-to-end and writes the JSON snapshots the static
frontend (docs/) reads. This is the only thing that needs Python — GitHub
Pages just serves whatever lands in docs/data/.

Run locally:
    python backend/build_data.py --max-tickers 500

In CI, .github/workflows/update-data.yml runs this on a schedule and commits
the refreshed JSON back into docs/data/.

Output files (all written to docs/data/):
    stocks.json       - one row per ticker: sector, industry, cap tier,
                         market cap, PE, ROE, fundamental_score
    pe_history.json   - { ticker: [{date, pe}, ...] } for the last N years
    industry_pe.json  - { industry: [{date, avg_pe}, ...] } monthly average
                         across every ticker in that industry with history
    meta.json         - build timestamp, universe size, config used
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from screener import InstitutionalNewsScreener  # noqa: E402

OUTPUT_DIR = Path(__file__).parent.parent / "docs" / "data"


def build(max_tickers: int | None, years: int, pause_seconds: float, pe_history_limit: int) -> None:
    screener = InstitutionalNewsScreener()

    all_tickers = screener.download_complete_us_universe()
    universe_df = screener.build_tiered_factor_matrix(
        all_tickers, max_tickers=max_tickers, pause_seconds=pause_seconds
    )

    if universe_df.empty:
        print("No data collected — aborting write.")
        return

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # ---- stocks.json ------------------------------------------------- #
    stocks_records = universe_df.to_dict(orient="records")
    with open(OUTPUT_DIR / "stocks.json", "w") as f:
        json.dump(stocks_records, f, indent=2, default=float)
    print(f"Wrote {len(stocks_records)} rows to stocks.json")

    # ---- pe_history.json + industry_pe.json --------------------------- #
    # PE history is the expensive part (extra API calls per ticker), so it's
    # capped separately from the main universe size via pe_history_limit,
    # prioritized by market cap so the most-followed names get charts first.
    pe_candidates = universe_df.sort_values("market_cap", ascending=False)
    if pe_history_limit is not None:
        pe_candidates = pe_candidates.head(pe_history_limit)

    pe_history: dict[str, list] = {}
    industry_points: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))

    for _, row in pe_candidates.iterrows():
        ticker = row["ticker"]
        industry = row["industry"]
        history = screener.get_pe_history(ticker, years=years)
        if not history:
            continue
        pe_history[ticker] = history
        for point in history:
            industry_points[industry][point["date"]].append(point["pe"])

    with open(OUTPUT_DIR / "pe_history.json", "w") as f:
        json.dump(pe_history, f, indent=2)
    print(f"Wrote PE history for {len(pe_history)} tickers to pe_history.json")

    industry_pe = {
        industry: [
            {"date": date, "avg_pe": round(statistics.mean(values), 2), "n": len(values)}
            for date, values in sorted(dates.items())
        ]
        for industry, dates in industry_points.items()
    }
    with open(OUTPUT_DIR / "industry_pe.json", "w") as f:
        json.dump(industry_pe, f, indent=2)
    print(f"Wrote industry PE averages for {len(industry_pe)} industries to industry_pe.json")

    # ---- meta.json ------------------------------------------------- #
    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "universe_size": len(stocks_records),
        "pe_history_tickers": len(pe_history),
        "years_of_pe_history": years,
    }
    with open(OUTPUT_DIR / "meta.json", "w") as f:
        json.dump(meta, f, indent=2)
    print("Wrote meta.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build JSON data snapshots for the screener frontend.")
    parser.add_argument(
        "--max-tickers",
        type=int,
        default=None,
        help="Cap the number of tickers processed for the main universe (default: no cap — full universe).",
    )
    parser.add_argument(
        "--pe-history-limit",
        type=int,
        default=300,
        help="Cap the number of tickers to fetch 5yr PE history for, ranked by market cap (default: 300).",
    )
    parser.add_argument("--years", type=int, default=5, help="Years of PE history to fetch (default: 5).")
    parser.add_argument(
        "--pause-seconds",
        type=float,
        default=0.0,
        help="Delay between per-ticker requests, useful for very large runs (default: 0).",
    )
    args = parser.parse_args()

    build(
        max_tickers=args.max_tickers,
        years=args.years,
        pause_seconds=args.pause_seconds,
        pe_history_limit=args.pe_history_limit,
    )

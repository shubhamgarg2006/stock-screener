"""
InstitutionalNewsScreener
--------------------------
Core screening engine: builds a tiered, sector-relative fundamental factor
matrix for the US equity universe, scores recent news sentiment per ticker,
and computes trailing PE history for a stock vs. its industry average.

Fixes applied vs. the original draft:
  * FTP host was malformed ("://nasdaqtrader.com") and always raised, so the
    "complete universe" download silently fell back to a 10-ticker basket.
    Fixed to the real host + path, and added the NYSE/AMEX/ARCA "other
    listed" file so the universe isn't NASDAQ-only.
  * `ticker_list[:60]` silently capped every run at 60 names. That's now an
    explicit, configurable `max_tickers` argument (default: no cap) so the
    caller decides the trade-off between coverage and runtime.
  * `zscore(x) if len(x) > 1 else 0.0` could still emit NaN for a
    zero-variance group (all peers identical). Now explicitly filled to 0.0.
  * The `[Liga := [...]]` walrus-as-column-selector in the original was
    debug-leftover style and is now a plain column list.
  * Added `get_pe_history()` to support the "PE vs industry, last 5 years"
    chart the frontend needs. yfinance doesn't expose historical PE
    directly, so this reconstructs it from monthly close price divided by
    trailing-twelve-month EPS, using quarterly diluted EPS as a step
    function aligned to report dates.
"""

from __future__ import annotations

import ftplib
import io
import time
from datetime import datetime, timedelta
from typing import Optional

import nltk
import pandas as pd
import yfinance as yf
from nltk.sentiment.vader import SentimentIntensityAnalyzer
from scipy.stats import zscore

try:
    nltk.data.find("sentiment/vader_lexicon.zip")
except LookupError:
    nltk.download("vader_lexicon", quiet=True)


CAP_TIERS = ["Mega Cap", "Large Cap", "Mid Cap", "Small/Micro Cap"]


class InstitutionalNewsScreener:
    def __init__(self):
        self.universe_df = pd.DataFrame()
        self.sia = SentimentIntensityAnalyzer()
        self.sia.lexicon.update(
            {
                "beats": 2.0,
                "misses": -2.0,
                "raised": 1.5,
                "lowered": -1.5,
                "guidance": 0.5,
                "subpoena": -2.5,
                "lawsuit": -2.0,
                "upgrade": 1.5,
                "downgrade": -1.5,
                "restructures": 0.5,
                "bankrupt": -4.0,
            }
        )

    # ------------------------------------------------------------------ #
    # Universe construction
    # ------------------------------------------------------------------ #
    def _fetch_nasdaqtrader_file(self, ftp: ftplib.FTP, filename: str) -> pd.DataFrame:
        buffer = io.BytesIO()
        ftp.retrbinary(f"RETR SymbolDirectory/{filename}", buffer.write)
        buffer.seek(0)
        # Last line of these files is a footer ("File Creation Time...")
        df = pd.read_csv(buffer, sep="|")
        return df.iloc[:-1]

    def download_complete_us_universe(self) -> list:
        """Connects to the NASDAQ Trader FTP and pulls both the NASDAQ-listed
        and "other listed" (NYSE / NYSE American / ARCA / BATS) symbol
        directories, so the universe isn't NASDAQ-only."""
        print("Connecting to NASDAQ Trader FTP for full universe data...")
        tickers: list[str] = []
        try:
            ftp = ftplib.FTP("ftp.nasdaqtrader.com")
            ftp.login()  # anonymous login

            nasdaq_df = self._fetch_nasdaqtrader_file(ftp, "nasdaqlisted.txt")
            nasdaq_df = nasdaq_df[nasdaq_df["Test Issue"] == "N"]
            tickers += nasdaq_df["Symbol"].dropna().tolist()

            try:
                other_df = self._fetch_nasdaqtrader_file(ftp, "otherlisted.txt")
                other_df = other_df[other_df["Test Issue"] == "N"]
                symbol_col = "ACT Symbol" if "ACT Symbol" in other_df.columns else "Symbol"
                tickers += other_df[symbol_col].dropna().tolist()
            except Exception as e:
                print(f"  (otherlisted.txt skipped: {e})")

            ftp.quit()

            tickers = sorted(set(tickers))
            print(f"--> Found {len(tickers)} live US equities.")
            return tickers
        except Exception as e:
            print(f"FTP Error: {e}. Falling back to structural index basket.")
            return ["AAPL", "MSFT", "XOM", "JPM", "BAC", "WMT", "GE", "F", "AMD", "PLTR"]

    def assign_cap_tier(self, market_cap: Optional[float]) -> str:
        if market_cap is None:
            return "Unknown"
        elif market_cap >= 200_000_000_000:
            return "Mega Cap"
        elif 10_000_000_000 <= market_cap < 200_000_000_000:
            return "Large Cap"
        elif 2_000_000_000 <= market_cap < 10_000_000_000:
            return "Mid Cap"
        elif 100_000_000 <= market_cap < 2_000_000_000:
            return "Small/Micro Cap"
        else:
            return "Dropped"

    def build_tiered_factor_matrix(
        self,
        ticker_list: list,
        max_tickers: Optional[int] = None,
        pause_seconds: float = 0.0,
    ) -> pd.DataFrame:
        """Gathers core metrics, assigns tier buckets, and maps cross-sectional
        peer ranks. `max_tickers=None` processes the full list; pass a number
        to cap runtime during development. `pause_seconds` adds a small delay
        between requests to stay polite to Yahoo's endpoints on large runs."""
        print("Fetching metrics and assigning market cap tiers...")
        pool = []
        processing_queue = ticker_list if max_tickers is None else ticker_list[:max_tickers]

        for i, ticker in enumerate(processing_queue):
            try:
                clean_ticker = ticker.replace("$", "-").replace(".", "-").strip()
                stock = yf.Ticker(clean_ticker)
                info = stock.info

                market_cap = info.get("marketCap", 0)
                tier = self.assign_cap_tier(market_cap)

                if tier in ("Dropped", "Unknown") or not market_cap:
                    continue

                pool.append(
                    {
                        "ticker": clean_ticker,
                        "cap_tier": tier,
                        "sector": info.get("sector", "Unknown"),
                        "industry": info.get("industry", "Unknown"),
                        "market_cap": market_cap,
                        "pe_ratio": info.get("trailingPE"),
                        "roe": info.get("returnOnEquity"),
                        "name": info.get("shortName", clean_ticker),
                    }
                )
            except Exception:
                continue

            if pause_seconds:
                time.sleep(pause_seconds)

        self.universe_df = pd.DataFrame(pool)
        if self.universe_df.empty:
            return self.universe_df

        self.universe_df["pe_ratio"] = self.universe_df["pe_ratio"].fillna(
            self.universe_df["pe_ratio"].median()
        )
        self.universe_df["roe"] = self.universe_df["roe"].fillna(self.universe_df["roe"].median())
        self.universe_df["raw_value"] = 1 / self.universe_df["pe_ratio"].replace(0, pd.NA)

        print("Computing multi-tier sector relative z-scores...")
        group_fields = ["cap_tier", "sector"]

        def _safe_zscore(x: pd.Series) -> pd.Series:
            if len(x) > 1 and x.std(ddof=0) > 0:
                return pd.Series(zscore(x), index=x.index)
            return pd.Series(0.0, index=x.index)

        self.universe_df["z_value"] = self.universe_df.groupby(group_fields)["raw_value"].transform(
            _safe_zscore
        )
        self.universe_df["z_quality"] = self.universe_df.groupby(group_fields)["roe"].transform(
            _safe_zscore
        )
        self.universe_df["fundamental_score"] = (
            self.universe_df["z_value"] * 0.5 + self.universe_df["z_quality"] * 0.5
        )
        return self.universe_df

    # ------------------------------------------------------------------ #
    # News sentiment
    # ------------------------------------------------------------------ #
    def score_news_impact(self, ticker: str) -> dict:
        try:
            stock = yf.Ticker(ticker)
            news_feed = stock.news
            if not news_feed:
                return {"news_impact": 0.0, "outlook": "NEUTRAL"}

            scores = []
            for item in news_feed[:5]:
                headline = item.get("title", "")
                sentiment_score = self.sia.polarity_scores(headline)["compound"]
                scores.append(sentiment_score)

            avg_score = sum(scores) / len(scores) if scores else 0.0

            if avg_score >= 0.35:
                label = "STRONG BULLISH"
            elif 0.05 < avg_score < 0.35:
                label = "MILD BULLISH"
            elif -0.05 <= avg_score <= 0.05:
                label = "NEUTRAL"
            elif -0.35 < avg_score < -0.05:
                label = "MILD BEARISH"
            else:
                label = "STRONG BEARISH"

            return {"news_impact": round(avg_score, 3), "outlook": label}
        except Exception:
            return {"news_impact": 0.0, "outlook": "ERROR"}

    def isolate_results_with_news(self, cap_tier: str, sector_name: str) -> pd.DataFrame:
        if self.universe_df.empty:
            return pd.DataFrame()

        filtered_df = self.universe_df[
            (self.universe_df["cap_tier"].str.lower() == cap_tier.lower())
            & (self.universe_df["sector"].str.lower() == sector_name.lower())
        ].copy()

        if filtered_df.empty:
            return pd.DataFrame()

        print(f"Streaming news headlines for matches in {cap_tier} {sector_name}...")
        impact_scores, outlook_labels = [], []
        for ticker in filtered_df["ticker"]:
            news_metrics = self.score_news_impact(ticker)
            impact_scores.append(news_metrics["news_impact"])
            outlook_labels.append(news_metrics["outlook"])

        filtered_df["news_impact"] = impact_scores
        filtered_df["perceived_outlook"] = outlook_labels

        result_columns = [
            "ticker",
            "market_cap",
            "fundamental_score",
            "news_impact",
            "perceived_outlook",
        ]
        return filtered_df.sort_values(by="fundamental_score", ascending=False)[result_columns]

    # ------------------------------------------------------------------ #
    # Historical PE (for the "stock vs industry, 5yr" chart)
    # ------------------------------------------------------------------ #
    def get_pe_history(self, ticker: str, years: int = 5) -> list[dict]:
        """Approximates monthly historical PE = close price / trailing-twelve-
        month diluted EPS. TTM EPS is built as a step function from quarterly
        diluted EPS, updated at each report date. Returns [] if insufficient
        data (common for newly-listed or thinly-covered tickers)."""
        try:
            stock = yf.Ticker(ticker)

            q_income = stock.quarterly_income_stmt
            if q_income is None or q_income.empty or "Diluted EPS" not in q_income.index:
                return []

            eps_row = q_income.loc["Diluted EPS"].dropna().sort_index()
            if len(eps_row) < 4:
                return []

            # Trailing-twelve-month EPS at each report date = sum of last 4 quarters
            ttm_eps = eps_row.rolling(window=4).sum().dropna()
            if ttm_eps.empty:
                return []

            end = datetime.today()
            start = end - timedelta(days=365 * years + 30)
            prices = stock.history(start=start, end=end, interval="1mo")
            if prices.empty:
                return []
            prices.index = prices.index.tz_localize(None)

            history = []
            for date, close in prices["Close"].items():
                eligible = ttm_eps[ttm_eps.index.tz_localize(None) <= date]
                if eligible.empty:
                    continue
                latest_ttm_eps = eligible.iloc[-1]
                if latest_ttm_eps <= 0:
                    continue
                history.append(
                    {
                        "date": date.strftime("%Y-%m-%d"),
                        "pe": round(float(close) / float(latest_ttm_eps), 2),
                    }
                )
            return history
        except Exception:
            return []


if __name__ == "__main__":
    screener = InstitutionalNewsScreener()
    all_us_stocks = screener.download_complete_us_universe()
    # Cap during manual testing; the build pipeline controls this for real runs.
    screener.build_tiered_factor_matrix(all_us_stocks, max_tickers=60)

    target_tier = "Small/Micro Cap"
    target_sector = "Healthcare"
    final_dashboard = screener.isolate_results_with_news(target_tier, target_sector)

    print(f"\n=== SYSTEMATIC {target_tier.upper()} MATRIX | SECTOR: {target_sector.upper()} ===")
    if not final_dashboard.empty:
        final_dashboard["market_cap"] = final_dashboard["market_cap"].apply(
            lambda x: f"${x/1e9:.2f}B" if x >= 1_000_000_000 else f"${x/1e6:.2f}M"
        )
        print(final_dashboard.to_string(index=False))
    else:
        print("No assets found matching that criteria in this processing slice.")

(() => {
  "use strict";

  const DATA_DIR = "data";
  const STAR_KEY = "ledger.starredTickers.v1";

  const state = {
    stocks: [],
    peHistory: {},
    industryPE: {},
    starred: new Set(loadStars()),
    filters: { search: "", sector: "", industry: "", tier: "", starredOnly: false },
    sort: "fundamental_score_desc",
  };

  const els = {
    tape: document.getElementById("tape"),
    metaUniverse: document.getElementById("metaUniverse"),
    metaBuilt: document.getElementById("metaBuilt"),
    searchInput: document.getElementById("searchInput"),
    sectorSelect: document.getElementById("sectorSelect"),
    industrySelect: document.getElementById("industrySelect"),
    tierSelect: document.getElementById("tierSelect"),
    starredOnly: document.getElementById("starredOnly"),
    sortSelect: document.getElementById("sortSelect"),
    tableBody: document.getElementById("stockTableBody"),
    resultCount: document.getElementById("resultCount"),
    emptyState: document.getElementById("emptyState"),
    starCount: document.getElementById("starCount"),
    watchlist: document.getElementById("watchlist"),
    clearStars: document.getElementById("clearStars"),
    industryChartBox: document.getElementById("industryChartBox"),
    industryChartHint: document.getElementById("industryChartHint"),
    industryChartCanvas: document.getElementById("industryChart"),
    modalBackdrop: document.getElementById("modalBackdrop"),
    modalClose: document.getElementById("modalClose"),
    modalTicker: document.getElementById("modalTicker"),
    modalName: document.getElementById("modalName"),
    modalMeta: document.getElementById("modalMeta"),
    modalStarBtn: document.getElementById("modalStarBtn"),
    modalStarLabel: document.getElementById("modalStarLabel"),
    modalPE: document.getElementById("modalPE"),
    modalROE: document.getElementById("modalROE"),
    modalCap: document.getElementById("modalCap"),
    modalScore: document.getElementById("modalScore"),
    modalChartCanvas: document.getElementById("modalChart"),
    modalChartNote: document.getElementById("modalChartNote"),
  };

  let industryChart = null;
  let modalChart = null;
  let activeModalTicker = null;

  // ---------------------------------------------------------------- utils
  function loadStars() {
    try {
      return JSON.parse(localStorage.getItem(STAR_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveStars() {
    localStorage.setItem(STAR_KEY, JSON.stringify([...state.starred]));
  }

  function fmtCap(n) {
    if (n == null) return "—";
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    return `$${n.toLocaleString()}`;
  }

  function fmtPct(n) {
    if (n == null) return "—";
    return `${(n * 100).toFixed(1)}%`;
  }

  function fmtScore(n) {
    if (n == null) return "—";
    return n.toFixed(2);
  }

  function fmtNum(n, digits = 1) {
    if (n == null) return "—";
    return n.toFixed(digits);
  }

  // ---------------------------------------------------------------- load
  async function loadData() {
    const [stocks, peHistory, industryPE, meta] = await Promise.all([
      fetch(`${DATA_DIR}/stocks.json`).then((r) => r.json()),
      fetch(`${DATA_DIR}/pe_history.json`).then((r) => r.json()),
      fetch(`${DATA_DIR}/industry_pe.json`).then((r) => r.json()),
      fetch(`${DATA_DIR}/meta.json`).then((r) => r.json()).catch(() => null),
    ]);
    state.stocks = stocks;
    state.peHistory = peHistory;
    state.industryPE = industryPE;

    if (meta) {
      els.metaUniverse.textContent = `${meta.universe_size} tickers`;
      const built = meta.built_at ? new Date(meta.built_at) : null;
      els.metaBuilt.textContent = built
        ? `updated ${built.toLocaleDateString(undefined, { month: "short", day: "numeric" })}${meta.is_sample_data ? " (sample data)" : ""}`
        : "";
    }

    populateFilterOptions();
    renderTape();
    renderWatchlist();
    applyFiltersAndRender();
  }

  function populateFilterOptions() {
    const sectors = [...new Set(state.stocks.map((s) => s.sector))].sort();
    for (const sector of sectors) {
      const opt = document.createElement("option");
      opt.value = sector;
      opt.textContent = sector;
      els.sectorSelect.appendChild(opt);
    }

    const tiers = ["Mega Cap", "Large Cap", "Mid Cap", "Small/Micro Cap"];
    for (const tier of tiers) {
      if (!state.stocks.some((s) => s.cap_tier === tier)) continue;
      const opt = document.createElement("option");
      opt.value = tier;
      opt.textContent = tier;
      els.tierSelect.appendChild(opt);
    }

    refreshIndustryOptions();
  }

  function refreshIndustryOptions() {
    const prev = els.industrySelect.value;
    els.industrySelect.innerHTML = '<option value="">All sub-industries</option>';
    const pool = state.filters.sector
      ? state.stocks.filter((s) => s.sector === state.filters.sector)
      : state.stocks;
    const industries = [...new Set(pool.map((s) => s.industry))].sort();
    for (const industry of industries) {
      const opt = document.createElement("option");
      opt.value = industry;
      opt.textContent = industry;
      els.industrySelect.appendChild(opt);
    }
    if (industries.includes(prev)) els.industrySelect.value = prev;
    else state.filters.industry = "";
  }

  // ---------------------------------------------------------------- tape
  function renderTape() {
    const starredStocks = state.stocks.filter((s) => state.starred.has(s.ticker));
    if (starredStocks.length === 0) {
      els.tape.innerHTML = '<span class="tape-empty">Star a ticker to pin it here —</span>';
      return;
    }
    const items = starredStocks
      .map((s) => {
        const pe = s.pe_ratio != null ? s.pe_ratio.toFixed(1) : "—";
        return `<span class="tape-item">${s.ticker} <span class="tape-pe">PE ${pe}</span></span>`;
      })
      .join('<span class="tape-item">·</span>');
    // duplicate content so the loop scroll has no visible seam
    els.tape.innerHTML = items + '<span class="tape-item">·</span>' + items;
  }

  // ---------------------------------------------------------------- table
  function applyFiltersAndRender() {
    const f = state.filters;
    let rows = state.stocks.filter((s) => {
      if (f.sector && s.sector !== f.sector) return false;
      if (f.industry && s.industry !== f.industry) return false;
      if (f.tier && s.cap_tier !== f.tier) return false;
      if (f.starredOnly && !state.starred.has(s.ticker)) return false;
      if (f.search) {
        const q = f.search.toLowerCase();
        if (!s.ticker.toLowerCase().includes(q) && !(s.name || "").toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });

    rows = sortRows(rows, state.sort);

    els.resultCount.textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}`;
    els.emptyState.hidden = rows.length !== 0;
    els.tableBody.innerHTML = "";

    const frag = document.createDocumentFragment();
    for (const s of rows) {
      frag.appendChild(buildRow(s));
    }
    els.tableBody.appendChild(frag);

    try {
      renderIndustryChart();
    } catch (err) {
      console.error("Industry chart render failed:", err);
    }
  }

  function sortRows(rows, sortKey) {
    const [field, dir] = sortKey.split(/_(asc|desc)$/).filter(Boolean);
    const mult = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (field === "ticker") return mult * a.ticker.localeCompare(b.ticker);
      const av = a[field] ?? -Infinity;
      const bv = b[field] ?? -Infinity;
      return mult * (av - bv);
    });
  }

  function buildRow(s) {
    const tr = document.createElement("tr");
    tr.dataset.ticker = s.ticker;

    const starTd = document.createElement("td");
    starTd.className = "col-star";
    const starBtn = document.createElement("button");
    starBtn.className = "star-toggle" + (state.starred.has(s.ticker) ? " starred" : "");
    starBtn.setAttribute("aria-pressed", state.starred.has(s.ticker));
    starBtn.setAttribute("aria-label", `Star ${s.ticker}`);
    starBtn.textContent = "★";
    starBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleStar(s.ticker);
    });
    starTd.appendChild(starBtn);

    const scoreClass = s.fundamental_score > 0 ? "score-pos" : s.fundamental_score < 0 ? "score-neg" : "";

    const restHtml = `
      <td class="ticker-cell">${s.ticker}<span class="subtext">${s.name || ""}</span></td>
      <td>${s.sector}<span class="subtext">${s.industry}</span></td>
      <td>${s.cap_tier}</td>
      <td class="col-num">${fmtCap(s.market_cap)}</td>
      <td class="col-num">${fmtNum(s.pe_ratio)}</td>
      <td class="col-num">${fmtPct(s.roe)}</td>
      <td class="col-num ${scoreClass}">${fmtScore(s.fundamental_score)}</td>
    `;
    tr.appendChild(starTd);
    tr.insertAdjacentHTML("beforeend", restHtml);

    tr.addEventListener("click", () => openModal(s.ticker));
    return tr;
  }

  function toggleStar(ticker) {
    if (state.starred.has(ticker)) state.starred.delete(ticker);
    else state.starred.add(ticker);
    saveStars();
    renderTape();
    renderWatchlist();
    // update just the affected row + count without a full re-render
    const row = els.tableBody.querySelector(`tr[data-ticker="${CSS.escape(ticker)}"]`);
    if (row) {
      const btn = row.querySelector(".star-toggle");
      const isStarred = state.starred.has(ticker);
      btn.classList.toggle("starred", isStarred);
      btn.setAttribute("aria-pressed", isStarred);
    }
    if (state.filters.starredOnly) applyFiltersAndRender();
    if (activeModalTicker === ticker) syncModalStarButton();
  }

  // ---------------------------------------------------------------- watchlist
  function renderWatchlist() {
    els.starCount.textContent = state.starred.size;
    els.watchlist.innerHTML = "";
    if (state.starred.size === 0) {
      els.watchlist.innerHTML = '<li class="watchlist-empty">Nothing starred yet.</li>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const ticker of state.starred) {
      const li = document.createElement("li");
      li.className = "watchlist-item";
      li.innerHTML = `<span>${ticker}</span>`;
      const removeBtn = document.createElement("button");
      removeBtn.className = "watchlist-remove";
      removeBtn.setAttribute("aria-label", `Remove ${ticker}`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleStar(ticker);
        applyFiltersAndRender();
      });
      li.addEventListener("click", () => openModal(ticker));
      li.appendChild(removeBtn);
      frag.appendChild(li);
    }
    els.watchlist.appendChild(frag);
  }

  // ---------------------------------------------------------------- industry chart
  function renderIndustryChart() {
    const industry = state.filters.industry;
    if (!industry || !state.industryPE[industry]) {
      els.industryChartBox.hidden = true;
      els.industryChartHint.hidden = false;
      els.industryChartHint.textContent = industry
        ? "No PE history available yet for this sub-industry."
        : "Select a sub-industry to plot its average trailing PE.";
      return;
    }
    const points = state.industryPE[industry];
    els.industryChartHint.hidden = true;
    els.industryChartBox.hidden = false;

    const labels = points.map((p) => p.date);
    const data = points.map((p) => p.avg_pe);

    if (industryChart) industryChart.destroy();
    industryChart = new Chart(els.industryChartCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: `${industry} avg PE`,
            data,
            borderColor: getCssVar("--accent"),
            backgroundColor: "transparent",
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.15,
          },
        ],
      },
      options: baseChartOptions(false),
    });
  }

  // ---------------------------------------------------------------- modal
  function openModal(ticker) {
    const stock = state.stocks.find((s) => s.ticker === ticker);
    if (!stock) return;
    activeModalTicker = ticker;

    els.modalTicker.textContent = stock.ticker;
    els.modalName.textContent = stock.name || "";
    els.modalMeta.textContent = `${stock.sector} — ${stock.industry} — ${stock.cap_tier}`;
    els.modalPE.textContent = fmtNum(stock.pe_ratio);
    els.modalROE.textContent = fmtPct(stock.roe);
    els.modalCap.textContent = fmtCap(stock.market_cap);
    els.modalScore.textContent = fmtScore(stock.fundamental_score);

    syncModalStarButton();
    els.modalBackdrop.hidden = false;
    els.modalClose.focus();

    try {
      renderModalChart(stock);
    } catch (err) {
      console.error("Chart render failed:", err);
      els.modalChartNote.textContent = "Chart couldn't be rendered.";
    }
  }

  function syncModalStarButton() {
    const isStarred = state.starred.has(activeModalTicker);
    els.modalStarBtn.setAttribute("aria-pressed", isStarred);
    els.modalStarLabel.textContent = isStarred ? "Starred" : "Star";
  }

  function closeModal() {
    els.modalBackdrop.hidden = true;
    activeModalTicker = null;
  }

  function renderModalChart(stock) {
    const stockSeries = state.peHistory[stock.ticker];
    const industrySeries = state.industryPE[stock.industry];

    if (modalChart) modalChart.destroy();

    if (!stockSeries || stockSeries.length === 0) {
      els.modalChartNote.textContent = "No 5-year PE history available for this ticker yet.";
      els.modalChartCanvas.getContext("2d").clearRect(0, 0, 9999, 9999);
      return;
    }

    const labels = stockSeries.map((p) => p.date);
    const industryMap = new Map((industrySeries || []).map((p) => [p.date, p.avg_pe]));

    const datasets = [
      {
        label: stock.ticker,
        data: stockSeries.map((p) => p.pe),
        borderColor: getCssVar("--accent"),
        backgroundColor: "transparent",
        borderWidth: 1.75,
        pointRadius: 0,
        tension: 0.15,
      },
    ];

    if (industrySeries && industrySeries.length > 0) {
      datasets.push({
        label: `${stock.industry} avg`,
        data: labels.map((d) => industryMap.get(d) ?? null),
        borderColor: getCssVar("--text-dim"),
        backgroundColor: "transparent",
        borderWidth: 1.25,
        borderDash: [4, 3],
        pointRadius: 0,
        tension: 0.15,
        spanGaps: true,
      });
      els.modalChartNote.textContent = "";
    } else {
      els.modalChartNote.textContent = "Sub-industry average not available for comparison yet.";
    }

    modalChart = new Chart(els.modalChartCanvas, {
      type: "line",
      data: { labels, datasets },
      options: baseChartOptions(true),
    });
  }

  function baseChartOptions(showLegend) {
    const gridColor = "rgba(139, 147, 167, 0.12)";
    const tickColor = getCssVar("--text-faint");
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: showLegend,
          labels: { color: getCssVar("--text-dim"), font: { family: "IBM Plex Mono", size: 11 }, boxWidth: 12 },
        },
        tooltip: {
          backgroundColor: "#05070C",
          borderColor: getCssVar("--border"),
          borderWidth: 1,
          titleFont: { family: "IBM Plex Mono", size: 11 },
          bodyFont: { family: "IBM Plex Mono", size: 11 },
        },
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { family: "IBM Plex Mono", size: 9 }, maxTicksLimit: 8 },
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { family: "IBM Plex Mono", size: 9 } },
        },
      },
    };
  }

  function getCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---------------------------------------------------------------- events
  els.searchInput.addEventListener("input", (e) => {
    state.filters.search = e.target.value.trim();
    applyFiltersAndRender();
  });

  els.sectorSelect.addEventListener("change", (e) => {
    state.filters.sector = e.target.value;
    refreshIndustryOptions();
    applyFiltersAndRender();
  });

  els.industrySelect.addEventListener("change", (e) => {
    state.filters.industry = e.target.value;
    applyFiltersAndRender();
  });

  els.tierSelect.addEventListener("change", (e) => {
    state.filters.tier = e.target.value;
    applyFiltersAndRender();
  });

  els.starredOnly.addEventListener("change", (e) => {
    state.filters.starredOnly = e.target.checked;
    applyFiltersAndRender();
  });

  els.sortSelect.addEventListener("change", (e) => {
    state.sort = e.target.value;
    applyFiltersAndRender();
  });

  els.clearStars.addEventListener("click", () => {
    state.starred.clear();
    saveStars();
    renderTape();
    renderWatchlist();
    applyFiltersAndRender();
  });

  els.modalClose.addEventListener("click", closeModal);
  els.modalBackdrop.addEventListener("click", (e) => {
    if (e.target === els.modalBackdrop) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.modalBackdrop.hidden) closeModal();
  });
  els.modalStarBtn.addEventListener("click", () => {
    if (activeModalTicker) toggleStar(activeModalTicker);
  });

  loadData().catch((err) => {
    console.error(err);
    els.tableBody.innerHTML = `<tr><td colspan="8">Couldn't load screener data. If you're running this locally, serve the docs/ folder over HTTP (e.g. \`python -m http.server\`) rather than opening index.html directly.</td></tr>`;
  });
})();

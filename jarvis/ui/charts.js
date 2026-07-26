/* J.A.R.V.I.S. — live TradingView charts overlay.

   A full-screen candlestick chart that drops over the HUD (same show/hide
   pattern as the #approval modal). It opens from the topbar CHARTS button or by
   clicking any row in the CRYPTO / CURRENCY panels — those rows already carry
   the symbol, so this file reads it by event-delegation and needs NO changes to
   app.js. TradingView's tv.js is loaded lazily on first open (real live data,
   no API key), and the widget is rebuilt whenever the symbol changes. */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TV_SRC = "https://s3.tradingview.com/tv.js";
  const DEFAULT_SYMBOL = "BINANCE:BTCUSDT";

  // Quick-pick chips shown along the top of the overlay.
  const QUICK = [
    { label: "BTC", sym: "BINANCE:BTCUSDT" },
    { label: "ETH", sym: "BINANCE:ETHUSDT" },
    { label: "SOL", sym: "BINANCE:SOLUSDT" },
    { label: "BNB", sym: "BINANCE:BNBUSDT" },
    { label: "XRP", sym: "BINANCE:XRPUSDT" },
    { label: "DOGE", sym: "BINANCE:DOGEUSDT" },
    { label: "USD/INR", sym: "FX_IDC:USDINR" },
    { label: "GOLD", sym: "TVC:GOLD" },
  ];

  let tvLoading = null;      // Promise while tv.js is downloading
  let currentSymbol = DEFAULT_SYMBOL;

  // ---- symbol normalisation ------------------------------------------------
  // Turn whatever a row/input gives us into an exchange-qualified TradingView
  // symbol. "BTC" -> BINANCE:BTCUSDT, "USD/INR" -> FX_IDC:USDINR, and an already
  // qualified "BINANCE:ETHUSDT" is passed through untouched.
  function normalizeSymbol(raw) {
    let s = String(raw || "").trim().toUpperCase();
    if (!s) return DEFAULT_SYMBOL;
    if (s.includes(":")) return s;                       // already qualified

    // Forex pair like USD/INR or USDINR (six letters, no digits).
    const fx = s.replace(/\s|\//g, "");
    if (/^[A-Z]{6}$/.test(fx) && !/USDT$|USDC$/.test(fx)) return "FX_IDC:" + fx;

    // Crypto: keep an existing quote (needs a base in front, e.g. ETHBTC/BTCUSDT)
    // else default to USDT on Binance. A bare base like "ETH" must NOT be read as
    // already-quoted — it becomes ETHUSDT, not the non-existent symbol "ETH".
    const core = s.replace(/[^A-Z0-9]/g, "");
    if (!core) return DEFAULT_SYMBOL;
    if (/^[A-Z0-9]{2,}(USDT|USDC|USD|BTC|ETH)$/.test(core)) return "BINANCE:" + core;
    return "BINANCE:" + core + "USDT";
  }

  // ---- tv.js loader --------------------------------------------------------
  function loadTradingView() {
    if (window.TradingView) return Promise.resolve();
    if (tvLoading) return tvLoading;
    tvLoading = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = TV_SRC;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error("tv.js failed to load"));
      document.head.appendChild(el);
    });
    return tvLoading;
  }

  // ---- widget --------------------------------------------------------------
  function buildWidget(symbol) {
    const host = $("tv_chart");
    if (!host || !window.TradingView) return;
    host.innerHTML = "";                                  // rebuild fresh
    currentSymbol = symbol;
    // eslint-disable-next-line no-new
    new window.TradingView.widget({
      container_id: "tv_chart",
      autosize: true,
      symbol: symbol,
      interval: "60",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",                                         // candles
      locale: "en",
      toolbar_bg: "#0a0402",
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      details: true,
      studies: ["RSI@tv-basicstudies"],
      backgroundColor: "rgba(10,4,2,1)",
      gridColor: "rgba(255,180,60,0.06)",
    });
    markActiveChip(symbol);
  }

  function markActiveChip(symbol) {
    document.querySelectorAll("#ch-picker .ch-chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.sym === symbol);
    });
  }

  // ---- open / close --------------------------------------------------------
  async function open(rawSymbol) {
    const symbol = normalizeSymbol(rawSymbol || currentSymbol);
    $("charts").classList.remove("hidden");
    try {
      await loadTradingView();
      buildWidget(symbol);
    } catch (e) {
      $("tv_chart").innerHTML =
        '<div class="ch-err">Live chart unavailable — could not reach ' +
        'TradingView. Check the internet connection.</div>';
    }
  }

  function close() {
    $("charts").classList.add("hidden");
  }

  // Expose for other scripts / voice commands ("show me the BTC chart").
  window.openCharts = open;
  window.closeCharts = close;

  // ---- wire up -------------------------------------------------------------
  function buildPicker() {
    const wrap = $("ch-picker");
    if (!wrap) return;
    wrap.innerHTML = "";
    QUICK.forEach((q) => {
      const b = document.createElement("button");
      b.className = "ch-chip";
      b.textContent = q.label;
      b.dataset.sym = q.sym;
      b.onclick = () => buildWidget(q.sym);
      wrap.appendChild(b);
    });
  }

  function init() {
    buildPicker();

    const btn = $("charts-btn");
    if (btn) btn.onclick = () => open(currentSymbol);

    const closeBtn = $("ch-close");
    if (closeBtn) closeBtn.onclick = close;

    const input = $("ch-input");
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const v = input.value.trim();
        if (v) buildWidget(normalizeSymbol(v));
        input.value = "";
      });
    }

    // Close on Escape or on a click of the dimmed backdrop.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("charts").classList.contains("hidden")) close();
    });
    $("charts").addEventListener("click", (e) => {
      if (e.target && e.target.id === "charts") close();
    });

    // Delegated row clicks: any CRYPTO/CURRENCY row opens its symbol. app.js
    // renders `.mrow .sym` (BTC/ETH/…) and `.frow span` (USD/INR); we read that
    // text instead of touching app.js.
    const crypto = $("crypto-rows");
    if (crypto) crypto.addEventListener("click", (e) => {
      const row = e.target.closest(".mrow");
      if (!row) return;
      const sym = row.querySelector(".sym");
      if (sym) open(sym.textContent);
    });
    const forex = $("forex-rows");
    if (forex) forex.addEventListener("click", (e) => {
      const row = e.target.closest(".frow");
      if (!row) return;
      const pair = row.querySelector("span");
      if (pair) open(pair.textContent);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

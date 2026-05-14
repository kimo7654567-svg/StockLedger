// ============================
// StockLedger - app.js
// ============================

const API_URL = 'https://script.google.com/macros/s/AKfycbxu3gi22-UbEG1zZYJ2JQ3vWuRy6w7xVZvcpUzwlU7Jqs6x3gj4doW37RqmgpzN_b_loA/exec';
let TOKEN = localStorage.getItem('sl_token') || '';

let holdings = [], transactions = [], snapshots = [];
let prices = {}, lastPrices = {}, lastPricesWithDate = {};
let usdRate = null, lineChart = null, pieChart = null;
let currentTab = 'active';
let pendingSell = null, manualPriceResolve = null, isLoading = false;
let eyeOpen = true;
let cashTWD = 0;
let accountOpen = {}, stockOpen = {};
let currentChartSlide = 0; // 0 = 走勢, 1 = 圓餅

const ACCOUNT_COLORS = ['#00e5ff','#00e676','#ffd600','#ff6b35','#c084fc','#f472b6','#38bdf8','#fb923c'];
const accountColorMap = {};
let colorIdx = 0;

// ── 眼睛 ────────────────────────────────────────────
function toggleEye() {
  eyeOpen = !eyeOpen;
  document.getElementById('eyeBtn').textContent = eyeOpen ? '👁' : '🙈';
  renderSummary();
  renderHoldingsContainer();
  renderPieChart();
}

function maskAmt(val) {
  return eyeOpen ? val : '****';
}

// ── Debug ────────────────────────────────────────────
function log(tag, msg, level = 'info') {
  const p = document.getElementById('debugPanel');
  const t = new Date().toTimeString().slice(0, 8);
  const d = document.createElement('div');
  d.className = 'debug-line';
  d.innerHTML = `<span class="debug-time">${t}</span><span class="debug-tag ${level}">[${tag}]</span><span class="debug-msg">${String(msg)}</span>`;
  p.appendChild(d);
  p.scrollTop = p.scrollHeight;
}

function toggleDebug() {
  const p = document.getElementById('debugPanel');
  const a = document.getElementById('debugArrow');
  p.classList.toggle('visible');
  a.textContent = p.classList.contains('visible') ? '▼' : '▶';
}

// ── Status ───────────────────────────────────────────
function setStatus(state, msg) {
  document.getElementById('statusDot').className = 'status-dot ' + state;
  document.getElementById('statusText').textContent = msg;
}

// ── API ──────────────────────────────────────────────
async function apiCall(params) {
  const url = new URL(API_URL);
  url.searchParams.set('token', TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  log('API', `→ ${params.action}`);
  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    log('API', `← ${params.action} OK`, 'ok');
    return data;
  } catch (e) {
    log('API', `← ${params.action} FAIL: ${e.message}`, 'err');
    throw e;
  }
}

// ── 股價抓取 ─────────────────────────────────────────
async function fetchAllPrices(holdingsList) {
  const today = new Date().toISOString().slice(0, 10);
  const symbolMap = {};
  const needFetch = [];

  for (const h of holdingsList) {
    let ticker;
    if (h.currency === 'TWD') ticker = h.symbol + '.TW';
    else if (h.currency === 'TWO') ticker = h.symbol + '.TWO';
    else ticker = h.symbol;
    if (!symbolMap[ticker]) symbolMap[ticker] = { symbol: h.symbol, currency: h.currency };
  }

  for (const [ticker, meta] of Object.entries(symbolMap)) {
    const sym = meta.symbol;
    const cached = lastPricesWithDate[sym];
    if (cached && cached.date === today) {
      prices[sym] = cached.price;
      log('PRICE', `${ticker} 今日快取 ${cached.price}`, 'info');
    } else {
      needFetch.push(ticker);
    }
  }

  if (!needFetch.length) { log('PRICE', '所有今日快取，略過'); return; }

  log('PRICE', `批次抓取: ${needFetch.join(', ')}`);
  try {
    const res = await apiCall({ action: 'getPrices', symbols: needFetch.join(',') });
    const data = res.data || {};
    for (const [ticker, result] of Object.entries(data)) {
      const sym = symbolMap[ticker]?.symbol;
      if (!sym) continue;
      if (result.price) {
        prices[sym] = result.price;
        log('PRICE', `${ticker} = ${result.price}`, 'ok');
      } else {
        log('PRICE', `${ticker} 失敗: ${result.error}`, 'warn');
        if (lastPrices[sym]) {
          prices[sym] = lastPrices[sym];
          log('PRICE', `${ticker} 用舊快取`, 'warn');
        } else {
          const manual = await askManualPrice(sym, symbolMap[ticker].currency);
          prices[sym] = (manual && manual > 0) ? manual : null;
          if (prices[sym]) { try { await apiCall({ action: 'setLastPrice', symbol: sym, price: prices[sym] }); } catch (_) {} }
        }
      }
    }
  } catch (e) {
    log('PRICE', `批次失敗: ${e.message}`, 'err');
    for (const [ticker, meta] of Object.entries(symbolMap)) {
      const sym = meta.symbol;
      if (prices[sym] !== undefined) continue;
      if (lastPrices[sym]) { prices[sym] = lastPrices[sym]; }
      else { const manual = await askManualPrice(sym, meta.currency); prices[sym] = (manual && manual > 0) ? manual : null; }
    }
  }
}

async function fetchUSDRate() {
  log('FX', '抓取 USD/TWD');
  try {
    const res = await apiCall({ action: 'getUSDRate' });
    if (res.rate) { log('FX', `USD/TWD = ${res.rate}`, 'ok'); return res.rate; }
    throw new Error(res.error || '無回傳');
  } catch (e) { log('FX', `失敗，使用預設值 32.5`, 'warn'); return 32.5; }
}

// ── 手動股價 Modal ───────────────────────────────────
function askManualPrice(symbol, currency) {
  return new Promise(resolve => {
    manualPriceResolve = resolve;
    const ccy = currency === 'USD' ? '$' : 'NT$';
    document.getElementById('priceModalSub').textContent = `${symbol} 無法自動取得，請輸入當前股價（${ccy}）`;
    document.getElementById('manual_price').value = '';
    document.getElementById('priceModal').classList.add('visible');
    setTimeout(() => document.getElementById('manual_price').focus(), 100);
  });
}

function confirmManualPrice() {
  const val = parseFloat(document.getElementById('manual_price').value);
  document.getElementById('priceModal').classList.remove('visible');
  if (manualPriceResolve) { manualPriceResolve(isNaN(val) ? null : val); manualPriceResolve = null; }
}

// ── 計算工具 ─────────────────────────────────────────
function calcYears(d) { return (Date.now() - new Date(d)) / (1000 * 60 * 60 * 24 * 365.25); }
function calcCAGR(cost, val, yrs) { return (yrs < 0.01 || cost <= 0) ? null : (Math.pow(val / cost, 1 / yrs) - 1) * 100; }
function fmt(n, d = 0) { if (n == null || isNaN(n)) return '--'; return n.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtPct(n) { if (n == null || isNaN(n)) return '--'; return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function cls(n) { return n == null ? '' : n >= 0 ? 'positive' : 'negative'; }
function toTWD(amount, currency) { return currency === 'USD' ? amount * (usdRate || 32.5) : amount; }
function ccySymbol(currency) { return currency === 'USD' ? '$' : 'NT$'; }

// ── 帳戶顏色 ─────────────────────────────────────────
function getAccountColor(account) {
  const key = account || '未分類';
  if (!accountColorMap[key]) { accountColorMap[key] = ACCOUNT_COLORS[colorIdx % ACCOUNT_COLORS.length]; colorIdx++; }
  return accountColorMap[key];
}

// ── Tabs ─────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((el, i) => el.classList.toggle('active', ['active', 'closed', 'transactions'][i] === tab));
  renderHoldingsContainer();
}

// ── 現金 card ────────────────────────────────────────
function renderCashCard() {
  document.getElementById('cashValue').textContent = maskAmt(`NT$${fmt(cashTWD)}`);
}

function toggleCashEdit() {
  const row = document.getElementById('cashEditRow');
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'flex';
  if (!visible) {
    document.getElementById('cashInput').value = cashTWD || '';
    document.getElementById('cashInput').focus();
  }
}

async function saveCash() {
  const val = parseFloat(document.getElementById('cashInput').value);
  if (isNaN(val) || val < 0) { alert('請輸入有效金額'); return; }
  cashTWD = val;
  try {
    await apiCall({ action: 'setSetting', key: 'cash_twd', value: val });
    log('CASH', `現金已更新 NT$${fmt(val)}`, 'ok');
  } catch (e) { log('CASH', `儲存失敗: ${e.message}`, 'err'); }
  document.getElementById('cashEditRow').style.display = 'none';
  renderCashCard();
  renderPieChart();
}

// ── Summary cards ────────────────────────────────────
function renderSummary() {
  let totalAsset = 0, totalCost = 0;
  const active = holdings.filter(h => !h.sell_date || String(h.sell_date).trim() === '');
  const groups = {};
  for (const h of active) { if (!groups[h.symbol]) groups[h.symbol] = []; groups[h.symbol].push(h); }
  for (const [sym, items] of Object.entries(groups)) {
    const cur = items[0].currency;
    const p = prices[sym];
    const shares = items.reduce((s, i) => s + parseFloat(i.shares || 0), 0);
    const cost = items.reduce((s, i) => s + parseFloat(i.buy_price || 0) * parseFloat(i.shares || 0), 0);
    totalCost += toTWD(cost, cur);
    if (p != null) totalAsset += toTWD(p * shares, cur);
  }
  const unrealized = totalAsset - totalCost;
  const unrealizedPct = totalCost > 0 ? (unrealized / totalCost) * 100 : 0;
  let realized = 0;
  for (const tx of transactions) {
    const pnl = (parseFloat(tx.sell_price) - parseFloat(tx.buy_price)) * parseFloat(tx.shares);
    realized += toTWD(pnl, tx.currency);
  }

  const setCard = (id, val, n) => {
    const el = document.getElementById(id);
    el.textContent = val;
    el.className = 'card-value ' + (n == null ? 'neutral' : n >= 0 ? 'positive' : 'negative');
  };

  const totalAssetWithCash = totalAsset + cashTWD;
  setCard('totalAsset', maskAmt(`NT$${fmt(totalAssetWithCash)}`), null);
  setCard('totalCost', maskAmt(`NT$${fmt(totalCost)}`), null);
  setCard('unrealizedPnl', maskAmt(`NT$${fmt(unrealized)}`), unrealized);
  document.getElementById('unrealizedPct').textContent = fmtPct(unrealizedPct);
  setCard('realizedPnl', maskAmt(`NT$${fmt(realized)}`), realized);
  document.getElementById('realizedSub').textContent = `${transactions.length} 筆交易`;
  renderCashCard();

  return totalAsset;
}

// ── 計算圓餅資料 ──────────────────────────────────────
function buildPieData() {
  const active = holdings.filter(h => !h.sell_date || String(h.sell_date).trim() === '');
  const groups = {};
  for (const h of active) { if (!groups[h.symbol]) groups[h.symbol] = []; groups[h.symbol].push(h); }

  const items = [];
  let totalStockTWD = 0;

  for (const [sym, sItems] of Object.entries(groups)) {
    const cur = sItems[0].currency;
    const p = prices[sym];
    if (p == null) continue;
    const shares = sItems.reduce((s, i) => s + parseFloat(i.shares || 0), 0);
    const valueTWD = toTWD(p * shares, cur);
    totalStockTWD += valueTWD;
    items.push({ label: sym, value: valueTWD });
  }

  const total = totalStockTWD + cashTWD;
  if (total <= 0) return null;

  const labels = items.map(i => i.label);
  const values = items.map(i => i.value);
  const colors = items.map(i => getAccountColor(i.label)); // 每支股票用固定色

  if (cashTWD > 0) {
    labels.push('現金');
    values.push(cashTWD);
    colors.push('#4ade80');
  }

  return { labels, values, colors, total };
}

// ── 圖表 carousel ────────────────────────────────────
function goToSlide(idx) {
  currentChartSlide = idx;
  document.getElementById('chartCarousel').style.transform = `translateX(-${idx * 100}%)`;
  document.querySelectorAll('.chart-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

// 支援手機滑動
function initChartSwipe() {
  const wrap = document.getElementById('chartCarouselWrap');
  let startX = 0;
  wrap.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  wrap.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) goToSlide(dx < 0 ? 1 : 0);
  }, { passive: true });
}

// ── 走勢圖 ───────────────────────────────────────────
function renderLineChart() {
  const canvas = document.getElementById('assetChart');
  const empty = document.getElementById('chartEmpty');
  if (!snapshots.length) { canvas.style.display = 'none'; empty.style.display = 'flex'; return; }
  empty.style.display = 'none'; canvas.style.display = 'block';
  const labels = snapshots.map(s => String(s.date));
  const values = snapshots.map(s => parseFloat(s.total_twd));
  if (lineChart) lineChart.destroy();
  lineChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{ data: values, borderColor: '#00e5ff', backgroundColor: 'rgba(0,229,255,0.06)', borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#00e5ff', pointBorderColor: '#0a0e1a', pointBorderWidth: 2, fill: true, tension: 0.3 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#111827', borderColor: '#1e2d45', borderWidth: 1, titleColor: '#64748b', bodyColor: '#e2e8f0', titleFont: { family: 'Space Mono', size: 10 }, bodyFont: { family: 'Space Mono', size: 11 }, callbacks: { label: ctx => `NT$ ${fmt(ctx.parsed.y)}` } }
      },
      scales: {
        x: { grid: { color: 'rgba(30,45,69,0.5)' }, ticks: { color: '#64748b', font: { family: 'Space Mono', size: 9 }, callback: function(val, idx) { const s = this.getLabelForValue(val); return s ? s.slice(0,10) : ''; } } },
        y: { grid: { color: 'rgba(30,45,69,0.5)' }, ticks: { color: '#64748b', font: { family: 'Space Mono', size: 9 }, callback: v => 'NT$' + fmt(v) } }
      }
    }
  });
}

// ── 圓餅圖 ───────────────────────────────────────────
function renderPieChart() {
  const canvas = document.getElementById('allocationChart');
  const empty = document.getElementById('pieEmpty');
  const pieData = buildPieData();

  if (!pieData) { canvas.style.display = 'none'; empty.style.display = 'flex'; return; }
  empty.style.display = 'none'; canvas.style.display = 'block';

  if (pieChart) pieChart.destroy();

  const total = pieData.total;
  pieChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: pieData.labels,
      datasets: [{ data: pieData.values, backgroundColor: pieData.colors, borderColor: '#0a0e1a', borderWidth: 2, hoverBorderWidth: 3 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '55%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#64748b', font: { family: 'Space Mono', size: 9 }, padding: 10, boxWidth: 10 }
        },
        tooltip: {
          backgroundColor: '#111827', borderColor: '#1e2d45', borderWidth: 1,
          titleColor: '#64748b', bodyColor: '#e2e8f0',
          titleFont: { family: 'Space Mono', size: 10 }, bodyFont: { family: 'Space Mono', size: 11 },
          callbacks: {
            label: ctx => {
              const pct = ((ctx.parsed / total) * 100).toFixed(1) + '%';
              const amt = eyeOpen ? ` NT$${fmt(ctx.parsed)}` : '';
              return ` ${ctx.label}: ${pct}${amt}`;
            }
          }
        }
      }
    }
  });
}

// ── 持股渲染 ─────────────────────────────────────────
function renderHoldingsContainer() {
  const container = document.getElementById('holdingsContainer');
  if (currentTab === 'transactions') { renderTransactions(container); return; }

  const isClosed = currentTab === 'closed';
  const filtered = holdings.filter(h => {
    const sold = h.sell_date && String(h.sell_date).trim() !== '';
    return isClosed ? sold : !sold;
  });

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state">${isClosed ? '尚無平倉紀錄' : '尚無持倉，點擊右上角新增'}</div>`;
    return;
  }

  const accountGroups = {};
  for (const h of filtered) {
    const acct = String(h.account || '').trim() || '未分類';
    if (!accountGroups[acct]) accountGroups[acct] = [];
    accountGroups[acct].push(h);
  }

  let html = '';
  for (const [account, items] of Object.entries(accountGroups)) {
    const color = getAccountColor(account);
    const isAcctOpen = accountOpen[account] !== false;

    const symbolGroups = {};
    for (const h of items) { if (!symbolGroups[h.symbol]) symbolGroups[h.symbol] = []; symbolGroups[h.symbol].push(h); }

    let acctAsset = 0, acctCost = 0;
    for (const [sym, sItems] of Object.entries(symbolGroups)) {
      const cur = sItems[0].currency;
      const p = prices[sym];
      const shares = sItems.reduce((s, i) => s + parseFloat(i.shares || 0), 0);
      const cost = sItems.reduce((s, i) => s + parseFloat(i.buy_price || 0) * parseFloat(i.shares || 0), 0);
      acctCost += toTWD(cost, cur);
      if (p != null) acctAsset += toTWD(p * shares, cur);
    }
    const acctPnl = acctAsset - acctCost;
    const acctPnlPct = acctCost > 0 ? (acctPnl / acctCost) * 100 : 0;

    let stockRows = '';
    for (const [symbol, sItems] of Object.entries(symbolGroups)) {
      const cur = sItems[0].currency;
      const ccy = ccySymbol(cur);
      const p = prices[symbol];
      const totalShares = sItems.reduce((s, i) => s + parseFloat(i.shares || 0), 0);
      const totalCost = sItems.reduce((s, i) => s + parseFloat(i.buy_price || 0) * parseFloat(i.shares || 0), 0);
      const avgPrice = totalCost / totalShares;
      const currentValue = p != null ? p * totalShares : null;
      const unrealizedPnl = currentValue != null ? currentValue - totalCost : null;
      const unrealizedPct = unrealizedPnl != null ? (unrealizedPnl / totalCost) * 100 : null;
      const earliestDate = sItems.reduce((d, i) => String(i.buy_date) < d ? String(i.buy_date) : d, String(sItems[0].buy_date));
      const years = calcYears(earliestDate);
      const costTWD = toTWD(totalCost, cur);
      const valueTWD = currentValue != null ? toTWD(currentValue, cur) : null;
      const cagr = valueTWD != null ? calcCAGR(costTWD, valueTWD, years) : null;
      const sold = sItems[0].sell_date && String(sItems[0].sell_date).trim() !== '';
      const ids = sItems.map(i => i.id).join(',');
      const stockKey = `${account}__${symbol}`;
      const isStockOpen = stockOpen[stockKey] === true;
      const curLabel = cur === 'TWO' ? 'TWD(櫃)' : cur;

      stockRows += `
        <div class="stock-item">
          <div class="stock-header" onclick="toggleStock('${stockKey}')">
            <span class="stock-chevron ${isStockOpen ? 'open' : ''}">▶</span>
            <span class="stock-symbol">${symbol}</span>
            <span class="stock-currency-badge">${curLabel}</span>
            ${sold ? '<span class="closed-badge">平倉</span>' : ''}
            <span class="stock-price">${p != null ? ccy + fmt(p, 2) : '--'}</span>
            <span class="stock-pnl ${cls(unrealizedPct)}">${fmtPct(unrealizedPct)}</span>
          </div>
          <div class="stock-detail ${isStockOpen ? 'open' : ''}" id="detail-${stockKey.replace(/[^a-zA-Z0-9]/g, '_')}">
            <div class="detail-grid">
              <div class="detail-item"><label>持股股數</label><div class="val">${maskAmt(fmt(totalShares, 2) + ' 股')}</div></div>
              <div class="detail-item"><label>平均買入價</label><div class="val">${maskAmt(ccy + fmt(avgPrice, 2))}</div></div>
              <div class="detail-item"><label>投入成本</label><div class="val">${maskAmt(ccy + fmt(totalCost, 2))}</div></div>
              <div class="detail-item"><label>目前現值</label><div class="val">${currentValue != null ? maskAmt(ccy + fmt(currentValue, 2)) : '--'}</div></div>
              <div class="detail-item"><label>未實現損益</label><div class="val ${cls(unrealizedPnl)}">${unrealizedPnl != null ? maskAmt((unrealizedPnl >= 0 ? '+' : '') + ccy + fmt(Math.abs(unrealizedPnl), 2)) : '--'}</div></div>
              <div class="detail-item"><label>年化報酬(CAGR)</label><div class="val ${cls(cagr)}">${fmtPct(cagr)}</div></div>
              <div class="detail-item"><label>最早買入日</label><div class="val" style="font-size:11px;">${earliestDate}</div></div>
              <div class="detail-item"><label>帳戶</label><div class="val" style="color:${color};font-size:11px;">${account}</div></div>
            </div>
            <div class="detail-actions">
              ${!sold ? `<button class="btn btn-warn btn-sm" onclick="openSellModal('${symbol}','${ids}','${cur}')">平倉</button>` : ''}
              <button class="btn btn-danger btn-sm" onclick="confirmDelete('${ids}','${symbol}')">刪除</button>
            </div>
          </div>
        </div>`;
    }

    html += `
      <div class="account-row">
        <div class="account-header" style="border-left-color:${color}" onclick="toggleAccount('${account}')">
          <span class="account-chevron ${isAcctOpen ? 'open' : ''}">▶</span>
          <span class="account-name" style="color:${color}">${account}</span>
          <div class="account-meta">
            <span class="account-asset">${maskAmt('NT$' + fmt(acctAsset))}</span>
            <span class="account-cost">成本 ${maskAmt('NT$' + fmt(acctCost))}</span>
          </div>
          <span class="account-pnl ${cls(acctPnl)}">${fmtPct(acctPnlPct)}</span>
        </div>
        <div class="account-body ${isAcctOpen ? 'open' : ''}" id="acct-${account.replace(/[^a-zA-Z0-9]/g, '_')}">
          ${stockRows}
        </div>
      </div>`;
  }

  container.innerHTML = html;
}

function renderTransactions(container) {
  if (!transactions.length) { container.innerHTML = '<div class="empty-state">尚無交易紀錄</div>'; return; }
  let html = '<div class="tx-list">';
  html += transactions.map(tx => {
    const ccy = ccySymbol(tx.currency);
    const cost = parseFloat(tx.buy_price) * parseFloat(tx.shares);
    const proceeds = parseFloat(tx.sell_price) * parseFloat(tx.shares);
    const pnl = proceeds - cost;
    const pnlPct = (pnl / cost) * 100;
    const acct = String(tx.account || '').trim() || '未分類';
    const color = getAccountColor(acct);
    return `<div class="tx-item">
      <div class="tx-top">
        <span class="tx-symbol">${tx.symbol}</span>
        <span class="tx-acct" style="color:${color}">${acct}</span>
        <span class="tx-date">${tx.sell_date || '--'}</span>
      </div>
      <div class="tx-bottom">
        <span>${maskAmt(fmt(parseFloat(tx.shares), 2) + '股')}</span>
        <span>買${maskAmt(ccy + fmt(parseFloat(tx.buy_price), 2))}</span>
        <span>賣${maskAmt(ccy + fmt(parseFloat(tx.sell_price), 2))}</span>
        <span class="tx-pnl ${cls(pnl)}">${maskAmt((pnl >= 0 ? '+' : '') + ccy + fmt(Math.abs(pnl), 2))}</span>
        <span class="${cls(pnlPct)}">${fmtPct(pnlPct)}</span>
      </div>
    </div>`;
  }).join('');
  html += '</div>';
  container.innerHTML = html;
}

// ── 帳戶/股票 展開收合 ───────────────────────────────
function toggleAccount(account) {
  accountOpen[account] = accountOpen[account] === false ? true : false;
  renderHoldingsContainer();
}

function toggleStock(key) {
  stockOpen[key] = !stockOpen[key];
  renderHoldingsContainer();
}

// ── 新增持股 ─────────────────────────────────────────
function updateAccountList() {
  const accounts = [...new Set(holdings.map(h => String(h.account || '').trim()).filter(Boolean))];
  document.getElementById('accountList').innerHTML = accounts.map(a => `<option value="${a}">`).join('');
}

function toggleAddForm() {
  const f = document.getElementById('addForm');
  f.classList.toggle('visible');
  if (f.classList.contains('visible')) { document.getElementById('f_date').value = new Date().toISOString().slice(0, 10); updateAccountList(); }
}

async function addHolding() {
  const symbol = document.getElementById('f_symbol').value.trim().toUpperCase();
  const currency = document.getElementById('f_currency').value;
  const account = document.getElementById('f_account').value.trim();
  const buy_date = document.getElementById('f_date').value;
  const buy_price = document.getElementById('f_price').value;
  const shares = document.getElementById('f_shares').value;
  const note = document.getElementById('f_note').value;
  if (!symbol || !buy_date || !buy_price || !shares || !account) { alert('請填寫代碼、帳戶、日期、買入價格和股數'); return; }
  setStatus('loading', '新增持股中...');
  try {
    await apiCall({ action: 'addHolding', symbol, currency, account, buy_date, buy_price, shares, note });
    toggleAddForm();
    ['f_symbol', 'f_price', 'f_shares', 'f_note', 'f_account'].forEach(id => document.getElementById(id).value = '');
    await loadAndRender();
  } catch (e) { setStatus('error', '新增失敗: ' + e.message); }
}

// ── 刪除 ─────────────────────────────────────────────
async function confirmDelete(ids, symbol) {
  if (!confirm(`確定要刪除 ${symbol}？此操作不可復原。`)) return;
  setStatus('loading', '刪除中...');
  try { await apiCall({ action: 'deleteHolding', ids }); await loadAndRender(); }
  catch (e) { setStatus('error', '刪除失敗: ' + e.message); }
}

// ── 賣出 ─────────────────────────────────────────────
function openSellModal(symbol, ids, currency) {
  pendingSell = { symbol, ids, currency };
  document.getElementById('sellModalSub').textContent = `${symbol} — 填入賣出資訊`;
  document.getElementById('sell_date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('sell_price').value = prices[symbol] ? prices[symbol] : '';
  document.getElementById('sellModal').classList.add('visible');
}

function closeSellModal() { document.getElementById('sellModal').classList.remove('visible'); pendingSell = null; }

async function confirmSell() {
  if (!pendingSell) return;
  const sell_date = document.getElementById('sell_date').value;
  const sell_price = document.getElementById('sell_price').value;
  if (!sell_date || !sell_price) { alert('請填寫賣出日期和價格'); return; }
  closeSellModal(); setStatus('loading', '平倉中...');
  try { await apiCall({ action: 'sellHolding', symbol: pendingSell.symbol, ids: pendingSell.ids, sell_date, sell_price }); await loadAndRender(); }
  catch (e) { setStatus('error', '平倉失敗: ' + e.message); }
}

// ── Setup ─────────────────────────────────────────────
function showSetup() { document.getElementById('setupOverlay').classList.add('visible'); document.getElementById('setup_token').value = TOKEN; }

function saveSetup() {
  const token = document.getElementById('setup_token').value.trim();
  if (!token) { alert('請填寫 Token'); return; }
  localStorage.setItem('sl_token', token); TOKEN = token;
  document.getElementById('setupOverlay').classList.remove('visible');
  log('SETUP', '設定已儲存', 'ok'); loadAndRender();
}

// ── 主流程 ────────────────────────────────────────────
async function loadAndRender() {
  if (isLoading) { log('SYS', '已在載入中，略過', 'warn'); return; }
  isLoading = true;
  setStatus('loading', '載入資料中...');

  try {
    const [hRes, txRes, snapRes, lpRes, cashRes] = await Promise.all([
      apiCall({ action: 'getHoldings' }),
      apiCall({ action: 'getTransactions' }),
      apiCall({ action: 'getSnapshots' }),
      apiCall({ action: 'getLastPrices' }),
      apiCall({ action: 'getSetting', key: 'cash_twd' }),
    ]);
    holdings = hRes.data || [];
    transactions = txRes.data || [];
    snapshots = snapRes.data || [];
    lastPrices = {}; lastPricesWithDate = {};
    (lpRes.data || []).forEach(r => {
      lastPrices[r.symbol] = parseFloat(r.price);
      const d = r.updated_at ? String(r.updated_at).slice(0, 10) : '';
      lastPricesWithDate[r.symbol] = { price: parseFloat(r.price), date: d };
    });
    cashTWD = cashRes.value ? parseFloat(cashRes.value) : 0;
    log('DATA', `持倉 ${holdings.length}，快取 ${Object.keys(lastPrices).length}，現金 NT$${fmt(cashTWD)}`, 'ok');
  } catch (e) {
    setStatus('error', 'Google Sheet 連線失敗');
    document.getElementById('holdingsContainer').innerHTML = '<div class="empty-state">無法連線到 Google Sheet，請確認 Token 設定</div>';
    isLoading = false; return;
  }

  // 第一階段：快取渲染
  prices = {};
  for (const [sym, p] of Object.entries(lastPrices)) prices[sym] = p;
  if (!usdRate) usdRate = 32.5;
  setStatus('loading', '顯示快取，背景更新中...');
  renderSummary();
  renderHoldingsContainer();
  renderLineChart();
  renderPieChart();

  // 第二階段：更新
  usdRate = await fetchUSDRate();
  document.getElementById('usdRate').textContent = usdRate ? usdRate.toFixed(2) : '--';
  setStatus('loading', '更新股價中...');
  const active = holdings.filter(h => !h.sell_date || String(h.sell_date).trim() === '');
  await fetchAllPrices(active);

  for (const [sym, price] of Object.entries(prices)) {
    if (price != null) { try { await apiCall({ action: 'setLastPrice', symbol: sym, price }); } catch (_) {} }
  }

  const totalAsset = renderSummary();
  renderHoldingsContainer();
  renderLineChart();
  renderPieChart();

  if (totalAsset > 0) {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const r = await apiCall({ action: 'addSnapshot', date: today, total_twd: totalAsset.toFixed(0), usd_rate: (usdRate || 32.5).toFixed(2) });
      if (!r.skipped) {
        log('SNAPSHOT', `NT$${fmt(totalAsset)} 已記錄`, 'ok');
        const s2 = await apiCall({ action: 'getSnapshots' });
        snapshots = s2.data || []; renderLineChart();
      } else { log('SNAPSHOT', '今日已記錄', 'info'); }
    } catch (e) { log('SNAPSHOT', `失敗: ${e.message}`, 'err'); }
  }

  isLoading = false;
  setStatus('ok', `最後更新：${new Date().toLocaleString('zh-TW')}`);
}

// ── 啟動 ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initChartSwipe();
  if (!TOKEN) { showSetup(); } else { loadAndRender(); }
});

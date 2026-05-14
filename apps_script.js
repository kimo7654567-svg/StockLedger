// ============================
// StockLedger - Apps Script
// ============================

const SECRET_TOKEN = 'YOUR_TOKEN';

function doGet(e) { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  const params = e.parameter;
  if (params.token !== SECRET_TOKEN) return respond({ error: 'Unauthorized' });
  const action = params.action;
  try {
    if (action === 'getHoldings')      return respond(getHoldings());
    if (action === 'addHolding')       return respond(addHolding(params));
    if (action === 'deleteHolding')    return respond(deleteHolding(params));
    if (action === 'sellHolding')      return respond(sellHolding(params));
    if (action === 'getSnapshots')     return respond(getSnapshots());
    if (action === 'addSnapshot')      return respond(addSnapshot(params));
    if (action === 'getTransactions')  return respond(getTransactions());
    if (action === 'getLastPrices')    return respond(getLastPrices());
    if (action === 'setLastPrice')     return respond(setLastPrice(params));
    if (action === 'getPrices')        return respond(getPrices(params));
    if (action === 'getUSDRate')       return respond(getUSDRate());
    if (action === 'getSetting')       return respond(getSetting(params));
    if (action === 'setSetting')       return respond(setSetting(params));
    if (action === 'debugPrice')       return respond(debugPrice(params));
    return respond({ error: 'Unknown action: ' + action });
  } catch (err) {
    return respond({ error: err.toString() });
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

// ── Settings ──────────────────────────────────────────
// settings 分頁格式: key | value

function getSetting(params) {
  var sheet = getSheet('settings');
  var data = sheet.getDataRange().getValues();
  var key = params.key;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      return { value: data[i][1] };
    }
  }
  return { value: null };
}

function setSetting(params) {
  var sheet = getSheet('settings');
  var data = sheet.getDataRange().getValues();
  var key = params.key;
  var value = params.value;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return { success: true, updated: true };
    }
  }
  sheet.appendRow([key, value]);
  return { success: true, inserted: true };
}

// ── 股價抓取 ──────────────────────────────────────────

function getPrices(params) {
  var symbols = (params.symbols || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  var result = {};
  for (var i = 0; i < symbols.length; i++) {
    var ticker = symbols[i];
    try {
      var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1d&range=5d';
      var res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
          'Accept': 'application/json'
        }
      });
      var code = res.getResponseCode();
      if (code !== 200) { result[ticker] = { error: 'HTTP ' + code }; continue; }
      var data = JSON.parse(res.getContentText());
      var meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
      if (!meta) { result[ticker] = { error: '無法解析 meta' }; continue; }
      var price = meta.regularMarketPrice || meta.previousClose || meta.chartPreviousClose || null;
      if (!price) {
        result[ticker] = { error: '所有價格欄位均為 null，meta: ' + JSON.stringify(meta).slice(0, 300) };
      } else {
        result[ticker] = { price: price };
      }
    } catch (e) {
      result[ticker] = { error: e.toString() };
    }
  }
  return { data: result };
}

function getUSDRate() {
  try {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/USDTWD=X?interval=1d&range=5d';
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
        'Accept': 'application/json'
      }
    });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    var data = JSON.parse(res.getContentText());
    var meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    var rate = meta && (meta.regularMarketPrice || meta.previousClose || meta.chartPreviousClose);
    if (!rate) throw new Error('無法解析匯率');
    return { rate: rate };
  } catch (e) {
    return { error: e.toString() };
  }
}

function debugPrice(params) {
  var ticker = params.ticker || '';
  var result = { ticker: ticker, attempts: [] };
  try {
    var url1 = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1d&range=5d';
    var res1 = UrlFetchApp.fetch(url1, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
    var code1 = res1.getResponseCode();
    var meta1 = null;
    try { var p1 = JSON.parse(res1.getContentText()); meta1 = p1 && p1.chart && p1.chart.result && p1.chart.result[0] && p1.chart.result[0].meta; } catch(pe) {}
    result.attempts.push({
      source: 'Yahoo v8', httpCode: code1,
      regularMarketPrice: meta1 ? meta1.regularMarketPrice : null,
      previousClose: meta1 ? meta1.previousClose : null,
      chartPreviousClose: meta1 ? meta1.chartPreviousClose : null,
      bodySnippet: res1.getContentText().slice(0, 500)
    });
  } catch(e) { result.attempts.push({ source: 'Yahoo v8', error: e.toString() }); }
  return result;
}

// ── Holdings ──────────────────────────────────────────

function getHoldings() {
  var sheet = getSheet('holdings');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1).map(function(row, i) {
    var obj = { id: i + 2 };
    headers.forEach(function(h, j) { obj[h] = row[j]; });
    return obj;
  }).filter(function(row) { return row.symbol !== ''; });
  return { data: rows };
}

function addHolding(params) {
  var sheet = getSheet('holdings');
  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1).setNumberFormat('@').setValue(params.symbol);
  sheet.getRange(newRow, 2).setValue(params.buy_date);
  sheet.getRange(newRow, 3).setValue(parseFloat(params.buy_price));
  sheet.getRange(newRow, 4).setValue(parseFloat(params.shares));
  sheet.getRange(newRow, 5).setValue(params.currency);
  sheet.getRange(newRow, 6).setValue(params.note || '');
  sheet.getRange(newRow, 7).setValue('');
  sheet.getRange(newRow, 8).setValue(params.account || '');
  return { success: true };
}

function deleteHolding(params) {
  var sheet = getSheet('holdings');
  var ids = String(params.ids).split(',').map(Number).sort(function(a, b) { return b - a; });
  for (var i = 0; i < ids.length; i++) { sheet.deleteRow(ids[i]); }
  return { success: true };
}

function sellHolding(params) {
  var holdSheet = getSheet('holdings');
  var txSheet = getSheet('transactions');
  var ids = params.ids.split(',').map(Number).sort(function(a, b) { return b - a; });
  var sell_price = parseFloat(params.sell_price);
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var row = holdSheet.getRange(id, 1, 1, holdSheet.getLastColumn()).getValues()[0];
    txSheet.appendRow([params.symbol, row[4], row[1], row[2], row[3], params.sell_date, sell_price, row[7]]);
    holdSheet.getRange(id, 7).setValue(params.sell_date);
  }
  return { success: true };
}

// ── Snapshots ─────────────────────────────────────────

function getSnapshots() {
  var sheet = getSheet('snapshots');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, j) { obj[h] = row[j]; });
    return obj;
  }).filter(function(row) { return row.date !== ''; });
  return { data: rows };
}

function addSnapshot(params) {
  var sheet = getSheet('snapshots');
  var data = sheet.getDataRange().getValues();
  var today = params.date;
  var exists = data.slice(1).some(function(row) { return row[0] === today; });
  if (exists) return { success: true, skipped: true };
  sheet.appendRow([params.date, parseFloat(params.total_twd), parseFloat(params.usd_rate)]);
  return { success: true };
}

// ── Transactions ──────────────────────────────────────

function getTransactions() {
  var sheet = getSheet('transactions');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, j) { obj[h] = row[j]; });
    return obj;
  }).filter(function(row) { return row.symbol !== ''; });
  return { data: rows };
}

// ── Last Prices ───────────────────────────────────────

function getLastPrices() {
  var sheet = getSheet('last_prices');
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, j) {
      if (h === 'updated_at' && row[j] instanceof Date) {
        obj[h] = row[j].toISOString();
      } else {
        obj[h] = row[j];
      }
    });
    return obj;
  }).filter(function(row) { return row.symbol !== ''; });
  return { data: rows };
}

function setLastPrice(params) {
  var sheet = getSheet('last_prices');
  var data = sheet.getDataRange().getValues();
  var now = new Date().toISOString();
  var incomingSymbol = String(params.symbol).trim();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === incomingSymbol) {
      sheet.getRange(i + 1, 1).setNumberFormat('@').setValue(incomingSymbol);
      sheet.getRange(i + 1, 2).setValue(parseFloat(params.price));
      sheet.getRange(i + 1, 3).setValue(now);
      return { success: true, updated: true };
    }
  }
  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1).setNumberFormat('@').setValue(incomingSymbol);
  sheet.getRange(newRow, 2).setValue(parseFloat(params.price));
  sheet.getRange(newRow, 3).setValue(now);
  return { success: true, inserted: true };
}

// ── testFetch (授權用) ────────────────────────────────
function testFetch() {
  var res = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d', {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  Logger.log('HTTP code: ' + res.getResponseCode());
  Logger.log('Body: ' + res.getContentText().slice(0, 200));
}

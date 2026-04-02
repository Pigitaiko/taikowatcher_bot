// src/bot.js
// TAIKO Liquidity Monitor — Telegram Bot
// Monitors $TAIKO CEX liquidity with AI-powered analysis

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import { fetchTaikoMarkets, fetchTaikoGlobalStats } from './fetcher.js';
import { detectAlerts, filterCooledDown, SEVERITY, fmtUsd, fmtPct, fmtBps } from './alerts.js';
import { formatAlert, formatDigest, formatHelp, formatHistory, formatGlobalHistory, formatAlertLog, formatTrend, formatMmReport } from './formatter.js';
import { initDb, saveSnapshot, logAlert, purgeOld, getHistory, getGlobalHistory, getAlertLog, getTrend, getRecentTrendSummary, getMmReport, close as closeDb } from './history.js';

// ──────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────────────────────────────────────────
const {
  TELEGRAM_BOT_TOKEN,
  ANTHROPIC_API_KEY,
  ALERT_CHAT_IDS = '',
  POLL_INTERVAL_SECONDS = '120',
  ALERT_COOLDOWN_MINUTES = '30',
  LIQ_SCORE_THRESHOLD    = '40',
  SPREAD_THRESHOLD_PCT   = '0.2',       // 20 BPS
  VOLUME_DROP_THRESHOLD  = '0.3',
  PRICE_GAP_THRESHOLD_PCT = '0.5',
  KIMCHI_PREMIUM_THRESHOLD_PCT = '1.0',
  DEPTH_ASYMMETRY_THRESHOLD = '3.0',    // 3x ratio
  VOL_CONCENTRATION_THRESHOLD = '0.5',  // 50% deviation
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required. Check your .env file.');
  process.exit(1);
}

const ALERT_CHATS = ALERT_CHAT_IDS
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!ALERT_CHATS.length) {
  console.warn('No ALERT_CHAT_IDS configured — alerts will be silent.');
}

const thresholdConfig = {
  liqScoreThreshold:         parseInt(LIQ_SCORE_THRESHOLD, 10),
  spreadThresholdPct:        parseFloat(SPREAD_THRESHOLD_PCT) / 100,
  volumeDropThreshold:       parseFloat(VOLUME_DROP_THRESHOLD),
  priceGapThresholdPct:      parseFloat(PRICE_GAP_THRESHOLD_PCT) / 100,
  kimchiPremiumThreshold:    parseFloat(KIMCHI_PREMIUM_THRESHOLD_PCT) / 100,
  depthAsymmetryThreshold:   parseFloat(DEPTH_ASYMMETRY_THRESHOLD),
  volConcentrationThreshold: parseFloat(VOL_CONCENTRATION_THRESHOLD),
};

const POLL_MS    = parseInt(POLL_INTERVAL_SECONDS, 10) * 1000;
const COOLDOWN_MS = parseInt(ALERT_COOLDOWN_MINUTES, 10) * 60 * 1000;
const DIGEST_INTERVAL_MS = 2 * 60 * 60 * 1000; // digest every 2 hours

// ──────────────────────────────────────────────────────────────────────────────
//  STATE
// ──────────────────────────────────────────────────────────────────────────────
let prevMarkets    = [];
let latestMarkets  = [];
let latestGlobal   = null;
let cooldownRegistry = new Map();
let lastDigestTime = 0;
let isFirstRun     = true;

// ──────────────────────────────────────────────────────────────────────────────
//  BOT INIT
// ──────────────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Suppress transient 409 polling errors (happen during restarts, resolve on their own)
bot.on('polling_error', (err) => {
  if (err.code === 'ETELEGRAM' && err.message?.includes('409')) return; // silent
  console.error('Polling error:', err.message);
});

console.log('🥁 TAIKO Liquidity Monitor v2 starting...');
console.log(`📡 Polling every ${POLL_INTERVAL_SECONDS}s`);
console.log(`🔔 Alert chats: ${ALERT_CHATS.join(', ') || 'none configured'}`);
console.log(`⏱️  Cooldown: ${ALERT_COOLDOWN_MINUTES}min per alert type`);
console.log(`📐 Spread threshold: ${SPREAD_THRESHOLD_PCT}% (${parseFloat(SPREAD_THRESHOLD_PCT) * 100} BPS)`);

// ──────────────────────────────────────────────────────────────────────────────
//  BROADCAST HELPER
// ──────────────────────────────────────────────────────────────────────────────
async function broadcast(text, opts = {}) {
  for (const chatId of ALERT_CHATS) {
    try {
      await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...opts,
      });
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err.message);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  MONITORING LOOP
// ──────────────────────────────────────────────────────────────────────────────
async function runMonitorCycle() {
  console.log(`\n[${new Date().toISOString()}] Running monitor cycle...`);

  let markets, global;

  try {
    [markets, global] = await Promise.all([
      fetchTaikoMarkets(),
      fetchTaikoGlobalStats(),
    ]);
  } catch (err) {
    console.error('Fetch error:', err.message);
    return;
  }

  console.log(`Fetched ${markets.length} markets. Prices: ${markets.map(m => `${m.name}=$${m.priceUsd.toFixed(4)}`).join(', ')}`);

  // Detect alerts
  const rawAlerts = detectAlerts(
    markets,
    isFirstRun ? null : prevMarkets,
    global,
    thresholdConfig,
  );

  const newAlerts = filterCooledDown(rawAlerts, cooldownRegistry, COOLDOWN_MS);

  if (newAlerts.length > 0) {
    console.log(`🚨 ${newAlerts.length} alert(s) to send:`);
    for (const alert of newAlerts) {
      console.log(`  [${alert.severity}] ${alert.type} — ${alert.exchange || 'global'}`);
      const msg = formatAlert(alert, process.env);
      await broadcast(msg);
      logAlert(alert);
      await sleep(500);
    }
  } else {
    console.log('✅ No new alerts.');
  }

  // Hourly digest
  const now = Date.now();
  if (now - lastDigestTime > DIGEST_INTERVAL_MS) {
    const digest = formatDigest(markets, global);
    await broadcast(digest);
    lastDigestTime = now;
    console.log('📊 Digest sent.');
  }

  // Update state
  prevMarkets   = latestMarkets.length ? latestMarkets : markets;
  latestMarkets = markets;
  latestGlobal  = global;
  isFirstRun    = false;

  // Persist snapshot + cleanup
  saveSnapshot(markets, global);
  purgeOld();
}

// ──────────────────────────────────────────────────────────────────────────────
//  BOT COMMANDS
// ──────────────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const welcome = `🥁 <b>TAIKO Liquidity Monitor v2</b>

Hello! I monitor $TAIKO liquidity across CEXs in real time. You can use commands or just ask me anything in natural language.

Type /help to see all commands.
Type /status for a live snapshot.`;

  await bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' });

  const chatId = String(msg.chat.id);
  if (!ALERT_CHATS.includes(chatId)) {
    console.log(`ℹ️  New chat started: ${chatId} (${msg.chat.title || msg.chat.username || 'private'})`);
    console.log(`   Add to ALERT_CHAT_IDS in .env if you want broadcasts here.`);
  }
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatHelp(), { parse_mode: 'HTML' });
});

bot.onText(/\/status/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '⏳ Fetching live data...', { parse_mode: 'HTML' });

  try {
    const [markets, global] = await Promise.all([
      fetchTaikoMarkets(),
      fetchTaikoGlobalStats(),
    ]);

    if (!markets.length) {
      await bot.sendMessage(msg.chat.id, 'No market data available. CoinGecko may be rate limiting.');
      return;
    }

    const totalVol = markets.reduce((s, m) => s + m.volumeUsd, 0);
    const avgScore = Math.round(markets.reduce((s, m) => s + m.liquidityScore, 0) / markets.length);
    const avgSpreadBps = (markets.reduce((s, m) => s + m.spreadPct, 0) / markets.length) * 10000;
    const scoreEmoji = avgScore >= 70 ? '🟢' : avgScore >= 50 ? '🟡' : '🔴';

    let reply = `📡 <b>$TAIKO LIVE STATUS</b>\n`;
    reply += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

    if (global?.priceUsd) {
      const chg = global.priceChange24h;
      reply += `💲 <b>Price:</b> <code>$${global.priceUsd.toFixed(4)}</code>`;
      if (chg != null) reply += ` <code>${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%</code>`;
      reply += `\n`;
    }

    reply += `${scoreEmoji} <b>Avg Score:</b> <code>${avgScore}/100</code>\n`;
    reply += `↔️ <b>Avg Spread:</b> <code>${avgSpreadBps.toFixed(1)} BPS</code> (bench: 15)\n`;
    reply += `📦 <b>Total Vol:</b> <code>${fmtUsd(totalVol)}</code>\n\n`;

    const spotMarkets = markets.filter(m => !m.isFutures);
    const futuresMarkets = markets.filter(m => m.isFutures);

    reply += `<b>Spot:</b>\n`;
    const sorted = [...spotMarkets].sort((a, b) => b.volumeUsd - a.volumeUsd);
    for (const m of sorted) {
      const si = m.liquidityScore >= 70 ? '🟢' : m.liquidityScore >= 50 ? '🟡' : '🔴';
      const sprBps = (m.spreadPct * 10000).toFixed(0);
      const volShare = (m.actualVolShare * 100).toFixed(0);
      reply += `${si} <code>${m.name.padEnd(10)} $${m.priceUsd.toFixed(4)}  ${fmtUsd(m.volumeUsd).padStart(7)}  ${sprBps.padStart(3)}bps  ${volShare}%</code>\n`;
    }

    if (futuresMarkets.length) {
      reply += `\n<b>Futures:</b>\n`;
      for (const m of futuresMarkets) {
        const si = m.liquidityScore >= 70 ? '🟢' : m.liquidityScore >= 50 ? '🟡' : '🔴';
        const sprBps = (m.spreadPct * 10000).toFixed(0);
        reply += `${si} <code>${m.name.padEnd(10)} $${m.priceUsd.toFixed(4)}  ${fmtUsd(m.volumeUsd).padStart(7)}  ${sprBps.padStart(3)}bps</code>`;
        if (m.fundingRate != null) {
          reply += ` <code>FR:${(m.fundingRate * 100).toFixed(4)}%</code>`;
        }
        reply += `\n`;
      }
    }

    const dexMarkets = markets.filter(m => m.isDex);
    if (dexMarkets.length) {
      reply += `\n<b>On-chain (Taiko L2):</b>\n`;
      for (const m of dexMarkets) {
        const si = m.liquidityScore >= 70 ? '🟢' : m.liquidityScore >= 50 ? '🟡' : '🔴';
        reply += `${si} <code>${m.name.padEnd(10)} $${m.priceUsd.toFixed(4)}  TVL:${fmtUsd(m.totalLiquidity).padStart(7)}  ${m.poolCount} pools</code>\n`;
      }
    }

    const ts = new Date().toUTCString().replace(' GMT', ' UTC');
    reply += `\n<i>${ts}</i>`;

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

    latestMarkets = markets;
    latestGlobal  = global;

  } catch (err) {
    await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
  }
});

bot.onText(/\/digest/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '⏳ Building digest...', { parse_mode: 'HTML' });

  try {
    const [markets, global] = await Promise.all([
      fetchTaikoMarkets(),
      fetchTaikoGlobalStats(),
    ]);
    const digest = formatDigest(markets, global);
    await bot.sendMessage(msg.chat.id, digest, { parse_mode: 'HTML' });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
  }
});

bot.onText(/\/check(?:\s+(.+))?/, async (msg, match) => {
  const query = match[1]?.toLowerCase().trim();
  if (!query) {
    await bot.sendMessage(msg.chat.id, 'Usage: /check bybit\nAvailable: htx, bybit, gate, mexc, bitget, kucoin, bitvavo, upbit, bithumb, binance, dex');
    return;
  }

  await bot.sendMessage(msg.chat.id, `⏳ Checking ${query}...`);

  try {
    const markets = await fetchTaikoMarkets();
    const mkt = markets.find(m =>
      m.name.toLowerCase().includes(query) ||
      m.exchangeId.toLowerCase().includes(query)
    );

    if (!mkt) {
      await bot.sendMessage(msg.chat.id, `Exchange "${query}" not found or has no TAIKO data.`);
      return;
    }

    const si = mkt.liquidityScore >= 70 ? '🟢' : mkt.liquidityScore >= 50 ? '🟡' : '🔴';

    let reply = `${si} <b>${mkt.name} — $TAIKO Deep Dive</b>\n`;
    reply += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;
    reply += `Pair:        <code>${mkt.pair}</code>\n`;
    reply += `Price:       <code>$${mkt.priceUsd.toFixed(6)}</code>\n`;
    reply += `24h Volume:  <code>${fmtUsd(mkt.volumeUsd)}</code>\n`;
    reply += `Spread:      <code>${mkt.spreadBps.toFixed(1)} BPS${mkt.spreadProvided ? '' : ' (est)'}</code>\n`;
    reply += `Benchmark:   <code>15.3 BPS</code>\n`;

    if (mkt.depthPlus2Pct > 0 || mkt.depthMinus2Pct > 0) {
      reply += `\n<b>Order Book Depth:</b>\n`;
      reply += `Depth +2%:   <code>${fmtUsd(mkt.depthPlus2Pct)}</code>\n`;
      reply += `Depth -2%:   <code>${fmtUsd(mkt.depthMinus2Pct)}</code>\n`;
      if (mkt.depthAsymmetry != null) {
        const label = mkt.depthAsymmetry > 2 ? 'sell-heavy' : mkt.depthAsymmetry < 0.5 ? 'buy-heavy' : 'balanced';
        reply += `Asymmetry:   <code>${mkt.depthAsymmetry.toFixed(1)}x (${label})</code>\n`;
      }
    }

    reply += `\n<b>Market Position:</b>\n`;
    reply += `Liq Score:   <code>${mkt.liquidityScore}/100</code>\n`;
    reply += `Vol Share:   <code>${(mkt.actualVolShare * 100).toFixed(1)}%</code>`;
    if (mkt.expectedVolShare > 0.005) {
      const dev = mkt.volShareDeviation;
      const devStr = dev > 0.3 ? ' ⬆️' : dev < -0.3 ? ' ⬇️' : ' ✅';
      reply += ` (bench: ${(mkt.expectedVolShare * 100).toFixed(1)}%)${devStr}`;
    }
    reply += `\n`;
    reply += `Tier:        <code>${mkt.tier}</code>\n`;
    reply += `Region:      <code>${mkt.region}</code>\n`;
    if (mkt.isFutures) {
      reply += `Type:        <code>Perpetual Futures</code>\n`;
      if (mkt.fundingRate != null) {
        const frPct = (mkt.fundingRate * 100).toFixed(4);
        const frLabel = mkt.fundingRate > 0.0001 ? 'longs pay' : mkt.fundingRate < -0.0001 ? 'shorts pay' : 'neutral';
        reply += `Funding:     <code>${frPct}% (${frLabel})</code>\n`;
      }
      if (mkt.markPrice != null) {
        reply += `Mark Price:  <code>$${mkt.markPrice.toFixed(4)}</code>\n`;
      }
    }
    if (mkt.isDex) {
      reply += `Type:        <code>On-chain DEX (Taiko L2)</code>\n`;
      reply += `TVL:         <code>${fmtUsd(mkt.totalLiquidity)}</code>\n`;
      reply += `Pools:       <code>${mkt.poolCount}</code>\n`;
      if (mkt.dexBreakdown) {
        reply += `\n<b>DEX Breakdown:</b>\n`;
        const sorted = Object.entries(mkt.dexBreakdown)
          .sort(([,a], [,b]) => b.liq - a.liq)
          .slice(0, 6);
        for (const [dex, data] of sorted) {
          const dexName = dex.replace(/-taiko$/, '').replace(/-/g, ' ');
          if (data.liq > 50) {
            reply += `  <code>${dexName.padEnd(14)} TVL:${fmtUsd(data.liq).padStart(7)} Vol:${fmtUsd(data.vol).padStart(6)}</code>\n`;
          }
        }
      }
    }
    if (mkt.trustScore) reply += `Trust:       <code>${mkt.trustScore}</code>\n`;

    // Diagnosis
    reply += `\n<b>Diagnosis:</b>\n`;
    const issues = [];
    if (mkt.liquidityScore < 25) issues.push('Liquidity score critically low');
    else if (mkt.liquidityScore < 40) issues.push('Liquidity score below threshold');
    if (mkt.spreadBps > 40) issues.push(`Spread wide at ${mkt.spreadBps.toFixed(0)} BPS (bench: 15)`);
    else if (mkt.spreadBps > 20) issues.push(`Spread elevated at ${mkt.spreadBps.toFixed(0)} BPS`);
    if (mkt.depthAsymmetry != null && (mkt.depthAsymmetry > 3 || mkt.depthAsymmetry < 0.33))
      issues.push(`Book lopsided: ${mkt.depthAsymmetry.toFixed(1)}x asymmetry`);
    if (mkt.volShareDeviation != null && mkt.volShareDeviation < -0.5)
      issues.push(`Volume ${Math.abs(mkt.volShareDeviation * 100).toFixed(0)}% below expected`);

    if (issues.length === 0) {
      reply += `✅ Healthy. No issues detected.\n`;
    } else {
      for (const issue of issues) {
        reply += `⚠️ ${issue}\n`;
      }
    }

    const ts = new Date().toUTCString().replace(' GMT', ' UTC');
    reply += `\n<i>${ts}</i>`;

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

  } catch (err) {
    await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
  }
});

bot.onText(/\/alerts/, async (msg) => {
  let reply = `⚙️ <b>Alert Thresholds (MM-Calibrated)</b>\n\n`;
  reply += `<b>Spread:</b>     <code>> ${fmtBps(thresholdConfig.spreadThresholdPct)}</code> (bench: 15.3 BPS)\n`;
  reply += `<b>Liq Score:</b>  <code>< ${thresholdConfig.liqScoreThreshold}/100</code>\n`;
  reply += `<b>Depth Crit:</b> <code>< $2K at +2%</code>\n`;
  reply += `<b>Depth Asym:</b> <code>> ${thresholdConfig.depthAsymmetryThreshold}x ratio</code>\n`;
  reply += `<b>Vol Drop:</b>   <code>< ${thresholdConfig.volumeDropThreshold * 100}% of prev</code>\n`;
  reply += `<b>Vol Conc:</b>   <code>> ${(thresholdConfig.volConcentrationThreshold * 100).toFixed(0)}% deviation</code>\n`;
  reply += `<b>Price Gap:</b>  <code>> ${fmtBps(thresholdConfig.priceGapThresholdPct)}</code>\n`;
  reply += `<b>Kimchi:</b>     <code>> ${fmtPct(thresholdConfig.kimchiPremiumThreshold)}</code>\n\n`;
  reply += `<b>Polling:</b>    <code>${POLL_INTERVAL_SECONDS}s</code>\n`;
  reply += `<b>Cooldown:</b>   <code>${ALERT_COOLDOWN_MINUTES}min</code>\n\n`;
  reply += `<i>Healthy spread benchmark: 15 BPS | Depth benchmark: $20-68K at +2%</i>`;
  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
});

// ──────────────────────────────────────────────────────────────────────────────
//  HISTORICAL DATA COMMANDS
// ──────────────────────────────────────────────────────────────────────────────

bot.onText(/\/history(?:\s+(.+))?/, async (msg, match) => {
  const query = match[1]?.toLowerCase().trim();

  if (!query) {
    // Global price history
    const rows = getGlobalHistory(24);
    const reply = formatGlobalHistory(rows, 24);
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
    return;
  }

  // Find exchange
  const mkt = latestMarkets.find(m =>
    m.name.toLowerCase().includes(query) ||
    m.exchangeId.toLowerCase().includes(query)
  );

  if (!mkt) {
    await bot.sendMessage(msg.chat.id, `Exchange "${query}" not found. Try: htx, bybit, gate, mexc, bitget, kucoin, binance, dex`);
    return;
  }

  const rows = getHistory(mkt.exchangeId, 24);
  const reply = formatHistory(rows, mkt.name, 24);
  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
});

bot.onText(/\/trend(?:\s+(.+))?/, async (msg, match) => {
  const query = match[1]?.toLowerCase().trim();

  if (!query) {
    await bot.sendMessage(msg.chat.id, 'Usage: /trend bybit\nAvailable: htx, bybit, gate, mexc, bitget, kucoin, bitvavo, upbit, bithumb, binance, dex');
    return;
  }

  const mkt = latestMarkets.find(m =>
    m.name.toLowerCase().includes(query) ||
    m.exchangeId.toLowerCase().includes(query)
  );

  if (!mkt) {
    await bot.sendMessage(msg.chat.id, `Exchange "${query}" not found.`);
    return;
  }

  const trendData = getTrend(mkt.exchangeId);
  const reply = formatTrend(trendData, mkt.name);
  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
});

bot.onText(/\/alertlog/, async (msg) => {
  const rows = getAlertLog(24);
  const reply = formatAlertLog(rows);
  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
});

bot.onText(/\/mmreport(?:\s+(\d+))?/, async (msg, match) => {
  const hours = parseInt(match[1] || '24', 10);
  await bot.sendMessage(msg.chat.id, `⏳ Building MM report (${hours}h)...`);

  try {
    const rows = getMmReport(hours);
    const reply = formatMmReport(rows, hours, latestMarkets);
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
//  CLAUDE AI — Natural Language Handler
// ──────────────────────────────────────────────────────────────────────────────
const claude = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// Per-chat conversation history (last N turns)
const chatHistories = new Map();
const MAX_HISTORY_TURNS = 10;

function getChatHistory(chatId) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  return chatHistories.get(chatId);
}

function addToHistory(chatId, role, content) {
  const history = getChatHistory(chatId);
  history.push({ role, content });
  // Keep last N turns (N user + N assistant = 2N messages)
  while (history.length > MAX_HISTORY_TURNS * 2) history.shift();
}

/**
 * Build a market context snapshot for Claude's system prompt.
 * Fetches fresh data if cache is stale (>60s).
 */
async function buildMarketContext() {
  let markets = latestMarkets;
  let global = latestGlobal;

  // Fetch fresh if stale
  if (!markets.length || (markets[0]?.lastFetched && Date.now() - markets[0].lastFetched.getTime() > 60_000)) {
    try {
      [markets, global] = await Promise.all([fetchTaikoMarkets(), fetchTaikoGlobalStats()]);
      latestMarkets = markets;
      latestGlobal = global;
    } catch (e) {
      // Use cached if fetch fails
    }
  }

  if (!markets.length) return 'No market data currently available.';

  const totalVol = markets.reduce((s, m) => s + m.volumeUsd, 0);
  const avgSpreadBps = (markets.reduce((s, m) => s + m.spreadPct, 0) / markets.length) * 10000;
  const avgScore = Math.round(markets.reduce((s, m) => s + m.liquidityScore, 0) / markets.length);

  let ctx = `=== LIVE $TAIKO MARKET DATA (${new Date().toUTCString()}) ===\n\n`;

  if (global) {
    ctx += `GLOBAL: Price $${global.priceUsd?.toFixed(4) ?? 'N/A'}`;
    if (global.priceChange24h != null) ctx += ` (${global.priceChange24h >= 0 ? '+' : ''}${global.priceChange24h.toFixed(2)}% 24h)`;
    ctx += `, Market Cap: ${fmtUsd(global.marketCapUsd)}, Total 24h Vol: ${fmtUsd(global.volume24hUsd)}\n\n`;
  }

  ctx += `AGGREGATE: Total CEX Vol: ${fmtUsd(totalVol)}, Avg Spread: ${avgSpreadBps.toFixed(1)} BPS, Avg Liq Score: ${avgScore}/100\n\n`;

  ctx += `PER-EXCHANGE DATA:\n`;
  const sorted = [...markets].sort((a, b) => b.volumeUsd - a.volumeUsd);
  for (const m of sorted) {
    ctx += `  ${m.name} (${m.region}, tier ${m.tier}):\n`;
    ctx += `    Price: $${m.priceUsd.toFixed(6)}, Pair: ${m.pair}\n`;
    ctx += `    Volume: ${fmtUsd(m.volumeUsd)} (${(m.actualVolShare * 100).toFixed(1)}% share, expected: ${(m.expectedVolShare * 100).toFixed(1)}%)`;
    if (m.volShareDeviation != null) ctx += ` [deviation: ${m.volShareDeviation > 0 ? '+' : ''}${(m.volShareDeviation * 100).toFixed(0)}%]`;
    ctx += `\n`;
    ctx += `    Spread: ${m.spreadBps.toFixed(1)} BPS${m.spreadProvided ? '' : ' (estimated)'}\n`;
    ctx += `    Depth +2%: ${fmtUsd(m.depthPlus2Pct)}, Depth -2%: ${fmtUsd(m.depthMinus2Pct)}`;
    if (m.depthAsymmetry != null) {
      const label = m.depthAsymmetry > 2 ? 'sell-heavy' : m.depthAsymmetry < 0.5 ? 'buy-heavy' : 'balanced';
      ctx += ` (asymmetry: ${m.depthAsymmetry.toFixed(1)}x, ${label})`;
    }
    ctx += `\n`;
    ctx += `    Liq Score: ${m.liquidityScore}/100, Trust: ${m.trustScore ?? 'N/A'}`;
    if (m.isFutures) {
      ctx += `, Type: FUTURES`;
      if (m.fundingRate != null) ctx += `, Funding Rate: ${(m.fundingRate * 100).toFixed(4)}%`;
      if (m.markPrice != null) ctx += `, Mark Price: $${m.markPrice.toFixed(4)}`;
      if (m.priceChange24h != null) ctx += `, 24h Change: ${m.priceChange24h.toFixed(2)}%`;
    }
    ctx += `\n`;
  }

  // Append historical trends if available
  try {
    const trendCtx = getRecentTrendSummary(6);
    if (trendCtx) ctx += '\n' + trendCtx;
  } catch (e) {
    // History DB not yet initialized or empty — skip
  }

  return ctx;
}

const SYSTEM_PROMPT = `You are TaikoWatcher, an expert $TAIKO liquidity analyst bot on Telegram. You have deep knowledge of market making, CEX liquidity, order book dynamics, and the TAIKO token specifically.

YOUR KNOWLEDGE BASE:
- You monitor $TAIKO liquidity across centralized exchanges in real time
- You understand healthy liquidity benchmarks: ~15 BPS spread is good, 20+ BPS starts getting wide
- HTX (huobi), Bybit, and Gate.io are the dominant spot venues. MEXC also significant.
- Binance has TAIKOUSDT perpetual futures (no spot) with ~$400-500K daily volume
- Futures data includes funding rate — positive = longs pay shorts, negative = shorts pay longs
- On-chain Taiko DEX data aggregated from GeckoTerminal: TaikoSwap, Ritsu, Curve, Kodo, iZiSwap, etc.
- DEX liquidity on Taiko L2 is currently very low (tens of thousands TVL, single-digit daily volume)
- DEX data uses TVL as a proxy for depth since there's no traditional order book
- Typical order book depth at +2%: $20-80K range for healthy TAIKO books
- Depth is typically asymmetric (sell/bid side 2-4x deeper than buy/ask side is common)
- Total daily TAIKO market volume is typically $500K-$2M across all exchanges
- Normal spread range: 10-20 BPS on major exchanges, can spike to 200 BPS during volatility
- TAIKO/USDT is the dominant pair (~90%), with smaller EUR and USDC pairs
- Korean exchanges (Upbit, Bithumb) often show Kimchi premium/discount vs global prices

YOUR ALERT THRESHOLDS:
- Spread: > 20 BPS (healthy benchmark: 15 BPS)
- Liquidity score: < 40/100
- Depth critical: < $2K at +2%
- Depth asymmetry: > 3x ratio
- Volume concentration: > 50% deviation from expected exchange share
- Price gap: > 50 BPS across exchanges
- Kimchi premium: > 1%

RESPONSE GUIDELINES:
- Answer in the context of the live market data provided below
- Use BPS for spreads, not percentages
- Be concise but insightful — you're talking to people who understand markets
- When asked about a specific exchange, provide depth, spread, volume share, and any anomalies
- When asked about overall health, compare current metrics to healthy benchmarks
- You can give opinions and recommendations based on your liquidity intelligence
- Format responses for Telegram (plain text, keep it readable, use line breaks)
- Keep responses under 4000 characters (Telegram limit)
- Do NOT use HTML tags in your responses — use plain text with unicode characters for emphasis
- If asked something unrelated to TAIKO or crypto markets, politely redirect`;

async function handleNaturalLanguage(msg) {
  if (!claude) {
    await bot.sendMessage(msg.chat.id, 'AI is not configured. Set ANTHROPIC_API_KEY in .env to enable natural language queries.');
    return;
  }

  const userText = msg.text;
  const chatId = String(msg.chat.id);

  // Show typing indicator
  bot.sendChatAction(msg.chat.id, 'typing');

  try {
    // Build fresh market context
    const marketContext = await buildMarketContext();

    // Add user message to history
    addToHistory(chatId, 'user', userText);

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: `${SYSTEM_PROMPT}\n\n${marketContext}`,
      messages: getChatHistory(chatId),
    });

    const reply = response.content[0]?.text || 'Sorry, I could not generate a response.';

    // Add assistant reply to history
    addToHistory(chatId, 'assistant', reply);

    await bot.sendMessage(msg.chat.id, reply, { disable_web_page_preview: true });

    console.log(`[AI] ${msg.from?.username || chatId}: "${userText.slice(0, 50)}..." → ${reply.length} chars`);

  } catch (err) {
    console.error('[AI] Error:', err.message);
    if (err.status === 429) {
      await bot.sendMessage(msg.chat.id, 'Rate limited — try again in a few seconds.');
    } else {
      await bot.sendMessage(msg.chat.id, 'Sorry, something went wrong processing your question. Try again or use /help for commands.');
    }
  }
}

// Handle all non-command messages → Claude AI
bot.on('message', (msg) => {
  console.log(`[MSG] from ${msg.from?.username || msg.chat.id}: "${msg.text?.slice(0, 60) || '(no text)'}"`);
  if (!msg.text) return;

  // Skip commands
  if (msg.text.startsWith('/')) {
    if (!msg.text.match(/^\/(start|help|status|digest|check|alerts|history|trend|alertlog|mmreport)/)) {
      // Unknown command — still route to AI
      handleNaturalLanguage(msg);
    }
    return;
  }

  // Natural language → Claude
  handleNaturalLanguage(msg);
});

// ──────────────────────────────────────────────────────────────────────────────
//  STARTUP
// ──────────────────────────────────────────────────────────────────────────────
async function startup() {
  initDb();

  const me = await bot.getMe();
  console.log(`✅ Bot connected as @${me.username}`);

  const startMsg = `🥁 <b>TAIKO Liquidity Monitor v2</b> is online!\n\n` +
    `Spread bench: 15.3 BPS | Depth bench: $20-68K\n` +
    `Poll interval: every ${POLL_INTERVAL_SECONDS}s\n` +
    `Type /help for commands, or just ask me anything.`;

  await broadcast(startMsg);

  await runMonitorCycle();

  setInterval(runMonitorCycle, POLL_MS);
  console.log(`\n✅ Monitor running. Next cycle in ${POLL_INTERVAL_SECONDS}s.`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ──────────────────────────────────────────────────────────────────────────────
//  HEALTH SERVER (keeps Render free tier alive)
// ──────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';

const PORT = process.env.PORT || 10000;

const healthServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      markets: latestMarkets.length,
      lastCycle: latestMarkets[0]?.lastFetched || null,
    }));
  } else {
    res.writeHead(200);
    res.end('TaikoWatcher Bot is running.');
  }
});

healthServer.listen(PORT, () => {
  console.log(`🌐 Health server on port ${PORT}`);
});

// ──────────────────────────────────────────────────────────────────────────────
//  RUN
// ──────────────────────────────────────────────────────────────────────────────
startup().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});

process.on('SIGINT',  () => { console.log('\nShutting down...'); bot.stopPolling(); closeDb(); process.exit(0); });
process.on('SIGTERM', () => { bot.stopPolling(); closeDb(); process.exit(0); });

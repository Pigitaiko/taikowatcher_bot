// src/bot.js
// TAIKO Liquidity Monitor — Telegram Bot
// Monitors CEX liquidity and alerts market makers in real time

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { fetchTaikoMarkets, fetchTaikoGlobalStats } from './fetcher.js';
import { detectAlerts, filterCooledDown, SEVERITY, fmtUsd, fmtPct } from './alerts.js';
import { formatAlert, formatDigest, formatHelp } from './formatter.js';

// ──────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────────────────────────────────────────
const {
  TELEGRAM_BOT_TOKEN,
  ALERT_CHAT_IDS = '',
  POLL_INTERVAL_SECONDS = '120',
  ALERT_COOLDOWN_MINUTES = '30',
  LIQ_SCORE_THRESHOLD    = '50',
  SPREAD_THRESHOLD_PCT   = '0.3',
  VOLUME_DROP_THRESHOLD  = '0.3',
  PRICE_GAP_THRESHOLD_PCT = '0.5',
  KIMCHI_PREMIUM_THRESHOLD_PCT = '1.0',
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required. Check your .env file.');
  process.exit(1);
}

const ALERT_CHATS = ALERT_CHAT_IDS
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!ALERT_CHATS.length) {
  console.warn('⚠️  No ALERT_CHAT_IDS configured — alerts will be silent. Set chat IDs in .env');
}

const thresholdConfig = {
  liqScoreThreshold:        parseInt(LIQ_SCORE_THRESHOLD, 10),
  spreadThresholdPct:       parseFloat(SPREAD_THRESHOLD_PCT) / 100,
  volumeDropThreshold:      parseFloat(VOLUME_DROP_THRESHOLD),
  priceGapThresholdPct:     parseFloat(PRICE_GAP_THRESHOLD_PCT) / 100,
  kimchiPremiumThreshold:   parseFloat(KIMCHI_PREMIUM_THRESHOLD_PCT) / 100,
};

const POLL_MS    = parseInt(POLL_INTERVAL_SECONDS, 10) * 1000;
const COOLDOWN_MS = parseInt(ALERT_COOLDOWN_MINUTES, 10) * 60 * 1000;
const DIGEST_INTERVAL_MS = 60 * 60 * 1000; // hourly digest

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

console.log('🥁 TAIKO Liquidity Monitor starting...');
console.log(`📡 Polling every ${POLL_INTERVAL_SECONDS}s`);
console.log(`🔔 Alert chats: ${ALERT_CHATS.join(', ') || 'none configured'}`);
console.log(`⏱️  Cooldown: ${ALERT_COOLDOWN_MINUTES}min per alert type`);

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
      // Small delay between messages to avoid Telegram flood limits
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
}

// ──────────────────────────────────────────────────────────────────────────────
//  BOT COMMANDS
// ──────────────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const welcome = `🥁 <b>TAIKO Liquidity Monitor</b>

Hello! I monitor $TAIKO liquidity across centralized exchanges and alert market makers when action is needed.

Type /help to see all commands.
Type /status for a live snapshot now.`;

  await bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'HTML' });

  // Auto-add this chat to broadcast list if it's a group and not already there
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
      await bot.sendMessage(msg.chat.id, '⚠️ No market data available right now. CoinGecko may be rate limiting. Try again in a minute.');
      return;
    }

    // Quick status card
    const totalVol = markets.reduce((s, m) => s + m.volumeUsd, 0);
    const avgScore = Math.round(markets.reduce((s, m) => s + m.liquidityScore, 0) / markets.length);
    const scoreEmoji = avgScore >= 70 ? '🟢' : avgScore >= 50 ? '🟡' : '🔴';

    let reply = `📡 <b>$TAIKO LIVE STATUS</b>\n`;
    reply += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

    if (global?.priceUsd) {
      const chg = global.priceChange24h;
      reply += `💲 <b>Price:</b> <code>$${global.priceUsd.toFixed(4)}</code>`;
      if (chg != null) reply += ` <code>${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%</code>`;
      reply += `\n`;
    }

    reply += `${scoreEmoji} <b>Avg Liq Score:</b> <code>${avgScore}/100</code>\n`;
    reply += `📦 <b>Total 24h Vol:</b> <code>${fmtUsd(totalVol)}</code>\n\n`;

    reply += `<b>By Exchange:</b>\n`;
    const sorted = [...markets].sort((a, b) => b.liquidityScore - a.liquidityScore);
    for (const m of sorted) {
      const si = m.liquidityScore >= 70 ? '🟢' : m.liquidityScore >= 50 ? '🟡' : '🔴';
      reply += `${si} <code>${m.name.padEnd(9)} $${m.priceUsd.toFixed(4)}  ${fmtUsd(m.volumeUsd).padStart(8)}  ${m.liquidityScore}/100</code>\n`;
    }

    const ts = new Date().toUTCString().replace(' GMT', ' UTC');
    reply += `\n<i>${ts}</i>`;

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

    // Update global cache
    latestMarkets = markets;
    latestGlobal  = global;

  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
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
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

bot.onText(/\/check(?:\s+(.+))?/, async (msg, match) => {
  const query = match[1]?.toLowerCase().trim();
  if (!query) {
    await bot.sendMessage(msg.chat.id, 'Usage: /check mexc\nAvailable: binance, bybit, okx, kucoin, gate, htx, mexc, bitget, upbit, bithumb');
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
      await bot.sendMessage(msg.chat.id, `❌ Exchange "${query}" not found or has no TAIKO data.`);
      return;
    }

    const si = mkt.liquidityScore >= 70 ? '🟢' : mkt.liquidityScore >= 50 ? '🟡' : '🔴';

    let reply = `${si} <b>${mkt.name} — $TAIKO Liquidity Check</b>\n`;
    reply += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;
    reply += `Pair:        <code>${mkt.pair}</code>\n`;
    reply += `Price:       <code>$${mkt.priceUsd.toFixed(6)}</code>\n`;
    reply += `24h Volume:  <code>${fmtUsd(mkt.volumeUsd)}</code>\n`;
    reply += `Spread:      <code>${fmtPct(mkt.spreadPct)}${mkt.spreadProvided ? '' : ' (estimated)'}</code>\n`;

    if (mkt.depthPlus2Pct > 0 || mkt.depthMinus2Pct > 0) {
      reply += `Depth +2%:   <code>${fmtUsd(mkt.depthPlus2Pct)}</code>\n`;
      reply += `Depth -2%:   <code>${fmtUsd(mkt.depthMinus2Pct)}</code>\n`;
    }

    reply += `Liq Score:   <code>${mkt.liquidityScore}/100</code>\n`;
    reply += `Tier:        <code>${mkt.tier}</code>\n`;
    reply += `Region:      <code>${mkt.region}</code>\n`;

    if (mkt.trustScore) reply += `Trust:       <code>${mkt.trustScore}</code>\n`;

    // Diagnosis
    reply += `\n<b>Diagnosis:</b>\n`;
    if (mkt.liquidityScore >= 75) {
      reply += `✅ Liquidity looks healthy. No action needed.\n`;
    } else if (mkt.liquidityScore >= 50) {
      reply += `⚠️ Liquidity is marginal. MM should monitor closely.\n`;
    } else if (mkt.liquidityScore >= 25) {
      reply += `🚨 Liquidity is LOW. MM should add depth to order book.\n`;
    } else {
      reply += `💀 CRITICAL: Order book is dangerously thin. Immediate MM intervention needed.\n`;
    }

    const ts = new Date().toUTCString().replace(' GMT', ' UTC');
    reply += `\n<i>${ts}</i>`;

    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });

  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

bot.onText(/\/alerts/, async (msg) => {
  let reply = `⚙️ <b>Alert Thresholds</b>\n\n`;
  reply += `Liq Score:    <code>< ${thresholdConfig.liqScoreThreshold}</code>\n`;
  reply += `Spread:       <code>> ${fmtPct(thresholdConfig.spreadThresholdPct)}</code>\n`;
  reply += `Vol Drop:     <code>< ${thresholdConfig.volumeDropThreshold * 100}% of prev</code>\n`;
  reply += `Price Gap:    <code>> ${fmtPct(thresholdConfig.priceGapThresholdPct)}</code>\n`;
  reply += `Kimchi:       <code>> ${fmtPct(thresholdConfig.kimchiPremiumThreshold)}</code>\n`;
  reply += `Poll Interval: <code>${POLL_INTERVAL_SECONDS}s</code>\n`;
  reply += `Cooldown:     <code>${ALERT_COOLDOWN_MINUTES}min</code>\n\n`;
  reply += `<i>Edit thresholds in your .env file and restart the bot.</i>`;
  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'HTML' });
});

// Handle unknown commands gracefully
bot.on('message', (msg) => {
  if (msg.text?.startsWith('/') && !msg.text.match(/^\/(start|help|status|digest|check|alerts)/)) {
    bot.sendMessage(msg.chat.id, '❓ Unknown command. Type /help for available commands.');
  }
});

// ──────────────────────────────────────────────────────────────────────────────
//  STARTUP
// ──────────────────────────────────────────────────────────────────────────────
async function startup() {
  // Send startup message to all alert chats
  const me = await bot.getMe();
  console.log(`✅ Bot connected as @${me.username}`);

  const startMsg = `🥁 <b>TAIKO Liquidity Monitor</b> is online!\n\n` +
    `Monitoring $TAIKO liquidity across ${Object.keys(await import('./fetcher.js').then(m => m.EXCHANGE_CONFIG)).length} exchanges.\n` +
    `Poll interval: every ${POLL_INTERVAL_SECONDS}s\n` +
    `Type /help to see commands.`;

  await broadcast(startMsg);

  // Run first cycle immediately
  await runMonitorCycle();

  // Then schedule
  setInterval(runMonitorCycle, POLL_MS);
  console.log(`\n✅ Monitor running. Next cycle in ${POLL_INTERVAL_SECONDS}s.`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ──────────────────────────────────────────────────────────────────────────────
//  RUN
// ──────────────────────────────────────────────────────────────────────────────
startup().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT',  () => { console.log('\nShutting down...'); bot.stopPolling(); process.exit(0); });
process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });

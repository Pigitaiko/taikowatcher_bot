// src/formatter.js
// Formats alerts into rich Telegram messages (HTML parse mode)

import { ALERT_TYPES, SEVERITY, fmtUsd, fmtPct } from './alerts.js';

// Severity emoji + label
const SEV = {
  [SEVERITY.CRITICAL]: { icon: '🔴', label: 'CRITICAL' },
  [SEVERITY.HIGH]:     { icon: '🟠', label: 'HIGH' },
  [SEVERITY.MEDIUM]:   { icon: '🟡', label: 'MEDIUM' },
  [SEVERITY.INFO]:     { icon: '🔵', label: 'INFO' },
};

// Exchange → MM tag mapping (loaded from env)
function getMmTag(exchangeId, env) {
  const key = `${exchangeId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MM_TAG`;
  return env[key] || null;
}

/**
 * Format a single alert into a Telegram HTML message.
 */
export function formatAlert(alert, env = {}) {
  const { icon, label } = SEV[alert.severity] || SEV[SEVERITY.INFO];
  const mmTag = alert.exchangeId ? getMmTag(alert.exchangeId, env) : null;

  let msg = '';

  // ── Header ────────────────────────────────────────────────────────────────
  msg += `${icon} <b>$TAIKO LIQUIDITY ALERT — ${label}</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  // ── Body by type ──────────────────────────────────────────────────────────
  switch (alert.type) {

    case ALERT_TYPES.LOW_LIQUIDITY:
      msg += `📉 <b>LOW LIQUIDITY — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Liq Score:   <code>${alert.score}/100</code> (threshold: ${alert.threshold})\n`;
      if (alert.details?.spread != null)
        msg += `Spread:      <code>${fmtPct(alert.details.spread)}</code>\n`;
      if (alert.details?.depthPlus)
        msg += `Depth +2%:   <code>${fmtUsd(alert.details.depthPlus)}</code>\n`;
      if (alert.details?.depthMinus)
        msg += `Depth -2%:   <code>${fmtUsd(alert.details.depthMinus)}</code>\n`;
      if (alert.details?.volume)
        msg += `24h Volume:  <code>${fmtUsd(alert.details.volume)}</code>\n`;
      break;

    case ALERT_TYPES.WIDE_SPREAD:
      msg += `↔️ <b>WIDE SPREAD — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Spread:      <code>${fmtPct(alert.spreadPct)}</code>\n`;
      msg += `Threshold:   <code>${fmtPct(alert.threshold)}</code>\n`;
      msg += `Multiple:    <code>${(alert.spreadPct / alert.threshold).toFixed(1)}x above limit</code>\n`;
      break;

    case ALERT_TYPES.VOLUME_SPIKE:
      msg += `🚀 <b>VOLUME SPIKE — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Previous:    <code>${fmtUsd(alert.prevVol)}</code>\n`;
      msg += `Current:     <code>${fmtUsd(alert.currentVol)}</code>\n`;
      msg += `Increase:    <code>${alert.ratio.toFixed(1)}x (${((alert.ratio - 1) * 100).toFixed(0)}% up)</code>\n`;
      break;

    case ALERT_TYPES.VOLUME_DROP:
      msg += `📉 <b>VOLUME DROP — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Previous:    <code>${fmtUsd(alert.prevVol)}</code>\n`;
      msg += `Current:     <code>${fmtUsd(alert.currentVol)}</code>\n`;
      msg += `Drop:        <code>${((1 - alert.ratio) * 100).toFixed(0)}% decrease</code>\n`;
      break;

    case ALERT_TYPES.PRICE_GAP:
      msg += `⚡ <b>CROSS-EXCHANGE PRICE GAP</b>\n\n`;
      msg += `Gap:         <code>${fmtPct(alert.gapPct)}</code>\n`;
      msg += `High:        <code>${alert.highExchange} @ $${alert.highPrice.toFixed(4)}</code>\n`;
      msg += `Low:         <code>${alert.lowExchange}  @ $${alert.lowPrice.toFixed(4)}</code>\n`;
      if (alert.allPrices?.length) {
        msg += `\n<b>All prices:</b>\n`;
        for (const { name, price } of alert.allPrices) {
          msg += `  <code>${name.padEnd(10)} $${price.toFixed(4)}</code>\n`;
        }
      }
      break;

    case ALERT_TYPES.KIMCHI_PREMIUM:
      const dir = alert.premiumPct > 0 ? '🌶️ PREMIUM' : '❄️ DISCOUNT';
      msg += `${dir} — ${alert.exchange.toUpperCase()}\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `KR Price:    <code>$${alert.koreanPrice.toFixed(4)}</code>\n`;
      msg += `Global Avg:  <code>$${alert.globalAvg.toFixed(4)}</code>\n`;
      msg += `Premium:     <code>${alert.premiumPct > 0 ? '+' : ''}${fmtPct(alert.premiumPct)}</code>\n`;
      break;

    case ALERT_TYPES.DEPTH_CRITICAL:
      msg += `💀 <b>CRITICAL DEPTH — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Depth +2%:   <code>${fmtUsd(alert.depthPlus)}</code>\n`;
      msg += `Depth -2%:   <code>${fmtUsd(alert.depthMinus)}</code>\n`;
      msg += `⚠️ Book is dangerously thin — any trade causes extreme slippage\n`;
      break;

    default:
      msg += alert.message + '\n';
  }

  // ── Action line ───────────────────────────────────────────────────────────
  msg += `\n<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `⚡ <b>ACTION REQUIRED:</b>\n${alert.action}\n`;

  // ── MM tag ────────────────────────────────────────────────────────────────
  if (mmTag) {
    msg += `\n👤 <b>CC:</b> ${mmTag} — please address immediately\n`;
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const ts = new Date().toUTCString().replace(' GMT', ' UTC');
  msg += `\n<i>${ts}</i>`;

  return msg;
}

/**
 * Format a periodic market status digest (e.g. every hour)
 */
export function formatDigest(markets, globalStats) {
  if (!markets.length) return '⚠️ No market data available.';

  const totalVol   = markets.reduce((s, m) => s + m.volumeUsd, 0);
  const avgSpread  = markets.reduce((s, m) => s + m.spreadPct, 0) / markets.length;
  const prices     = markets.filter(m => m.priceUsd > 0);
  const maxP       = Math.max(...prices.map(m => m.priceUsd));
  const minP       = Math.min(...prices.map(m => m.priceUsd));
  const gapPct     = minP > 0 ? (maxP - minP) / minP : 0;
  const avgScore   = Math.round(markets.reduce((s, m) => s + m.liquidityScore, 0) / markets.length);

  const scoreEmoji = avgScore >= 70 ? '🟢' : avgScore >= 50 ? '🟡' : '🔴';

  let msg = `📊 <b>$TAIKO LIQUIDITY DIGEST</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  if (globalStats?.priceUsd) {
    const chg = globalStats.priceChange24h;
    const chgStr = chg != null ? ` (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% 24h)` : '';
    msg += `💲 Price:    <code>$${globalStats.priceUsd.toFixed(4)}${chgStr}</code>\n`;
  }

  msg += `📦 24h Vol:  <code>${fmtUsd(totalVol)}</code> across ${markets.length} exchanges\n`;
  msg += `↔️ Avg Spread: <code>${fmtPct(avgSpread)}</code>\n`;
  msg += `⚡ Price Gap: <code>${fmtPct(gapPct)}</code> (${fmtUsd(minP * 10000, true)} – $${maxP.toFixed(4)})\n`;
  msg += `${scoreEmoji} Liq Score: <code>${avgScore}/100</code>\n\n`;

  msg += `<b>Exchange Breakdown:</b>\n`;

  const sorted = [...markets].sort((a, b) => b.liquidityScore - a.liquidityScore);
  for (const m of sorted) {
    const si = m.liquidityScore >= 70 ? '🟢' : m.liquidityScore >= 50 ? '🟡' : '🔴';
    msg += `${si} <code>${m.name.padEnd(10)} Vol:${fmtUsd(m.volumeUsd).padStart(8)}  Score:${String(m.liquidityScore).padStart(3)}/100  Spr:${fmtPct(m.spreadPct)}</code>\n`;
  }

  const ts = new Date().toUTCString().replace(' GMT', ' UTC');
  msg += `\n<i>${ts}</i>`;

  return msg;
}

/**
 * Format a help message for the /help command
 */
export function formatHelp() {
  return `🤖 <b>TAIKO Liquidity Monitor Bot</b>

<b>Commands:</b>
/status — Current liquidity snapshot across all exchanges
/digest — Full market digest with scores and volumes
/alerts — List active alert thresholds
/check [exchange] — Check a specific exchange (e.g. /check mexc)
/help — Show this message

<b>Automatic Alerts:</b>
The bot monitors CEX liquidity every 2 minutes and fires alerts when:
• 📉 Liquidity score drops below threshold
• ↔️ Spread widens beyond normal range
• 🚀 Volume spikes 2x+ vs previous window
• ⚡ Price gap opens between exchanges
• 🌶️ Kimchi premium/discount detected
• 💀 Order book depth becomes critically thin

<b>Alert Severity:</b>
🔴 CRITICAL — Immediate action required
🟠 HIGH — Action needed within minutes
🟡 MEDIUM — Monitor closely
🔵 INFO — Informational

Built for the Taiko community 🥁`;
}

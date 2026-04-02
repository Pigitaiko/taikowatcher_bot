// src/formatter.js
// Formats alerts and digests into Telegram HTML messages
// Digest format: BPS spreads, depth asymmetry, volume distribution

import { ALERT_TYPES, SEVERITY, fmtUsd, fmtPct, fmtBps } from './alerts.js';

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
  msg += `${icon} <b>$TAIKO ALERT — ${label}</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  // ── Body by type ──────────────────────────────────────────────────────────
  switch (alert.type) {

    case ALERT_TYPES.LOW_LIQUIDITY:
      msg += `📉 <b>LOW LIQUIDITY — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Liq Score:   <code>${alert.score}/100</code> (threshold: ${alert.threshold})\n`;
      if (alert.details?.spreadBps != null)
        msg += `Spread:      <code>${alert.details.spreadBps.toFixed(1)} BPS</code>\n`;
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
      msg += `Spread:      <code>${alert.spreadBps.toFixed(1)} BPS</code>\n`;
      msg += `Threshold:   <code>${fmtBps(alert.threshold)}</code>\n`;
      msg += `Benchmark:   <code>15.3 BPS</code>\n`;
      msg += `Multiple:    <code>${(alert.spreadPct / alert.threshold).toFixed(1)}x above limit</code>\n`;
      break;

    case ALERT_TYPES.VOLUME_SPIKE:
      msg += `🚀 <b>VOLUME SPIKE — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Previous:    <code>${fmtUsd(alert.prevVol)}</code>\n`;
      msg += `Current:     <code>${fmtUsd(alert.currentVol)}</code>\n`;
      msg += `Increase:    <code>${alert.ratio.toFixed(1)}x</code>\n`;
      break;

    case ALERT_TYPES.VOLUME_DROP:
      msg += `📉 <b>VOLUME DROP — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Previous:    <code>${fmtUsd(alert.prevVol)}</code>\n`;
      msg += `Current:     <code>${fmtUsd(alert.currentVol)}</code>\n`;
      msg += `Drop:        <code>${((1 - alert.ratio) * 100).toFixed(0)}%</code>\n`;
      break;

    case ALERT_TYPES.PRICE_GAP:
      msg += `⚡ <b>CROSS-EXCHANGE PRICE GAP</b>\n\n`;
      msg += `Gap:         <code>${alert.gapBps.toFixed(0)} BPS (${fmtPct(alert.gapPct)})</code>\n`;
      msg += `High:        <code>${alert.highExchange} @ $${alert.highPrice.toFixed(4)}</code>\n`;
      msg += `Low:         <code>${alert.lowExchange}  @ $${alert.lowPrice.toFixed(4)}</code>\n`;
      if (alert.allPrices?.length) {
        msg += `\n<b>All prices:</b>\n`;
        for (const { name, price } of alert.allPrices) {
          msg += `  <code>${name.padEnd(10)} $${price.toFixed(4)}</code>\n`;
        }
      }
      break;

    case ALERT_TYPES.KIMCHI_PREMIUM: {
      const dir = alert.premiumPct > 0 ? '🌶️ PREMIUM' : '❄️ DISCOUNT';
      msg += `${dir} — ${alert.exchange.toUpperCase()}\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `KR Price:    <code>$${alert.koreanPrice.toFixed(4)}</code>\n`;
      msg += `Global Avg:  <code>$${alert.globalAvg.toFixed(4)}</code>\n`;
      msg += `Premium:     <code>${alert.premiumPct > 0 ? '+' : ''}${fmtPct(alert.premiumPct)}</code>\n`;
      break;
    }

    case ALERT_TYPES.DEPTH_CRITICAL:
      msg += `💀 <b>CRITICAL DEPTH — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Depth +2%:   <code>${fmtUsd(alert.depthPlus)}</code>\n`;
      msg += `Depth -2%:   <code>${fmtUsd(alert.depthMinus)}</code>\n`;
      msg += `Book is empty — any trade causes extreme slippage\n`;
      break;

    case ALERT_TYPES.DEPTH_ASYMMETRY:
      msg += `⚖️ <b>DEPTH ASYMMETRY — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:    <code>${alert.exchange}</code>\n`;
      msg += `Depth +2%:   <code>${fmtUsd(alert.depthPlus)}</code> (ask/buy side)\n`;
      msg += `Depth -2%:   <code>${fmtUsd(alert.depthMinus)}</code> (bid/sell side)\n`;
      msg += `Ratio:       <code>${alert.ratio.toFixed(1)}x</code>\n`;
      msg += `Heavy side:  <code>${alert.heavySide}</code>\n`;
      msg += `Light side:  <code>${alert.lightSide}</code>\n`;
      break;

    case ALERT_TYPES.VOLUME_CONCENTRATION:
      msg += `📊 <b>VOLUME ANOMALY — ${alert.exchange.toUpperCase()}</b>\n\n`;
      msg += `Exchange:       <code>${alert.exchange}</code>\n`;
      msg += `Actual share:   <code>${(alert.actualShare * 100).toFixed(1)}%</code>\n`;
      msg += `Expected share: <code>${(alert.expectedShare * 100).toFixed(1)}%</code>\n`;
      msg += `Deviation:      <code>${alert.deviation > 0 ? '+' : ''}${(alert.deviation * 100).toFixed(0)}%</code>\n`;
      break;

    default:
      msg += alert.message + '\n';
  }

  // ── Action line ───────────────────────────────────────────────────────────
  msg += `\n<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n`;
  msg += `⚡ <b>ACTION:</b> ${alert.action}\n`;

  // ── MM tag ────────────────────────────────────────────────────────────────
  if (mmTag) {
    msg += `\n👤 <b>CC:</b> ${mmTag}\n`;
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const ts = new Date().toUTCString().replace(' GMT', ' UTC');
  msg += `\n<i>${ts}</i>`;

  return msg;
}

/**
 * Hourly digest:
 * 1. Global summary (price, volume, avg spread in BPS)
 * 2. Exchange health matrix (score, spread BPS, depth, asymmetry, vol share)
 * 3. Volume distribution vs expected benchmarks
 * 4. Depth asymmetry summary
 */
export function formatDigest(markets, globalStats) {
  if (!markets.length) return 'No market data available.';

  const totalVol     = markets.reduce((s, m) => s + m.volumeUsd, 0);
  const avgSpreadBps = (markets.reduce((s, m) => s + m.spreadPct, 0) / markets.length) * 10000;
  const prices       = markets.filter(m => m.priceUsd > 0);
  const maxP         = Math.max(...prices.map(m => m.priceUsd));
  const minP         = Math.min(...prices.map(m => m.priceUsd));
  const gapBps       = minP > 0 ? ((maxP - minP) / minP) * 10000 : 0;
  const avgScore     = Math.round(markets.reduce((s, m) => s + m.liquidityScore, 0) / markets.length);
  const scoreEmoji   = avgScore >= 70 ? '🟢' : avgScore >= 50 ? '🟡' : '🔴';

  let msg = `📊 <b>$TAIKO LIQUIDITY DIGEST</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  // ── Section 1: Global Summary ─────────────────────────────────────────────
  if (globalStats?.priceUsd) {
    const chg = globalStats.priceChange24h;
    const chgStr = chg != null ? ` (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)` : '';
    msg += `💲 Price:      <code>$${globalStats.priceUsd.toFixed(4)}${chgStr}</code>\n`;
  }
  msg += `📦 24h Vol:    <code>${fmtUsd(totalVol)}</code>\n`;
  msg += `↔️ Avg Spread: <code>${avgSpreadBps.toFixed(1)} BPS</code>`;
  msg += avgSpreadBps <= 20 ? ` ✅\n` : avgSpreadBps <= 40 ? ` ⚠️\n` : ` 🔴\n`;
  msg += `⚡ Price Gap:  <code>${gapBps.toFixed(0)} BPS</code>\n`;
  msg += `${scoreEmoji} Liq Score:  <code>${avgScore}/100</code>\n\n`;

  // ── Section 2: Exchange Health Matrix ─────────────────────────────────────
  msg += `<b>Exchange Health:</b>\n`;

  const spotMarkets = markets.filter(m => !m.isFutures);
  const futuresMarkets = markets.filter(m => m.isFutures);
  const sortedSpot = [...spotMarkets].sort((a, b) => b.volumeUsd - a.volumeUsd);

  for (const m of sortedSpot) {
    const si = m.liquidityScore >= 70 ? '🟢' : m.liquidityScore >= 50 ? '🟡' : '🔴';
    const sprBps = (m.spreadPct * 10000).toFixed(0);
    const volShare = (m.actualVolShare * 100).toFixed(0);

    msg += `${si} <code>${m.name.padEnd(10)}</code> `;
    msg += `Score:<code>${String(m.liquidityScore).padStart(2)}</code> `;
    msg += `Spr:<code>${sprBps.padStart(3)}bps</code> `;
    msg += `Vol:<code>${fmtUsd(m.volumeUsd).padStart(7)}</code> `;
    msg += `<code>${volShare.padStart(2)}%</code>\n`;
  }

  // Futures section
  if (futuresMarkets.length) {
    msg += `\n<b>Futures:</b>\n`;
    for (const m of futuresMarkets) {
      const si = m.liquidityScore >= 70 ? '🟢' : m.liquidityScore >= 50 ? '🟡' : '🔴';
      const sprBps = (m.spreadPct * 10000).toFixed(0);
      msg += `${si} <code>${m.name.padEnd(10)}</code> `;
      msg += `Score:<code>${String(m.liquidityScore).padStart(2)}</code> `;
      msg += `Spr:<code>${sprBps.padStart(3)}bps</code> `;
      msg += `Vol:<code>${fmtUsd(m.volumeUsd).padStart(7)}</code>`;
      if (m.fundingRate != null) {
        const frPct = (m.fundingRate * 100).toFixed(4);
        const frEmoji = m.fundingRate > 0.0001 ? '🔼' : m.fundingRate < -0.0001 ? '🔽' : '➖';
        msg += ` FR:<code>${frPct}%</code>${frEmoji}`;
      }
      msg += `\n`;
    }
  }

  // On-chain DEX section
  const dexMarkets = markets.filter(m => m.isDex);
  if (dexMarkets.length) {
    msg += `\n<b>On-chain (Taiko L2):</b>\n`;
    for (const m of dexMarkets) {
      const si = m.liquidityScore >= 70 ? '🟢' : m.liquidityScore >= 50 ? '🟡' : '🔴';
      msg += `${si} <code>${m.name.padEnd(10)}</code> `;
      msg += `TVL:<code>${fmtUsd(m.totalLiquidity).padStart(7)}</code> `;
      msg += `Vol:<code>${fmtUsd(m.volumeUsd).padStart(7)}</code> `;
      msg += `<code>${m.poolCount} pools</code>\n`;
      // Per-DEX breakdown
      if (m.dexBreakdown) {
        const sorted = Object.entries(m.dexBreakdown)
          .sort(([,a], [,b]) => b.liq - a.liq)
          .slice(0, 5);
        for (const [dex, data] of sorted) {
          const dexName = dex.replace(/-taiko$/, '').replace(/-/g, ' ');
          if (data.liq > 50) {
            msg += `   <code>${dexName.padEnd(14)} TVL:${fmtUsd(data.liq).padStart(7)} Vol:${fmtUsd(data.vol).padStart(6)}</code>\n`;
          }
        }
      }
    }
  }

  // ── Section 3: Volume Distribution vs Expected ───────────────────────────
  const trackedExchanges = sortedSpot.filter(m => m.expectedVolShare >= 0.01);
  if (trackedExchanges.length) {
    msg += `\n<b>Vol Share (Actual vs Benchmark):</b>\n`;
    for (const m of trackedExchanges) {
      const actual = (m.actualVolShare * 100).toFixed(1);
      const expected = (m.expectedVolShare * 100).toFixed(1);
      const dev = m.volShareDeviation;
      const status = dev == null ? '➖'
        : dev > 0.3 ? '⬆️'
        : dev < -0.3 ? '⬇️'
        : '✅';
      msg += `${status} <code>${m.name.padEnd(10)} ${actual.padStart(5)}%  (bench: ${expected.padStart(5)}%)</code>\n`;
    }
  }

  // ── Section 4: Depth Asymmetry ────────────────────────────────────────────
  const withDepth = markets.filter(m => m.depthAsymmetry != null);
  if (withDepth.length) {
    msg += `\n<b>Order Book Depth:</b>\n`;
    for (const m of withDepth.sort((a, b) => b.depthPlus2Pct + b.depthMinus2Pct - a.depthPlus2Pct - a.depthMinus2Pct)) {
      const ratio = m.depthAsymmetry;
      const label = ratio > 2 ? 'sell-heavy' : ratio < 0.5 ? 'buy-heavy' : 'balanced';
      const warn = (ratio > 3 || ratio < 0.33) ? ' ⚠️' : '';
      msg += `<code>${m.name.padEnd(10)} +2%:${fmtUsd(m.depthPlus2Pct).padStart(7)} -2%:${fmtUsd(m.depthMinus2Pct).padStart(7)} ${ratio.toFixed(1)}x ${label}${warn}</code>\n`;
    }
  }

  const ts = new Date().toUTCString().replace(' GMT', ' UTC');
  msg += `\n<i>${ts}</i>`;

  return msg;
}

/**
 * Format a help message for the /help command
 */
export function formatHelp() {
  return `🤖 <b>TAIKO Liquidity Monitor</b>

<b>Commands:</b>
/status — Live liquidity snapshot
/digest — Full market digest with depth + volume analysis
/alerts — Active alert thresholds
/check [exchange] — Deep-dive a specific exchange
/history [exchange] — Price/volume/spread trend (24h)
/trend [exchange] — Compare metrics across time windows
/alertlog — Recent alerts fired (24h)
/mmreport [hours] — MM performance report card (default: 24h)
/help — Show this message

<b>Automatic Alerts:</b>
📉 Liquidity score below threshold
↔️ Spread widens beyond 20 BPS (healthy: ~15 BPS)
🚀 Volume spike 2x+ vs previous window
📉 Volume drop &gt;70% from previous
⚡ Cross-exchange price gap
🌶️ Kimchi premium/discount
💀 Order book depth critically thin
⚖️ Depth asymmetry (one side 3x+ thinner)
📊 Volume concentration anomaly vs benchmarks

<b>Severity:</b>
🔴 CRITICAL — Immediate action
🟠 HIGH — Action needed within minutes
🟡 MEDIUM — Monitor closely
🔵 INFO — Informational

You can also ask me anything in natural language 🥁`;
}

// ──────────────────────────────────────────────────────────────────────────────
//  HISTORICAL DATA FORMATTERS
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Format history data as hourly samples for a specific exchange.
 */
export function formatHistory(rows, exchangeName, hours) {
  if (!rows.length) return `📈 No historical data for ${exchangeName} yet. Data is collected each polling cycle — check back in a few minutes.`;

  // Downsample to ~1 per hour
  const bucketMs = 3600_000;
  const sampled = [];
  let lastBucket = 0;
  for (const r of rows) {
    const bucket = Math.floor(r.ts / bucketMs);
    if (bucket !== lastBucket) {
      sampled.push(r);
      lastBucket = bucket;
    }
  }

  // Limit to last 24 samples
  const display = sampled.slice(-24);

  const first = display[0];
  const last = display[display.length - 1];
  const priceChg = first.price > 0 ? ((last.price - first.price) / first.price * 100).toFixed(2) : '?';
  const volChg = first.volume > 0 ? ((last.volume - first.volume) / first.volume * 100).toFixed(0) : '?';

  let msg = `📈 <b>${exchangeName} — ${hours}h History</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;
  msg += `Price: <code>$${first.price.toFixed(4)} → $${last.price.toFixed(4)} (${priceChg}%)</code>\n`;
  msg += `Volume: <code>${fmtUsd(first.volume)} → ${fmtUsd(last.volume)} (${volChg}%)</code>\n`;
  msg += `Spread: <code>${first.spread_bps.toFixed(0)} → ${last.spread_bps.toFixed(0)} BPS</code>\n`;
  msg += `Score: <code>${first.liq_score} → ${last.liq_score}/100</code>\n\n`;

  msg += `<b>Hourly Samples:</b>\n`;
  msg += `<code>Time     Price    Vol     Spr  Score</code>\n`;
  for (const r of display) {
    const t = new Date(r.ts).toUTCString().slice(17, 22); // HH:MM
    const p = `$${r.price.toFixed(4)}`;
    const v = fmtUsd(r.volume).padStart(6);
    const s = `${r.spread_bps.toFixed(0)}`.padStart(3);
    const sc = `${r.liq_score}`.padStart(3);
    msg += `<code>${t}  ${p}  ${v}  ${s}  ${sc}</code>\n`;
  }

  const ts = new Date().toUTCString().replace(' GMT', ' UTC');
  msg += `\n<i>${display.length} samples | ${ts}</i>`;
  return msg;
}

/**
 * Format global price history when no exchange specified.
 */
export function formatGlobalHistory(rows, hours) {
  if (!rows.length) return `📈 No global history data yet. Check back in a few minutes.`;

  const bucketMs = 3600_000;
  const sampled = [];
  let lastBucket = 0;
  for (const r of rows) {
    const bucket = Math.floor(r.ts / bucketMs);
    if (bucket !== lastBucket) {
      sampled.push(r);
      lastBucket = bucket;
    }
  }

  const display = sampled.slice(-24);
  const first = display[0];
  const last = display[display.length - 1];

  let msg = `📈 <b>$TAIKO Global — ${hours}h History</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  if (first.price && last.price) {
    const chg = ((last.price - first.price) / first.price * 100).toFixed(2);
    msg += `Price: <code>$${first.price.toFixed(4)} → $${last.price.toFixed(4)} (${chg}%)</code>\n`;
  }

  msg += `\n<b>Hourly:</b>\n`;
  msg += `<code>Time     Price     MCap      24h Vol</code>\n`;
  for (const r of display) {
    const t = new Date(r.ts).toUTCString().slice(17, 22);
    const p = r.price ? `$${r.price.toFixed(4)}` : 'N/A   ';
    const mc = fmtUsd(r.market_cap).padStart(8);
    const v = fmtUsd(r.total_volume).padStart(8);
    msg += `<code>${t}  ${p}  ${mc}  ${v}</code>\n`;
  }

  const ts = new Date().toUTCString().replace(' GMT', ' UTC');
  msg += `\n<i>${display.length} samples | ${ts}</i>`;
  return msg;
}

/**
 * Format alert log as a list.
 */
export function formatAlertLog(rows) {
  if (!rows.length) return `📋 No alerts in the last 24 hours. All quiet!`;

  const sevEmoji = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', INFO: '🔵' };

  let msg = `📋 <b>Alert Log — Last 24h</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;
  msg += `<code>${rows.length} alert(s) fired</code>\n\n`;

  for (const [i, r] of rows.entries()) {
    if (i >= 20) {
      msg += `\n<i>... and ${rows.length - 20} more</i>`;
      break;
    }
    const time = new Date(r.ts).toUTCString().slice(5, 22); // DD Mon HH:MM
    const sev = sevEmoji[r.severity] || '⚪';
    const exch = r.exchange_id || 'global';
    msg += `${sev} <code>${time}</code> ${r.type}\n   <i>${exch}: ${r.message.slice(0, 80)}</i>\n`;
  }

  const ts = new Date().toUTCString().replace(' GMT', ' UTC');
  msg += `\n<i>${ts}</i>`;
  return msg;
}

/**
 * Format trend comparison across time windows.
 */
export function formatTrend(trendData, exchangeName) {
  if (!trendData?.now) return `📊 No trend data for ${exchangeName} yet. Data is collected each polling cycle.`;

  const n = trendData.now;
  const windows = [
    ['1h',  trendData.h1],
    ['6h',  trendData.h6],
    ['24h', trendData.h24],
    ['7d',  trendData.d7],
  ];

  let msg = `📊 <b>${exchangeName} — Trend Analysis</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  // Header
  msg += `<code>           Now   `;
  for (const [label] of windows) msg += `${label.padStart(7)}  `;
  msg += `</code>\n`;

  // Price row
  msg += `<code>Price    $${n.price.toFixed(4)}`;
  for (const [, snap] of windows) {
    if (snap) {
      const chg = ((n.price - snap.price) / snap.price * 100).toFixed(1);
      const arrow = chg > 0 ? '▲' : chg < 0 ? '▼' : '─';
      msg += `  ${arrow}${Math.abs(chg).toFixed(1)}%`.padStart(9);
    } else {
      msg += `      N/A`;
    }
  }
  msg += `</code>\n`;

  // Volume row
  msg += `<code>Volume  ${fmtUsd(n.volume).padStart(7)}`;
  for (const [, snap] of windows) {
    if (snap && snap.volume > 0) {
      const chg = ((n.volume - snap.volume) / snap.volume * 100).toFixed(0);
      const arrow = chg > 0 ? '▲' : chg < 0 ? '▼' : '─';
      msg += `  ${arrow}${Math.abs(chg)}%`.padStart(9);
    } else {
      msg += `      N/A`;
    }
  }
  msg += `</code>\n`;

  // Spread row
  msg += `<code>Spread  ${n.spread_bps.toFixed(0).padStart(4)}bps`;
  for (const [, snap] of windows) {
    if (snap) {
      const diff = n.spread_bps - snap.spread_bps;
      const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '─';
      msg += `  ${arrow}${Math.abs(diff).toFixed(0)}bps`.padStart(9);
    } else {
      msg += `      N/A`;
    }
  }
  msg += `</code>\n`;

  // Score row
  msg += `<code>Score   ${String(n.liq_score).padStart(5)}`;
  for (const [, snap] of windows) {
    if (snap) {
      const diff = n.liq_score - snap.liq_score;
      const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '─';
      msg += `    ${arrow}${Math.abs(diff)}`.padStart(9);
    } else {
      msg += `      N/A`;
    }
  }
  msg += `</code>\n`;

  // Funding rate for futures
  if (n.funding_rate != null) {
    msg += `\n<code>Funding  ${(n.funding_rate * 100).toFixed(4)}%</code>\n`;
  }

  const ts = new Date().toUTCString().replace(' GMT', ' UTC');
  msg += `\n<i>${ts}</i>`;
  return msg;
}

/**
 * Format MM performance report.
 * Grades each exchange A-F based on spread, depth, score, and SLA.
 */
export function formatMmReport(rows, hours, liveMarkets = []) {
  if (!rows.length) {
    return `📊 <b>MM Performance Report</b>\n\nNo historical data yet. The bot needs to run for a few hours to collect enough snapshots.`;
  }

  // Grading: weighted score 0-100
  // Spread (40%): 15 BPS = 100, 30 BPS = 50, 60+ BPS = 0
  // Depth (25%): avg(ask+bid) — $50K+ = 100, $20K = 60, $5K = 20, $0 = 0
  // Score avg (20%): directly maps to 0-100
  // SLA (15%): % of time spread <= 20 BPS
  function grade(row) {
    const spreadScore = Math.max(0, Math.min(100, (60 - row.avg_spread) / (60 - 10) * 100));
    const avgDepth = ((row.avg_depth_plus || 0) + (row.avg_depth_minus || 0)) / 2;
    const depthScore = Math.min(100, (avgDepth / 50000) * 100);
    const liqScore = row.avg_score || 0;
    const slaScore = row.spread_sla_pct || 0;
    const total = spreadScore * 0.40 + depthScore * 0.25 + liqScore * 0.20 + slaScore * 0.15;
    return { total, spreadScore, depthScore, liqScore, slaScore };
  }

  function letterGrade(score) {
    if (score >= 85) return { letter: 'A', emoji: '🟢' };
    if (score >= 70) return { letter: 'B', emoji: '🟢' };
    if (score >= 55) return { letter: 'C', emoji: '🟡' };
    if (score >= 40) return { letter: 'D', emoji: '🟠' };
    return { letter: 'F', emoji: '🔴' };
  }

  const graded = rows
    .filter(r => !r.exchange_id.includes('dex') && !r.exchange_id.includes('_futures'))
    .map(row => {
      const scores = grade(row);
      const { letter, emoji } = letterGrade(scores.total);
      const live = liveMarkets.find(m => m.exchangeId === row.exchange_id);
      return { ...row, scores, letter, emoji, live };
    })
    .sort((a, b) => b.scores.total - a.scores.total);

  if (!graded.length) {
    return `📊 <b>MM Performance Report</b>\n\nNo spot exchange data available for grading.`;
  }

  let msg = `📊 <b>MM PERFORMANCE REPORT (${hours}h)</b>\n`;
  msg += `<code>━━━━━━━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;

  // Summary line
  const avgGrade = graded.reduce((s, g) => s + g.scores.total, 0) / graded.length;
  const { letter: overallLetter, emoji: overallEmoji } = letterGrade(avgGrade);
  msg += `${overallEmoji} <b>Overall MM Quality: ${overallLetter} (${avgGrade.toFixed(0)}/100)</b>\n`;
  msg += `<i>Benchmark: spread ≤15 BPS, depth ≥$20K at ±2%</i>\n\n`;

  for (const g of graded) {
    const avgDepth = ((g.avg_depth_plus || 0) + (g.avg_depth_minus || 0)) / 2;

    msg += `${g.emoji} <b>${g.exchange_id.charAt(0).toUpperCase() + g.exchange_id.slice(1)}</b> — Grade: <b>${g.letter}</b> (${g.scores.total.toFixed(0)})\n`;
    msg += `<code>  Spread   ${g.avg_spread.toFixed(1)} BPS avg`;
    if (g.max_spread > g.avg_spread * 1.5) msg += ` (peak: ${g.max_spread.toFixed(0)})`;
    msg += `\n`;
    msg += `  Depth    ${fmtUsd(avgDepth)} avg (ask: ${fmtUsd(g.avg_depth_plus || 0)}, bid: ${fmtUsd(g.avg_depth_minus || 0)})\n`;
    msg += `  Score    ${g.avg_score.toFixed(0)}/100 avg (low: ${g.min_score}, high: ${g.max_score})\n`;
    msg += `  SLA      ${g.spread_sla_pct.toFixed(0)}% of time ≤20 BPS\n`;
    msg += `  Alerts   ${g.alert_count} in ${hours}h</code>\n`;

    if (g.live) {
      const nowSpread = g.live.spreadBps.toFixed(1);
      const dir = g.live.spreadBps > g.avg_spread ? '↑' : g.live.spreadBps < g.avg_spread ? '↓' : '→';
      msg += `  <i>Now: ${nowSpread} BPS ${dir} | Score: ${g.live.liquidityScore}/100</i>\n`;
    }
    msg += `\n`;
  }

  // Futures section
  const futures = rows.filter(r => r.exchange_id.includes('_futures'));
  if (futures.length) {
    msg += `<b>Futures:</b>\n`;
    for (const f of futures) {
      const scores = grade(f);
      const { letter, emoji } = letterGrade(scores.total);
      msg += `${emoji} <code>${f.exchange_id.replace('_futures', ' F')}: ${f.avg_spread.toFixed(1)} BPS avg, score ${f.avg_score.toFixed(0)}/100 — ${letter}</code>\n`;
    }
    msg += `\n`;
  }

  // Worst offenders
  const worst = graded.filter(g => g.letter === 'F' || g.letter === 'D');
  if (worst.length) {
    msg += `⚠️ <b>Needs attention:</b> ${worst.map(w => w.exchange_id).join(', ')}\n`;
  }

  const ts = new Date().toUTCString().replace(' GMT', ' UTC');
  msg += `\n<i>${ts}</i>`;

  return msg;
}


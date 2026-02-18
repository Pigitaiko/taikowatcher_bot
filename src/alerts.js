// src/alerts.js
// Detects liquidity anomalies and produces structured alert objects

export const ALERT_TYPES = {
  LOW_LIQUIDITY:    'LOW_LIQUIDITY',
  WIDE_SPREAD:      'WIDE_SPREAD',
  VOLUME_SPIKE:     'VOLUME_SPIKE',
  VOLUME_DROP:      'VOLUME_DROP',
  PRICE_GAP:        'PRICE_GAP',
  KIMCHI_PREMIUM:   'KIMCHI_PREMIUM',
  DEPTH_CRITICAL:   'DEPTH_CRITICAL',
};

export const SEVERITY = {
  CRITICAL: 'CRITICAL',   // 🔴
  HIGH:     'HIGH',       // 🟠
  MEDIUM:   'MEDIUM',     // 🟡
  INFO:     'INFO',       // 🔵
};

/**
 * Run all detection rules against current market snapshot.
 * Returns array of alert objects.
 *
 * @param {Object[]} markets        - current snapshot
 * @param {Object[]} prevMarkets    - previous snapshot (for trend detection)
 * @param {Object}   globalStats    - global price / volume data
 * @param {Object}   config         - thresholds from env
 */
export function detectAlerts(markets, prevMarkets, globalStats, config) {
  const alerts = [];

  if (!markets?.length) return alerts;

  const {
    liqScoreThreshold   = 50,
    spreadThresholdPct  = 0.003,   // 0.3%
    volumeDropThreshold = 0.30,    // 30% of average
    priceGapThresholdPct = 0.005,  // 0.5%
    kimchiPremiumThreshold = 0.01, // 1%
  } = config;

  // ── 1. LOW LIQUIDITY SCORE ────────────────────────────────────────────────
  for (const mkt of markets) {
    if (mkt.liquidityScore < liqScoreThreshold) {
      const severity = mkt.liquidityScore < 25
        ? SEVERITY.CRITICAL
        : mkt.liquidityScore < 40
        ? SEVERITY.HIGH
        : SEVERITY.MEDIUM;

      alerts.push({
        type:       ALERT_TYPES.LOW_LIQUIDITY,
        severity,
        exchangeId: mkt.exchangeId,
        exchange:   mkt.name,
        score:      mkt.liquidityScore,
        threshold:  liqScoreThreshold,
        details: {
          spread:       mkt.spreadPct,
          depthPlus:    mkt.depthPlus2Pct,
          depthMinus:   mkt.depthMinus2Pct,
          volume:       mkt.volumeUsd,
        },
        message: `${mkt.name} liquidity score is critically low: ${mkt.liquidityScore}/100`,
        action:  `Market maker on ${mkt.name} must rebalance order book immediately. ` +
                 `Current spread: ${fmtPct(mkt.spreadPct)}, Depth +2%: ${fmtUsd(mkt.depthPlus2Pct)}, -2%: ${fmtUsd(mkt.depthMinus2Pct)}`,
      });
    }
  }

  // ── 2. WIDE SPREAD ────────────────────────────────────────────────────────
  for (const mkt of markets) {
    if (mkt.spreadPct > spreadThresholdPct) {
      const severity = mkt.spreadPct > spreadThresholdPct * 3
        ? SEVERITY.CRITICAL
        : mkt.spreadPct > spreadThresholdPct * 2
        ? SEVERITY.HIGH
        : SEVERITY.MEDIUM;

      alerts.push({
        type:       ALERT_TYPES.WIDE_SPREAD,
        severity,
        exchangeId: mkt.exchangeId,
        exchange:   mkt.name,
        spreadPct:  mkt.spreadPct,
        threshold:  spreadThresholdPct,
        message:    `${mkt.name} spread is abnormally wide: ${fmtPct(mkt.spreadPct)} (threshold: ${fmtPct(spreadThresholdPct)})`,
        action:     `MM on ${mkt.name}: tighten the spread. Wide spreads signal low depth and invite arb bots.`,
      });
    }
  }

  // ── 3. VOLUME SPIKE / DROP (vs previous snapshot) ────────────────────────
  if (prevMarkets?.length) {
    for (const mkt of markets) {
      const prev = prevMarkets.find(p => p.exchangeId === mkt.exchangeId);
      if (!prev || prev.volumeUsd === 0) continue;

      const ratio = mkt.volumeUsd / prev.volumeUsd;

      // Volume SPIKE: more than 2x
      if (ratio > 2.0) {
        const avgOtherVol = markets
          .filter(m => m.exchangeId !== mkt.exchangeId)
          .reduce((s, m) => s + m.volumeUsd, 0) / (markets.length - 1 || 1);

        const relativeSpike = mkt.volumeUsd / (avgOtherVol || 1);

        alerts.push({
          type:        ALERT_TYPES.VOLUME_SPIKE,
          severity:    relativeSpike > 3 ? SEVERITY.CRITICAL : SEVERITY.HIGH,
          exchangeId:  mkt.exchangeId,
          exchange:    mkt.name,
          currentVol:  mkt.volumeUsd,
          prevVol:     prev.volumeUsd,
          ratio,
          message:     `🚨 Volume spike on ${mkt.name}: ${ratio.toFixed(1)}x increase (${fmtUsd(prev.volumeUsd)} → ${fmtUsd(mkt.volumeUsd)})`,
          action:      `${mkt.name} MM: volume spike detected. Ensure order book depth is adequate for increased flow. Risk of price impact on thin book.`,
        });
      }

      // Volume DROP: less than 30% of previous
      if (ratio < volumeDropThreshold && prev.volumeUsd > 50_000) {
        alerts.push({
          type:       ALERT_TYPES.VOLUME_DROP,
          severity:   SEVERITY.MEDIUM,
          exchangeId: mkt.exchangeId,
          exchange:   mkt.name,
          currentVol: mkt.volumeUsd,
          prevVol:    prev.volumeUsd,
          ratio,
          message:    `Volume drop on ${mkt.name}: down ${((1 - ratio) * 100).toFixed(0)}% (${fmtUsd(prev.volumeUsd)} → ${fmtUsd(mkt.volumeUsd)})`,
          action:     `${mkt.name} MM: verify markets are active and API feeds are healthy.`,
        });
      }
    }
  }

  // ── 4. PRICE GAP ACROSS EXCHANGES ────────────────────────────────────────
  const globalMarkets = markets.filter(m => m.region === 'global' && m.priceUsd > 0);
  if (globalMarkets.length >= 2) {
    const prices   = globalMarkets.map(m => m.priceUsd);
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const gapPct   = (maxPrice - minPrice) / minPrice;

    if (gapPct > priceGapThresholdPct) {
      const highEx = globalMarkets.find(m => m.priceUsd === maxPrice);
      const lowEx  = globalMarkets.find(m => m.priceUsd === minPrice);

      alerts.push({
        type:      ALERT_TYPES.PRICE_GAP,
        severity:  gapPct > priceGapThresholdPct * 2 ? SEVERITY.CRITICAL : SEVERITY.HIGH,
        highExchange: highEx?.name,
        lowExchange:  lowEx?.name,
        highPrice:    maxPrice,
        lowPrice:     minPrice,
        gapPct,
        message:   `Cross-exchange price gap: ${fmtPct(gapPct)} between ${highEx?.name} ($${maxPrice.toFixed(4)}) and ${lowEx?.name} ($${minPrice.toFixed(4)})`,
        action:    `Arbitrage pressure building. MMs on ${lowEx?.name} and ${highEx?.name} should check order book alignment. Gap this wide invites predatory arb.`,
        allPrices: globalMarkets.map(m => ({ name: m.name, price: m.priceUsd })),
      });
    }
  }

  // ── 5. KIMCHI PREMIUM (Korea vs Global) ──────────────────────────────────
  const koreanMarkets = markets.filter(m => m.region === 'korea' && m.priceUsd > 0);
  const globalAvgPrice = globalMarkets.length
    ? globalMarkets.reduce((s, m) => s + m.priceUsd, 0) / globalMarkets.length
    : 0;

  if (koreanMarkets.length && globalAvgPrice > 0) {
    for (const km of koreanMarkets) {
      const premium = (km.priceUsd - globalAvgPrice) / globalAvgPrice;
      if (Math.abs(premium) > kimchiPremiumThreshold) {
        const isPositive = premium > 0;

        alerts.push({
          type:         ALERT_TYPES.KIMCHI_PREMIUM,
          severity:     Math.abs(premium) > kimchiPremiumThreshold * 2 ? SEVERITY.CRITICAL : SEVERITY.HIGH,
          exchange:     km.name,
          exchangeId:   km.exchangeId,
          premiumPct:   premium,
          koreanPrice:  km.priceUsd,
          globalAvg:    globalAvgPrice,
          message:      `${isPositive ? 'Kimchi premium' : 'Korean discount'} on ${km.name}: ${fmtPct(Math.abs(premium))} ${isPositive ? 'above' : 'below'} global avg ($${globalAvgPrice.toFixed(4)} → $${km.priceUsd.toFixed(4)})`,
          action:       `${km.name} MM: ${isPositive
            ? 'Korean price significantly above global — heavy sell pressure incoming, ensure ask side is deep'
            : 'Korean price below global — possible liquidity crisis or exchange-specific issue, investigate immediately'}`,
        });
      }
    }
  }

  // ── 6. CRITICAL ORDER BOOK DEPTH ─────────────────────────────────────────
  const DEPTH_CRITICAL_USD = 10_000; // below $10k depth is a red flag
  for (const mkt of markets) {
    if (
      mkt.depthPlus2Pct > 0 &&
      mkt.depthMinus2Pct > 0 &&
      (mkt.depthPlus2Pct < DEPTH_CRITICAL_USD || mkt.depthMinus2Pct < DEPTH_CRITICAL_USD)
    ) {
      alerts.push({
        type:       ALERT_TYPES.DEPTH_CRITICAL,
        severity:   SEVERITY.CRITICAL,
        exchangeId: mkt.exchangeId,
        exchange:   mkt.name,
        depthPlus:  mkt.depthPlus2Pct,
        depthMinus: mkt.depthMinus2Pct,
        message:    `💀 Critical order book depth on ${mkt.name}: +2% depth = ${fmtUsd(mkt.depthPlus2Pct)}, -2% depth = ${fmtUsd(mkt.depthMinus2Pct)}`,
        action:     `URGENT: ${mkt.name} order book is dangerously thin. Any moderate buy/sell will cause massive slippage. MM must post orders NOW.`,
      });
    }
  }

  return alerts;
}

/**
 * Compare current alerts with a cooldown registry.
 * Returns only alerts that haven't been sent recently.
 */
export function filterCooledDown(alerts, cooldownRegistry, cooldownMs) {
  const now = Date.now();
  return alerts.filter(alert => {
    const key = `${alert.type}::${alert.exchangeId || alert.highExchange || 'global'}`;
    const lastSent = cooldownRegistry.get(key);
    if (lastSent && (now - lastSent) < cooldownMs) return false;
    cooldownRegistry.set(key, now);
    return true;
  });
}

// ── Formatting helpers ────────────────────────────────────────────────────────
export function fmtUsd(n) {
  if (!n || n === 0) return 'N/A';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtPct(n) {
  if (n == null) return 'N/A';
  return `${(n * 100).toFixed(3)}%`;
}

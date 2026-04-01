// src/alerts.js
// Detects liquidity anomalies for $TAIKO across CEXs

export const ALERT_TYPES = {
  LOW_LIQUIDITY:        'LOW_LIQUIDITY',
  WIDE_SPREAD:          'WIDE_SPREAD',
  VOLUME_SPIKE:         'VOLUME_SPIKE',
  VOLUME_DROP:          'VOLUME_DROP',
  PRICE_GAP:            'PRICE_GAP',
  KIMCHI_PREMIUM:       'KIMCHI_PREMIUM',
  DEPTH_CRITICAL:       'DEPTH_CRITICAL',
  DEPTH_ASYMMETRY:      'DEPTH_ASYMMETRY',
  VOLUME_CONCENTRATION: 'VOLUME_CONCENTRATION',
};

export const SEVERITY = {
  CRITICAL: 'CRITICAL',   // 🔴
  HIGH:     'HIGH',       // 🟠
  MEDIUM:   'MEDIUM',     // 🟡
  INFO:     'INFO',       // 🔵
};

/**
 * Run all detection rules against current market snapshot.
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
    liqScoreThreshold       = 40,      // recalibrated: 40 is concern level with new scoring
    spreadThresholdPct      = 0.002,   // 20 BPS — 15 BPS is healthy, 20+ is wide
    volumeDropThreshold     = 0.30,    // 30% of previous
    priceGapThresholdPct    = 0.005,   // 0.5%
    kimchiPremiumThreshold  = 0.01,    // 1%
    depthAsymmetryThreshold = 3.0,     // 3x ratio — signals lopsided book
    volConcentrationThreshold = 0.50,  // 50% deviation from expected share
  } = config;

  // ── 1. LOW LIQUIDITY SCORE ────────────────────────────────────────────────
  for (const mkt of markets) {
    if (mkt.liquidityScore < liqScoreThreshold) {
      // Skip if individual metrics look healthy — likely a CoinGecko data gap
      if (mkt.spreadBps <= 20 && mkt.depthPlus2Pct > 10_000 && mkt.volumeUsd > 20_000) continue;
      const severity = mkt.liquidityScore < 15
        ? SEVERITY.CRITICAL
        : mkt.liquidityScore < 25
        ? SEVERITY.HIGH
        : SEVERITY.MEDIUM;

      // Build action text that explains WHY the score is low
      const issues = [];
      if (mkt.spreadBps > 20) issues.push(`wide spread (${fmtBps(mkt.spreadPct)})`);
      if (mkt.depthPlus2Pct > 0 && mkt.depthPlus2Pct < 5_000) issues.push(`thin ask depth (${fmtUsd(mkt.depthPlus2Pct)})`);
      if (mkt.depthMinus2Pct > 0 && mkt.depthMinus2Pct < 5_000) issues.push(`thin bid depth (${fmtUsd(mkt.depthMinus2Pct)})`);
      if (mkt.volumeUsd < 10_000) issues.push(`low volume (${fmtUsd(mkt.volumeUsd)})`);
      const actionText = issues.length
        ? `${mkt.name} MM: score low due to ${issues.join(', ')}.`
        : `${mkt.name} score is ${mkt.liquidityScore}/100. Spread: ${fmtBps(mkt.spreadPct)}, Depth +2%: ${fmtUsd(mkt.depthPlus2Pct)}, -2%: ${fmtUsd(mkt.depthMinus2Pct)}.`;

      alerts.push({
        type:       ALERT_TYPES.LOW_LIQUIDITY,
        severity,
        exchangeId: mkt.exchangeId,
        exchange:   mkt.name,
        score:      mkt.liquidityScore,
        threshold:  liqScoreThreshold,
        details: {
          spread:       mkt.spreadPct,
          spreadBps:    mkt.spreadBps,
          depthPlus:    mkt.depthPlus2Pct,
          depthMinus:   mkt.depthMinus2Pct,
          volume:       mkt.volumeUsd,
        },
        message: `${mkt.name} liquidity score low: ${mkt.liquidityScore}/100`,
        action:  actionText,
      });
    }
  }

  // ── 2. WIDE SPREAD ────────────────────────────────────────────────────────
  // Healthy spread ~15 BPS. Threshold at 20 BPS.
  // MEDIUM: 20-40 BPS, HIGH: 40-60 BPS, CRITICAL: >60 BPS
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
        spreadBps:  mkt.spreadBps,
        threshold:  spreadThresholdPct,
        message:    `${mkt.name} spread is wide: ${fmtBps(mkt.spreadPct)} (threshold: ${fmtBps(spreadThresholdPct)})`,
        action:     `MM on ${mkt.name}: tighten spread. Healthy benchmark is 15 BPS. Current: ${fmtBps(mkt.spreadPct)}.`,
      });
    }
  }

  // ── 3. VOLUME SPIKE / DROP (vs previous snapshot) ────────────────────────
  if (prevMarkets?.length) {
    for (const mkt of markets) {
      const prev = prevMarkets.find(p => p.exchangeId === mkt.exchangeId);
      if (!prev || prev.volumeUsd === 0) continue;

      const ratio = mkt.volumeUsd / prev.volumeUsd;

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
          message:     `Volume spike on ${mkt.name}: ${ratio.toFixed(1)}x (${fmtUsd(prev.volumeUsd)} → ${fmtUsd(mkt.volumeUsd)})`,
          action:      mkt.depthPlus2Pct > 0 && mkt.depthPlus2Pct < 20_000
            ? `${mkt.name} MM: volume spike on thin book (depth +2%: ${fmtUsd(mkt.depthPlus2Pct)}). Risk of price impact.`
            : `${mkt.name} MM: volume spike detected. Monitor order book depth for increased flow.`,
        });
      }

      // Volume DROP: less than 30% of previous (min $10k to filter noise)
      if (ratio < volumeDropThreshold && prev.volumeUsd > 10_000) {
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
        gapBps:       gapPct * 10000,
        message:   `Cross-exchange price gap: ${(gapPct * 10000).toFixed(0)} BPS between ${highEx?.name} ($${maxPrice.toFixed(4)}) and ${lowEx?.name} ($${minPrice.toFixed(4)})`,
        action:    `Arbitrage pressure building. MMs on ${lowEx?.name} and ${highEx?.name} should check order book alignment.`,
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
          message:      `${isPositive ? 'Kimchi premium' : 'Korean discount'} on ${km.name}: ${fmtPct(Math.abs(premium))} ${isPositive ? 'above' : 'below'} global avg`,
          action:       `${km.name} MM: ${isPositive
            ? 'Korean price above global — ensure ask side is deep for sell pressure'
            : 'Korean price below global — possible liquidity crisis, investigate immediately'}`,
        });
      }
    }
  }

  // ── 6. CRITICAL ORDER BOOK DEPTH ─────────────────────────────────────────
  // At +2%, $5-10k is normal for smaller TAIKO exchanges.
  // Only alert below $2k at +2% — that's genuinely empty.
  const DEPTH_CRITICAL_USD = 2_000;
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
        message:    `Critical depth on ${mkt.name}: +2% = ${fmtUsd(mkt.depthPlus2Pct)}, -2% = ${fmtUsd(mkt.depthMinus2Pct)}`,
        action:     `${mkt.name}: order book depth dangerously thin (&lt; $2K at +2%). High slippage risk on any moderate trade.`,
      });
    }
  }

  // ── 7. DEPTH ASYMMETRY ──────────────────────────────────────────────────
  // 3-4x sell/buy asymmetry is common but noteworthy.
  // Alert when ratio exceeds threshold — signals directional risk.
  for (const mkt of markets) {
    if (mkt.depthAsymmetry == null) continue;
    const ratio = mkt.depthAsymmetry;     // sell/buy ratio
    const inverseRatio = 1 / ratio;        // buy/sell ratio
    const maxRatio = Math.max(ratio, inverseRatio);

    if (maxRatio > depthAsymmetryThreshold) {
      const heavySide = ratio > 1 ? 'sell (bid)' : 'buy (ask)';
      const lightSide = ratio > 1 ? 'buy (ask)'  : 'sell (bid)';
      const thinDepth = ratio > 1 ? mkt.depthPlus2Pct : mkt.depthMinus2Pct;

      alerts.push({
        type:       ALERT_TYPES.DEPTH_ASYMMETRY,
        severity:   maxRatio > 5 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        exchangeId: mkt.exchangeId,
        exchange:   mkt.name,
        depthPlus:  mkt.depthPlus2Pct,
        depthMinus: mkt.depthMinus2Pct,
        ratio:      maxRatio,
        heavySide,
        lightSide,
        message:    `Depth asymmetry on ${mkt.name}: ${heavySide} ${maxRatio.toFixed(1)}x deeper than ${lightSide}`,
        action:     `${mkt.name} MM: book is lopsided. ${lightSide} has only ${fmtUsd(thinDepth)}. Rebalance to reduce directional risk.`,
      });
    }
  }

  // ── 8. VOLUME CONCENTRATION ANOMALY ───────────────────────────────────────
  // Track when exchanges deviate from expected volume share
  // Gate.io should be ~47%, Bybit ~43%. If Gate drops to 20%, something's wrong.
  for (const mkt of markets) {
    if (mkt.volShareDeviation == null) continue;
    if (mkt.expectedVolShare < 0.01) continue;

    // Underperformance
    if (mkt.volShareDeviation < -volConcentrationThreshold) {
      alerts.push({
        type:       ALERT_TYPES.VOLUME_CONCENTRATION,
        severity:   mkt.volShareDeviation < -0.75 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        exchangeId: mkt.exchangeId,
        exchange:   mkt.name,
        expectedShare: mkt.expectedVolShare,
        actualShare:   mkt.actualVolShare,
        deviation:     mkt.volShareDeviation,
        message:    `${mkt.name} volume ${Math.abs(mkt.volShareDeviation * 100).toFixed(0)}% below expected share`,
        action:     `${mkt.name}: volume share dropped to ${(mkt.actualVolShare * 100).toFixed(1)}% (expected ${(mkt.expectedVolShare * 100).toFixed(1)}%). Check MM feed health or liquidity migration.`,
      });
    }

    // Massive overperformance (could indicate wash trading or organic migration)
    if (mkt.volShareDeviation > volConcentrationThreshold * 2) {
      alerts.push({
        type:       ALERT_TYPES.VOLUME_CONCENTRATION,
        severity:   SEVERITY.INFO,
        exchangeId: mkt.exchangeId,
        exchange:   mkt.name,
        expectedShare: mkt.expectedVolShare,
        actualShare:   mkt.actualVolShare,
        deviation:     mkt.volShareDeviation,
        message:    `${mkt.name} volume ${(mkt.volShareDeviation * 100).toFixed(0)}% above expected — possible migration or anomaly`,
        action:     `Investigate: ${mkt.name} capturing disproportionate volume. Could be organic shift or suspicious activity.`,
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
  return `${(n * 100).toFixed(2)}%`;
}

export function fmtBps(n) {
  if (n == null) return 'N/A';
  return `${(n * 10000).toFixed(1)} BPS`;
}

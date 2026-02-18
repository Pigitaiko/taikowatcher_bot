// src/fetcher.js
// Fetches live $TAIKO market data from CoinGecko

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const TAIKO_ID = 'taiko';

// All exchanges we monitor, with their CoinGecko IDs
export const EXCHANGE_CONFIG = {
  binance:    { name: 'Binance',  tier: 1, region: 'global' },
  bybit_spot: { name: 'Bybit',   tier: 1, region: 'global' },
  okex:       { name: 'OKX',     tier: 1, region: 'global' },
  kucoin:     { name: 'KuCoin',  tier: 2, region: 'global' },
  gate:       { name: 'Gate.io', tier: 2, region: 'global' },
  htx:        { name: 'HTX',     tier: 2, region: 'global' },
  bitget:     { name: 'Bitget',  tier: 2, region: 'global' },
  mexc:       { name: 'MEXC',    tier: 2, region: 'global' },
  upbit:      { name: 'Upbit',   tier: 1, region: 'korea'  },
  bithumb:    { name: 'Bithumb', tier: 1, region: 'korea'  },
};

/**
 * Fetch all $TAIKO tickers from CoinGecko
 * Returns normalized market data per exchange
 */
export async function fetchTaikoMarkets() {
  const url = `${COINGECKO_BASE}/coins/${TAIKO_ID}/tickers?include_exchange_logo=false&depth=true`;

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'TaikoLiquidityBot/1.0',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`CoinGecko API error: HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const tickers = json.tickers || [];

  const markets = [];

  for (const [exchangeId, cfg] of Object.entries(EXCHANGE_CONFIG)) {
    const matches = tickers.filter(t =>
      t.market?.identifier === exchangeId &&
      (t.target === 'USDT' || t.target === 'USD' || t.target === 'USDC' || t.target === 'KRW')
    );

    if (!matches.length) continue;

    // Prefer USDT, fall back to others
    const ticker =
      matches.find(m => m.target === 'USDT') ||
      matches.find(m => m.target === 'USD')  ||
      matches[0];

    const priceUsd      = parseFloat(ticker.converted_last?.usd || 0);
    const volumeUsd     = parseFloat(ticker.converted_volume?.usd || 0);
    const spreadPct     = ticker.bid_ask_spread_percentage != null
                            ? parseFloat(ticker.bid_ask_spread_percentage) / 100
                            : null; // null = not provided by exchange

    // Depth data (2% order book depth in USD)
    const depthPlus2Pct  = parseFloat(ticker.cost_to_move_up_usd   || 0); // cost to move price +2%
    const depthMinus2Pct = parseFloat(ticker.cost_to_move_down_usd || 0); // cost to move price -2%

    const liquidityScore = computeLiquidityScore({
      spreadPct: spreadPct ?? estimateSpread(cfg.tier),
      depthPlus:  depthPlus2Pct,
      depthMinus: depthMinus2Pct,
      volumeUsd,
      tier: cfg.tier,
    });

    markets.push({
      exchangeId,
      name:        cfg.name,
      tier:        cfg.tier,
      region:      cfg.region,
      pair:        `${ticker.base}/${ticker.target}`,
      priceUsd,
      volumeUsd,
      spreadPct:   spreadPct ?? estimateSpread(cfg.tier),
      spreadProvided: spreadPct != null,
      depthPlus2Pct,
      depthMinus2Pct,
      liquidityScore,
      trustScore:  ticker.trust_score || null,
      isAnomaly:   ticker.is_anomaly || false,
      lastFetched: new Date(),
    });
  }

  return markets;
}

/**
 * Compute a composite liquidity score (0–100)
 * Weights: spread 35%, depth 40%, volume 15%, tier bonus 10%
 */
function computeLiquidityScore({ spreadPct, depthPlus, depthMinus, volumeUsd, tier }) {
  const tierBonus = tier === 1 ? 10 : tier === 2 ? 5 : 0;

  // Spread score: 0% = 35pts, 0.5% = 0pts
  const spreadScore = Math.max(0, 35 * (1 - spreadPct / 0.005));

  // Depth score: $500k each side = full marks
  const avgDepth    = (depthPlus + depthMinus) / 2;
  const depthScore  = Math.min(40, (avgDepth / 500_000) * 40);

  // Volume score: $1M = full marks
  const volScore    = Math.min(15, (volumeUsd / 1_000_000) * 15);

  return Math.round(Math.min(100, Math.max(0, spreadScore + depthScore + volScore + tierBonus)));
}

function estimateSpread(tier) {
  return tier === 1 ? 0.0008 : tier === 2 ? 0.0018 : 0.004;
}

/**
 * Fetch simple price + market cap overview
 */
export async function fetchTaikoGlobalStats() {
  const url = `${COINGECKO_BASE}/coins/${TAIKO_ID}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const json = await res.json();
  const md = json.market_data;
  return {
    priceUsd:        md?.current_price?.usd ?? null,
    priceKrw:        md?.current_price?.krw ?? null,
    volume24hUsd:    md?.total_volume?.usd  ?? null,
    priceChange24h:  md?.price_change_percentage_24h ?? null,
    marketCapUsd:    md?.market_cap?.usd ?? null,
  };
}

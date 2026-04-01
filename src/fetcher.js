// src/fetcher.js
// Fetches live $TAIKO market data from CoinGecko + Binance Futures API
// Calibrated to real TAIKO market benchmarks

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com/fapi/v1';
const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';
const TAIKO_ID = 'taiko';

// TAIKO token address on Taiko chain (wrapped)
const TAIKO_TOKEN_ADDR = '0xa9d23408b9ba935c230493c40c73824df71a0975';

// CoinGecko exchange IDs (verified against actual API responses)
// NOTE: HTX = "huobi", MEXC = "mxc" on CoinGecko
export const EXCHANGE_CONFIG = {
  huobi:      { name: 'HTX',       tier: 1, region: 'global', expectedVolShare: 0.35 },
  bybit_spot: { name: 'Bybit',     tier: 1, region: 'global', expectedVolShare: 0.25 },
  gate:       { name: 'Gate.io',   tier: 1, region: 'global', expectedVolShare: 0.10 },
  mxc:        { name: 'MEXC',      tier: 2, region: 'global', expectedVolShare: 0.08 },
  bitget:     { name: 'Bitget',    tier: 2, region: 'global', expectedVolShare: 0.05 },
  kucoin:     { name: 'KuCoin',    tier: 2, region: 'global', expectedVolShare: 0.05 },
  bitvavo:    { name: 'Bitvavo',   tier: 2, region: 'europe', expectedVolShare: 0.01 },
  upbit:      { name: 'Upbit',     tier: 1, region: 'korea',  expectedVolShare: 0.00 },
  bithumb:    { name: 'Bithumb',   tier: 1, region: 'korea',  expectedVolShare: 0.00 },
};

/**
 * Fetch all $TAIKO tickers from CoinGecko
 * Returns normalized market data per exchange with MM-grade metrics
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
      (t.target === 'USDT' || t.target === 'USD' || t.target === 'USDC' || t.target === 'KRW' || t.target === 'EUR')
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
                            : null;

    // Depth data (2% order book depth in USD)
    const depthPlus2Pct  = parseFloat(ticker.cost_to_move_up_usd   || 0);
    const depthMinus2Pct = parseFloat(ticker.cost_to_move_down_usd || 0);

    // Depth asymmetry: sell/buy ratio. >1 means sell side deeper.
    const depthAsymmetry = (depthPlus2Pct > 0 && depthMinus2Pct > 0)
      ? depthMinus2Pct / depthPlus2Pct
      : null;

    const effectiveSpread = spreadPct ?? estimateSpread(cfg.tier);

    const liquidityScore = computeLiquidityScore({
      spreadPct: effectiveSpread,
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
      spreadPct:   effectiveSpread,
      spreadBps:   effectiveSpread * 10000,
      spreadProvided: spreadPct != null,
      depthPlus2Pct,
      depthMinus2Pct,
      depthAsymmetry,
      liquidityScore,
      trustScore:  ticker.trust_score || null,
      isAnomaly:   ticker.is_anomaly || false,
      lastFetched: new Date(),
    });
  }

  // Fetch Binance Futures + Taiko DEX aggregate in parallel
  const [futuresResult, dexResult] = await Promise.allSettled([
    fetchBinanceFutures(),
    fetchTaikoDexAggregate(),
  ]);

  if (futuresResult.status === 'fulfilled' && futuresResult.value) {
    markets.push(futuresResult.value);
  } else if (futuresResult.status === 'rejected') {
    console.warn('Binance Futures fetch failed:', futuresResult.reason?.message);
  }

  if (dexResult.status === 'fulfilled' && dexResult.value) {
    markets.push(dexResult.value);
  } else if (dexResult.status === 'rejected') {
    console.warn('Taiko DEX fetch failed:', dexResult.reason?.message);
  }

  // Compute volume share metrics after we have all markets
  const totalVol = markets.reduce((s, m) => s + m.volumeUsd, 0);
  for (const mkt of markets) {
    mkt.actualVolShare = totalVol > 0 ? mkt.volumeUsd / totalVol : 0;
    mkt.expectedVolShare = EXCHANGE_CONFIG[mkt.exchangeId]?.expectedVolShare ?? 0;
    mkt.volShareDeviation = mkt.expectedVolShare > 0.005
      ? (mkt.actualVolShare - mkt.expectedVolShare) / mkt.expectedVolShare
      : null;
    mkt.totalMarketVol = totalVol;
  }

  return markets;
}

/**
 * Composite liquidity score (0–100) calibrated to TAIKO market reality
 *
 * Benchmarks:
 *   Spread: ~15 BPS is healthy. Normal range 10-20 BPS.
 *   Depth:  At +2% expect $20-80k range for healthy TAIKO books.
 *   Volume: Total market ~$500k/day. Single exchange doing $100k+ is top tier.
 *
 * Weights: spread 35%, depth 40%, volume 15%, tier bonus 10%
 */
function computeLiquidityScore({ spreadPct, depthPlus, depthMinus, volumeUsd, tier }) {
  const tierBonus = tier === 1 ? 10 : tier === 2 ? 5 : 0;

  // Spread score: 0 BPS = 35pts, 50 BPS (0.005) = 0pts
  // 15 BPS healthy spread should score ~25/35
  const spreadScore = Math.max(0, 35 * (1 - spreadPct / 0.005));

  // Depth score: $50k avg each side = full marks (40pts)
  // $20-80k at +2% depth is realistic for healthy TAIKO book
  const avgDepth    = (depthPlus + depthMinus) / 2;
  const depthScore  = Math.min(40, (avgDepth / 50_000) * 40);

  // Volume score: $100k per exchange = full marks (15pts)
  // Total market ~$500k, so $100k/exchange is excellent
  const volScore    = Math.min(15, (volumeUsd / 100_000) * 15);

  return Math.round(Math.min(100, Math.max(0, spreadScore + depthScore + volScore + tierBonus)));
}

// Estimated spreads when exchange doesn't report bid/ask
function estimateSpread(tier) {
  return tier === 1 ? 0.0015 : tier === 2 ? 0.003 : 0.006; // 15 BPS, 30 BPS, 60 BPS
}

/**
 * Fetch Binance Futures TAIKOUSDT data (24h ticker + order book depth)
 * Returns a market object compatible with the CoinGecko-sourced ones
 */
async function fetchBinanceFutures() {
  const [tickerRes, depthRes, fundingRes] = await Promise.all([
    fetch(`${BINANCE_FUTURES_BASE}/ticker/24hr?symbol=TAIKOUSDT`, { signal: AbortSignal.timeout(10000) }),
    fetch(`${BINANCE_FUTURES_BASE}/depth?symbol=TAIKOUSDT&limit=50`, { signal: AbortSignal.timeout(10000) }),
    fetch(`${BINANCE_FUTURES_BASE}/premiumIndex?symbol=TAIKOUSDT`, { signal: AbortSignal.timeout(10000) }),
  ]);

  if (!tickerRes.ok) return null;

  const ticker = await tickerRes.json();
  const depth = depthRes.ok ? await depthRes.json() : null;
  const funding = fundingRes.ok ? await fundingRes.json() : null;

  const lastPrice = parseFloat(ticker.lastPrice);
  const volumeUsd = parseFloat(ticker.quoteVolume || 0);

  // Calculate spread from best bid/ask in depth data
  let spreadPct = null;
  if (depth?.bids?.length && depth?.asks?.length) {
    const bestBid = parseFloat(depth.bids[0][0]);
    const bestAsk = parseFloat(depth.asks[0][0]);
    spreadPct = (bestAsk - bestBid) / bestBid;
  }

  // Calculate depth within +/- 2% of mid price
  let depthPlus2Pct = 0;
  let depthMinus2Pct = 0;
  if (depth) {
    const upperBound = lastPrice * 1.02;
    const lowerBound = lastPrice * 0.98;
    for (const [price, qty] of depth.asks || []) {
      if (parseFloat(price) <= upperBound) depthPlus2Pct += parseFloat(price) * parseFloat(qty);
    }
    for (const [price, qty] of depth.bids || []) {
      if (parseFloat(price) >= lowerBound) depthMinus2Pct += parseFloat(price) * parseFloat(qty);
    }
  }

  const depthAsymmetry = (depthPlus2Pct > 0 && depthMinus2Pct > 0)
    ? depthMinus2Pct / depthPlus2Pct
    : null;

  const effectiveSpread = spreadPct ?? 0.0008; // 8 BPS fallback for futures

  const liquidityScore = computeLiquidityScore({
    spreadPct: effectiveSpread,
    depthPlus: depthPlus2Pct,
    depthMinus: depthMinus2Pct,
    volumeUsd,
    tier: 1,
  });

  return {
    exchangeId:     'binance_futures',
    name:           'Binance F',
    tier:           1,
    region:         'global',
    pair:           'TAIKO/USDT',
    priceUsd:       lastPrice,
    volumeUsd,
    spreadPct:      effectiveSpread,
    spreadBps:      effectiveSpread * 10000,
    spreadProvided: spreadPct != null,
    depthPlus2Pct,
    depthMinus2Pct,
    depthAsymmetry,
    liquidityScore,
    trustScore:     null,
    isAnomaly:      false,
    isFutures:      true,
    fundingRate:    funding?.lastFundingRate ? parseFloat(funding.lastFundingRate) : null,
    markPrice:      funding?.markPrice ? parseFloat(funding.markPrice) : null,
    priceChange24h: parseFloat(ticker.priceChangePercent || 0),
    openInterest:   null, // could add via /openInterest endpoint
    lastFetched:    new Date(),
  };
}

/**
 * Fetch aggregate Taiko on-chain DEX data from GeckoTerminal.
 * Aggregates all TAIKO pools across TaikoSwap, Ritsu, Curve, Kodo, iZiSwap, etc.
 * Returns a single "Taiko DEX" market entry.
 */
async function fetchTaikoDexAggregate() {
  const url = `${GECKOTERMINAL_BASE}/networks/taiko/tokens/${TAIKO_TOKEN_ADDR}/pools?page=1`;

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return null;

  const json = await res.json();
  const pools = json.data || [];

  if (!pools.length) return null;

  let totalVolume24h = 0;
  let totalLiquidity = 0;
  let weightedPrice = 0;
  let totalWeight = 0;
  const dexBreakdown = {};

  for (const pool of pools) {
    const a = pool.attributes;
    const vol = parseFloat(a.volume_usd?.h24 || 0);
    const liq = parseFloat(a.reserve_in_usd || 0);
    const dexId = pool.relationships?.dex?.data?.id || 'unknown';

    // Determine TAIKO price from pool data.
    // Skip multi-token pools (e.g. Curve crvUSD/CRV/TAIKO) — unreliable price extraction
    const poolName = (a.name || '').toUpperCase();
    const isSimplePair = (poolName.match(/\//g) || []).length === 1;

    const basePrice = parseFloat(a.base_token_price_usd || 0);
    const quotePrice = parseFloat(a.quote_token_price_usd || 0);

    // For simple pairs: TAIKO is whichever side is NOT WETH/USDC/USDT ($1-$5000)
    // TAIKO is currently ~$0.05-$0.50
    let price = 0;
    if (isSimplePair) {
      if (basePrice > 0.01 && basePrice < 1 && quotePrice > 1) price = basePrice;
      else if (quotePrice > 0.01 && quotePrice < 1 && basePrice > 1) price = quotePrice;
    }

    totalVolume24h += vol;
    totalLiquidity += liq;

    // Volume-weighted price (only pools with meaningful volume)
    if (vol > 0 && price > 0) {
      weightedPrice += price * vol;
      totalWeight += vol;
    }

    // Track per-DEX breakdown
    if (!dexBreakdown[dexId]) dexBreakdown[dexId] = { vol: 0, liq: 0 };
    dexBreakdown[dexId].vol += vol;
    dexBreakdown[dexId].liq += liq;
  }

  const avgPrice = totalWeight > 0 ? weightedPrice / totalWeight : 0;
  if (avgPrice === 0) return null;

  // DEX pools don't have traditional spread/depth — estimate from liquidity
  // More liquidity = tighter effective spread
  const estimatedSpread = totalLiquidity > 100_000 ? 0.003 // 30 BPS
    : totalLiquidity > 10_000 ? 0.01   // 100 BPS
    : totalLiquidity > 1_000 ? 0.03    // 300 BPS
    : 0.05;                             // 500 BPS

  const liquidityScore = computeLiquidityScore({
    spreadPct: estimatedSpread,
    depthPlus: totalLiquidity / 2,  // rough proxy: half of TVL each side
    depthMinus: totalLiquidity / 2,
    volumeUsd: totalVolume24h,
    tier: 3,
  });

  return {
    exchangeId:     'taiko_dex',
    name:           'Taiko DEX',
    tier:           3,
    region:         'onchain',
    pair:           'TAIKO/WETH+USDC',
    priceUsd:       avgPrice,
    volumeUsd:      totalVolume24h,
    spreadPct:      estimatedSpread,
    spreadBps:      estimatedSpread * 10000,
    spreadProvided: false,
    depthPlus2Pct:  totalLiquidity / 2,
    depthMinus2Pct: totalLiquidity / 2,
    depthAsymmetry: null,
    liquidityScore,
    trustScore:     null,
    isAnomaly:      false,
    isDex:          true,
    totalLiquidity,
    poolCount:      pools.length,
    dexBreakdown,
    lastFetched:    new Date(),
  };
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

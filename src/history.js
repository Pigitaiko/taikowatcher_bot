// src/history.js
// SQLite-backed historical data storage for TAIKO liquidity monitoring
// Uses better-sqlite3 (synchronous) for simplicity and performance

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(__dirname, '../data/taiko.db');

let db = null;

// ──────────────────────────────────────────────────────────────────────────────
//  INIT
// ──────────────────────────────────────────────────────────────────────────────
export function initDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      exchange_id TEXT NOT NULL,
      price       REAL NOT NULL,
      volume      REAL NOT NULL,
      spread_bps  REAL NOT NULL,
      depth_plus  REAL,
      depth_minus REAL,
      liq_score   INTEGER NOT NULL,
      funding_rate REAL,
      vol_share   REAL
    );
    CREATE INDEX IF NOT EXISTS idx_snap_ts ON snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_snap_exch_ts ON snapshots(exchange_id, ts);

    CREATE TABLE IF NOT EXISTS alert_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      type        TEXT NOT NULL,
      severity    TEXT NOT NULL,
      exchange_id TEXT,
      message     TEXT NOT NULL,
      details     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_ts ON alert_log(ts);

    CREATE TABLE IF NOT EXISTS globals (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ts               INTEGER NOT NULL,
      price            REAL,
      price_change_24h REAL,
      market_cap       REAL,
      total_volume     REAL
    );
    CREATE INDEX IF NOT EXISTS idx_globals_ts ON globals(ts);
  `);

  console.log(`📦 History DB initialized at ${dbPath}`);
  return db;
}

// ──────────────────────────────────────────────────────────────────────────────
//  SAVE
// ──────────────────────────────────────────────────────────────────────────────
const _insertSnapshot = () => db.prepare(`
  INSERT INTO snapshots (ts, exchange_id, price, volume, spread_bps, depth_plus, depth_minus, liq_score, funding_rate, vol_share)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const _insertGlobal = () => db.prepare(`
  INSERT INTO globals (ts, price, price_change_24h, market_cap, total_volume)
  VALUES (?, ?, ?, ?, ?)
`);

export function saveSnapshot(markets, global) {
  if (!db || !markets?.length) return;

  const now = Date.now();
  const insertSnap = _insertSnapshot();
  const insertGlob = _insertGlobal();

  const saveAll = db.transaction(() => {
    for (const m of markets) {
      insertSnap.run(
        now,
        m.exchangeId,
        m.priceUsd,
        m.volumeUsd,
        m.spreadBps,
        m.depthPlus2Pct || null,
        m.depthMinus2Pct || null,
        m.liquidityScore,
        m.fundingRate ?? null,
        m.actualVolShare ?? null,
      );
    }
    if (global) {
      insertGlob.run(
        now,
        global.priceUsd,
        global.priceChange24h,
        global.marketCapUsd,
        global.volume24hUsd,
      );
    }
  });

  saveAll();
}

// ──────────────────────────────────────────────────────────────────────────────
//  LOG ALERT
// ──────────────────────────────────────────────────────────────────────────────
export function logAlert(alert) {
  if (!db) return;
  db.prepare(`
    INSERT INTO alert_log (ts, type, severity, exchange_id, message, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    alert.type,
    alert.severity,
    alert.exchangeId || alert.highExchange || null,
    alert.message,
    JSON.stringify(alert),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
//  QUERY: HISTORY
// ──────────────────────────────────────────────────────────────────────────────
export function getHistory(exchangeId, hours = 24) {
  if (!db) return [];
  const cutoff = Date.now() - hours * 3600_000;
  return db.prepare(`
    SELECT ts, price, volume, spread_bps, depth_plus, depth_minus, liq_score, funding_rate, vol_share
    FROM snapshots
    WHERE exchange_id = ? AND ts > ?
    ORDER BY ts ASC
  `).all(exchangeId, cutoff);
}

export function getGlobalHistory(hours = 24) {
  if (!db) return [];
  const cutoff = Date.now() - hours * 3600_000;
  return db.prepare(`
    SELECT ts, price, price_change_24h, market_cap, total_volume
    FROM globals
    WHERE ts > ?
    ORDER BY ts ASC
  `).all(cutoff);
}

// ──────────────────────────────────────────────────────────────────────────────
//  QUERY: ALERT LOG
// ──────────────────────────────────────────────────────────────────────────────
export function getAlertLog(hours = 24) {
  if (!db) return [];
  const cutoff = Date.now() - hours * 3600_000;
  return db.prepare(`
    SELECT ts, type, severity, exchange_id, message
    FROM alert_log
    WHERE ts > ?
    ORDER BY ts DESC
    LIMIT 30
  `).all(cutoff);
}

// ──────────────────────────────────────────────────────────────────────────────
//  QUERY: TREND (comparison across time windows)
// ──────────────────────────────────────────────────────────────────────────────
export function getTrend(exchangeId) {
  if (!db) return null;

  const now = Date.now();
  const offsets = {
    now:  0,
    h1:   3600_000,
    h6:   6 * 3600_000,
    h24:  24 * 3600_000,
    d7:   7 * 24 * 3600_000,
  };

  const stmt = db.prepare(`
    SELECT ts, price, volume, spread_bps, depth_plus, depth_minus, liq_score, funding_rate, vol_share
    FROM snapshots
    WHERE exchange_id = ? AND ts <= ? AND ts > ?
    ORDER BY ts DESC
    LIMIT 1
  `);

  const result = {};
  for (const [key, offset] of Object.entries(offsets)) {
    const target = now - offset;
    const minTs = target - 300_000; // allow 5-minute window
    result[key] = stmt.get(exchangeId, target + 300_000, minTs) || null;
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
//  QUERY: AI CONTEXT SUMMARY
// ──────────────────────────────────────────────────────────────────────────────
export function getRecentTrendSummary(hours = 6) {
  if (!db) return '';

  const now = Date.now();
  const cutoff = now - hours * 3600_000;

  // Get distinct exchanges that have data in the window
  const exchanges = db.prepare(`
    SELECT DISTINCT exchange_id FROM snapshots WHERE ts > ?
  `).all(cutoff).map(r => r.exchange_id);

  if (!exchanges.length) return '';

  const earliest = db.prepare(`
    SELECT price, volume, spread_bps, liq_score
    FROM snapshots WHERE exchange_id = ? AND ts > ? ORDER BY ts ASC LIMIT 1
  `);
  const latest = db.prepare(`
    SELECT price, volume, spread_bps, liq_score
    FROM snapshots WHERE exchange_id = ? AND ts > ? ORDER BY ts DESC LIMIT 1
  `);

  let ctx = `\n=== HISTORICAL TRENDS (last ${hours}h) ===\n`;

  for (const exId of exchanges) {
    const e = earliest.get(exId, cutoff);
    const l = latest.get(exId, cutoff);
    if (!e || !l) continue;

    const pChg = e.price > 0 ? ((l.price - e.price) / e.price * 100).toFixed(1) : '?';
    const vChg = e.volume > 0 ? ((l.volume - e.volume) / e.volume * 100).toFixed(0) : '?';
    ctx += `  ${exId}: price $${l.price.toFixed(4)} (${pChg}%), vol $${(l.volume/1000).toFixed(0)}K (${vChg}%), spread ${l.spread_bps.toFixed(0)}→${l.spread_bps.toFixed(0)} BPS, score ${e.liq_score}→${l.liq_score}\n`;
  }

  // Recent alerts
  const alertCount = db.prepare(`SELECT COUNT(*) as cnt FROM alert_log WHERE ts > ?`).get(cutoff);
  const recentAlerts = db.prepare(`
    SELECT type, exchange_id, severity FROM alert_log WHERE ts > ? ORDER BY ts DESC LIMIT 5
  `).all(cutoff);

  if (alertCount.cnt > 0) {
    ctx += `\nRecent alerts (${hours}h): ${alertCount.cnt} fired`;
    if (recentAlerts.length) {
      ctx += ' — ' + recentAlerts.map(a => `${a.severity} ${a.type} on ${a.exchange_id || 'global'}`).join(', ');
    }
    ctx += '\n';
  }

  return ctx;
}

// ──────────────────────────────────────────────────────────────────────────────
//  CLEANUP
// ──────────────────────────────────────────────────────────────────────────────
export function purgeOld(days = 30) {
  if (!db) return;
  const cutoff = Date.now() - days * 86400_000;
  db.prepare('DELETE FROM snapshots WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM alert_log WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM globals WHERE ts < ?').run(cutoff);
}

export function close() {
  if (db) {
    db.close();
    db = null;
  }
}

'use strict';
const sql    = require('mssql');
const fs     = require('fs');
const path   = require('path');

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json niet gevonden op ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const pools = {};

function mssqlConfig(db) {
  return {
    server:   db.server,
    port:     db.port || 1433,
    database: db.database,
    user:     db.user,
    password: db.password,
    options: {
      encrypt:                true,
      trustServerCertificate: false,
      connectTimeout:         30000,
      requestTimeout:         30000,
      enableArithAbort:       true,
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

async function getPool(label) {
  const cfg = loadConfig();
  const db  = cfg.databases.find(d => d.label === label);
  if (!db) {
    const available = cfg.databases.map(d => d.label).join(', ');
    throw new Error(`DB "${label}" niet gevonden in config.json. Beschikbaar: ${available}`);
  }
  if (!pools[label]) {
    pools[label] = await new sql.ConnectionPool(mssqlConfig(db)).connect();
    console.log(`DB verbonden: ${label} (${db.server})`);
  }
  return pools[label];
}

async function query(label, queryStr, params = {}) {
  const pool    = await getPool(label);
  const request = pool.request();
  for (const [key, val] of Object.entries(params)) {
    request.input(key, val);
  }
  const result = await request.query(queryStr);
  return result.recordset;
}

/**
 * Voert SQL uit in een transactie met ROLLBACK.
 * Geeft preview resultaten terug (de SELECT aan het einde van de SQL).
 * Transactie wordt altijd gerollbacked — enkel voor preview.
 */
async function previewSQL(label, sqlStr) {
  const pool = await getPool(label);
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const request = new sql.Request(transaction);
    // Splits op GO statements indien aanwezig, voer batch per batch uit
    // Laatste recordset is de SELECT verificatie
    const result = await request.query(sqlStr);
    // Altijd rollback voor preview
    await transaction.rollback();
    // mssql geeft recordsets terug als array bij meerdere statements
    const sets = result.recordsets || (result.recordset ? [result.recordset] : []);
    const preview = sets[sets.length - 1] || [];
    return { ok: true, preview, rolledBack: true };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

/**
 * Voert SQL uit met COMMIT.
 * Geeft de SELECT verificatie resultaten terug.
 */
async function executeSQL(label, sqlStr) {
  const pool = await getPool(label);
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const request = new sql.Request(transaction);
    const result  = await request.query(sqlStr);
    await transaction.commit();
    const sets    = result.recordsets || (result.recordset ? [result.recordset] : []);
    const rows    = sets[sets.length - 1] || [];
    return { ok: true, rows, committed: true };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

async function closeAll() {
  for (const [label, pool] of Object.entries(pools)) {
    await pool.close();
    console.log(`DB pool gesloten: ${label}`);
    delete pools[label];
  }
}

function getDatabases() {
  const cfg = loadConfig();
  return cfg.databases.map(db => ({
    label:   db.label,
    schema:  db.schema,
    default: db.default || false,
  }));
}

module.exports = { query, getPool, closeAll, getDatabases, loadConfig, previewSQL, executeSQL };

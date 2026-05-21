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

module.exports = { query, getPool, closeAll, getDatabases, loadConfig };

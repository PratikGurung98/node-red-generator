'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const db      = require('./connection');

// ── GET /api/db/categories ────────────────────────────────────────────────────
router.get('/categories', (_req, res) => {
  try {
    const cats = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'categories.json'), 'utf8'));
    res.json({ ok: true, ...cats });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /api/db/list — alle geconfigureerde DBs (geen credentials) ────────────
router.get('/list', (_req, res) => {
  try {
    res.json({ ok: true, databases: db.getDatabases() });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /api/db/test/:label — connectie testen ────────────────────────────────
router.get('/test/:label', async (req, res) => {
  const label = decodeURIComponent(req.params.label);
  try {
    const rows = await db.query(label, 'SELECT 1 AS ok, GETDATE() AS serverTime');
    res.json({ ok: true, label, serverTime: rows[0]?.serverTime });
  } catch (err) {
    res.json({ ok: false, label, error: err.message });
  }
});

// ── GET /api/db/:label/buildings — gebouwen of tenants ophalen ────────────────
router.get('/:label/buildings', async (req, res) => {
  const label = decodeURIComponent(req.params.label);
  try {
    const cfg = db.loadConfig();
    const dbCfg = cfg.databases.find(d => d.label === label);
    if (!dbCfg) return res.json({ ok: false, error: `DB "${label}" niet gevonden` });

    // Delhaize → Buildings, Moonfish → Tenants, rest → Buildings
    const table = dbCfg.schema === 'moonfish' ? 'Tenants' : 'Buildings';
    const rows  = await db.query(label, `SELECT Id, Name FROM dbo.${table} ORDER BY Name`);
    res.json({ ok: true, buildings: rows });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /api/db/:label/metertypes — meter types ophalen ──────────────────────
router.get('/:label/metertypes', async (req, res) => {
  const label = decodeURIComponent(req.params.label);
  try {
    const rows = await db.query(
      label,
      'SELECT Id, Name, Tag FROM dbo.MeterTypes ORDER BY Tag'
    );
    res.json({ ok: true, meterTypes: rows });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /api/db/:label/datatypes ─────────────────────────────────────────────
router.get('/:label/datatypes', async (req, res) => {
  const label = decodeURIComponent(req.params.label);
  try {
    const rows = await db.query(
      label,
      'SELECT Id, Name, Quantity, MediumType, Category, Unit, ValueType, Scale, Description, TimeResolution FROM dbo.DataTypes ORDER BY Id'
    );
    res.json({ ok: true, dataTypes: rows });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});
// ── GET /api/db/:label/metertypelinks ────────────────────────────────────────
router.get('/:label/metertypelinks', async (req, res) => {
  const label = decodeURIComponent(req.params.label);
  try {
    const rows = await db.query(label,
      'SELECT DataTypesId, MeterTypesId FROM dbo.MeterTypeLinks'
    );
    res.json({ ok: true, meterTypeLinks: rows });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;

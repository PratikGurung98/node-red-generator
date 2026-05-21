'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { generateFlow } = require('./generator');
const dbRoutes         = require('./db/routes');
const { buildSQL, buildEnerseeSQL } = require('./db/schemas');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB routes ─────────────────────────────────────────────────────────────────
app.use('/api/db', dbRoutes);

// ── List available templates ──────────────────────────────────────────────────
app.get('/api/templates', (_req, res) => {
  const VALID_EXT = ['.json', '.js', ''];
  const read = (dir) =>
    fs.readdirSync(path.join(__dirname, 'lib', dir))
      .filter(f => VALID_EXT.includes(path.extname(f)))
      .map(f => {
        const name = path.basename(f, path.extname(f));
        // Lees outputs count uit de JSON
        let outputs = 1;
        try {
          const ext  = path.extname(f);
          const full = path.join(__dirname, 'lib', dir, f);
          const nodes = ext === '.js' ? require(full) : JSON.parse(fs.readFileSync(full, 'utf8'));
          const fn = Array.isArray(nodes) ? nodes.find(n => n.type === 'function') : null;
          if (fn?.outputs) outputs = fn.outputs;
        } catch (_) {}
        return { name, outputs };
      });

  res.json({
    lorawan: read('lorawan'),
    modbus:  read('modbus'),
  });
});

// ── Generate flow + SQL ───────────────────────────────────────────────────────
app.post('/api/generate', (req, res) => {
  try {
    const flow = generateFlow(req.body);

    // SQL genereren als er een DB + building geselecteerd is
    let sql = null;
    let enerseeSQL = null;
    if (req.body.selectedDb && req.body.buildingId) {
      const params = {
        gatewayAssetId: req.body.gatewayAssetId,
        buildingId:     req.body.buildingId,
        devices:        req.body.devices,
      };
      sql        = buildSQL(req.body.selectedDb, params);
      enerseeSQL = buildEnerseeSQL(req.body.selectedDb, params);
    }

    res.json({ ok: true, flow, sql, enerseeSQL });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  Vlegelbox Generator  →  http://localhost:${PORT}\n`);
});

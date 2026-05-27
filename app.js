'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { generateFlow }           = require('./generator');
const dbRoutes                   = require('./db/routes');
const { buildSQL, buildEnerseeSQL } = require('./db/schemas');
const { getIotHubs, provisionDevice } = require('./iothub');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB routes
app.use('/api/db', dbRoutes);

// List available templates
app.get('/api/templates', (_req, res) => {
  const VALID_EXT = ['.json', '.js', ''];
  const read = (dir) =>
    fs.readdirSync(path.join(__dirname, 'lib', dir))
      .filter(f => VALID_EXT.includes(path.extname(f)))
      .map(f => {
        const name = path.basename(f, path.extname(f));
        let outputs = 1;
        try {
          const ext  = path.extname(f);
          const full = path.join(__dirname, 'lib', dir, f);
          // Altijd als JSON lezen — .js bestanden zijn Node-RED flow JSON, geen Node.js modules
          const nodes = JSON.parse(fs.readFileSync(full, 'utf8'));
          // Zoek de formatter/decoder node: heeft 'ASSET' in func maar is GEEN catch/error/go2Next
          const fn = Array.isArray(nodes)
            ? (nodes.find(n => n.type === 'function'
                && n.func?.includes('ASSET')
                && !n.name?.toLowerCase().includes('catch')
                && !n.name?.toLowerCase().includes('error')
                && !n.name?.toLowerCase().includes('go2next')
                && !n.name?.toLowerCase().includes('parse')
              ) || nodes.find(n => n.type === 'function'))
            : null;
          if (fn?.outputs) outputs = fn.outputs;
        } catch (_) {}
        return { name, outputs };
      });

  res.json({ lorawan: read('lorawan'), modbus: read('modbus') });
});

// IoT Hub routes
app.get('/api/iothub/list', (_req, res) => {
  try {
    res.json({ ok: true, iothubs: getIotHubs().map(h => ({ label: h.label, hubName: h.hubName })) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/iothub/provision', async (req, res) => {
  const { hubLabel, deviceId } = req.body;
  if (!hubLabel || !deviceId) {
    return res.json({ ok: false, error: 'hubLabel en deviceId zijn verplicht' });
  }
  try {
    const result = await provisionDevice(hubLabel, deviceId);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.message === 'AZ_LOGIN_REQUIRED') {
      return res.json({ ok: false, error: 'AZ_LOGIN_REQUIRED' });
    }
    console.error(err);
    res.json({ ok: false, error: err.message });
  }
});

// Az login starten (opent browser)
app.post('/api/iothub/login', async (req, res) => {
  const { execFile } = require('child_process');
  execFile('az', ['login', '--output', 'json'], { shell: true }, (err, stdout, stderr) => {
    if (err) return res.json({ ok: false, error: stderr || err.message });
    try {
      const accounts = JSON.parse(stdout);
      res.json({ ok: true, accounts });
    } catch {
      res.json({ ok: true });
    }
  });
});

// Generate flow + SQL
app.post('/api/generate', (req, res) => {
  try {
    // Hostname ophalen uit config op basis van geselecteerde IoT Hub
    let iotHubHostname = null;
    if (req.body.iotHubLabel) {
      try {
        const { getIotHubs } = require('./iothub');
        const hub = getIotHubs().find(h => h.label === req.body.iotHubLabel);
        if (hub) iotHubHostname = hub.hubName + '.azure-devices.net';
      } catch (_) {}
    }
    const flow = generateFlow({ ...req.body, iotCredentials: req.body.iotCredentials || null, iotHubHostname });

    let sql = null;
    let enerseeSQL = null;
    if (req.body.selectedDb && req.body.buildingId) {
      const params = {
        gatewayAssetId:      req.body.gatewayAssetId,
        gatewayMeterAssetId: req.body.gatewayMeterAssetId,
        gatewayMeterNaam:    req.body.gatewayMeterNaam,
        buildingId:          req.body.buildingId,
        devices:             req.body.devices,
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
  console.log(`\nVlegelbox Generator  ->  http://localhost:${PORT}\n`);
});

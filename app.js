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

// ─── 1NCE helpers ────────────────────────────────────────────────────────────
const ONCE_API = 'https://api.1nce.com/management-api';
let onceTokenCache = null; // { token, expiresAt }

async function onceGetToken() {
  // Geef cached token terug als nog geldig (met 60s marge)
  if (onceTokenCache && Date.now() < onceTokenCache.expiresAt - 60_000) {
    return onceTokenCache.token;
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  if (!cfg.once) throw new Error('Geen 1NCE credentials gevonden in config.json');
  const basicAuth = Buffer.from(`${cfg.once.username}:${cfg.once.password}`).toString('base64');
  const r = await fetch(`${ONCE_API}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify({ grant_type: 'client_credentials' })
  });
  if (!r.ok) throw new Error(`1NCE auth mislukt: ${r.status} ${await r.text()}`);
  const data = await r.json();
  onceTokenCache = {
    token:     data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
  };
  return onceTokenCache.token;
}

async function onceFetchAllSims() {
  const token = await onceGetToken();
  let page = 1;
  const pageSize = 100;
  let all = [];
  while (true) {
    const r = await fetch(`${ONCE_API}/v1/sims?page=${page}&pageSize=100`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`1NCE SIM lijst mislukt: ${r.status}`);
    const data = await r.json();
    const sims = Array.isArray(data) ? data : (data.sims ?? data.data ?? []);
    all = all.concat(sims);
    // Stop als we minder dan een volle pagina terugkrijgen
    if (sims.length < pageSize) break;
    page++;
  }
  return all;
}
// ─────────────────────────────────────────────────────────────────────────────

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

// Asset Manager proxy (omzeilt CORS)
const AM_BASE = 'https://assetmanagerapi-eucvc5gscng2ajfh.westeurope-01.azurewebsites.net';

app.get('/api/assetmanager/search', async (req, res) => {
  try {
    const { search = '', page = 0, pageSize = 10 } = req.query;
    const url = `${AM_BASE}/Api/v2/Asset/GetAssets?search=${encodeURIComponent(search)}&page=${page}&pageSize=${pageSize}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/assetmanager/asset/:id', async (req, res) => {
  try {
    const url = `${AM_BASE}/Api/v2/Asset/GetAsset?id=${encodeURIComponent(req.params.id)}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/assetmanager/create', async (req, res) => {
  try {
    const url = `${AM_BASE}/Api/v2/Asset/CreateAsset`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/assetmanager/create-bulk', async (req, res) => {
  const { assets } = req.body;
  const results = [];
  for (const asset of assets) {
    try {
      const url = `${AM_BASE}/Api/v2/Asset/CreateAsset`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(asset)
      });
      const data = await r.json();
      results.push({ id: asset.id, ok: r.status === 200, data });
    } catch (err) {
      results.push({ id: asset.id, ok: false, error: err.message });
    }
  }
  res.json({ results });
});

app.get('/api/assetmanager/templates', (_req, res) => {
  try {
    const p = path.join(__dirname, 'asset-templates.json');
    if (!fs.existsSync(p)) return res.json({});
    res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Printer — raw TCP naar Digitus label printer
const net = require('net');
const PRINTER_HOST = '192.168.0.200';
const PRINTER_PORT = 9100;

const VLEGEL_LOGO = 'L04P0E00E3I0FFE01FC0FFE18,L06P0F00E7800IF07FF0FFE3C,L04CO0F01E7800IF0IF0FFE3C,L023O0701C7800E001F060E003C,J070206N0783C7800E001EI0E003C,J03C101CM0383C7800E003CI0E003C,J03F9003M038387800E0038I0E003C,J01FF8006L03C787800E0038I0E003C,J01FFC0018K01C707800FF838I0FF83C,K0IFI03K01C707800FF8781F8FF83C,K0IFEI0CJ01EF07800E00381F8E003C,K0JFC0018J0EE07800E00381F8E003C,K07JFI06J0FE07800E0038038E003C,K07JFEI0CI0FC07800E003C038E003C,K03KF8003I07C07800E001E038E003C,K03LFI06007C07800E001F078E003C,K01LFC004003807FF8FFE0IF8FFE3FFC,K01MF808003807FF8FFE07FF0FFE3FFC,L0MF81I03003FF8FFE01FC0FFE1FFC,L0MF02,L0LFE02,L07KFE04,L07KFC08,L03KF81I0IFE7FF80FE0C038601C03F80EI03F8007F0E00E,L03KF02I0IFE7FF83FF1E038601C0FFC0FI07FE01FFC701E,L01JFE04I0IFE7FF87FF1E038701C1FFE0FI0IF03FFC781C,L01JFC04J07807I0F821E038781C1E0F0F001E0F07C18383C,M0JFC08J07807I0F001E0387C1C3C070F001C07878003C38,M0JF81K07807001E001E0387E1C38078F003C038FI01C78,M0JF02K07807001E001E0387E1C38038F0038038FJ0E7,M07FFE04K07807FC1C001IF87F1C78038F003803CEJ0FF,M07FFC08K07807FC1C001IF8779C78038F003803CEJ07E,M03FF808K07807FC1C001IF873DC78038F003803CE07E07C,M03FF81L07807001C001E03871FC78038F003803CE07E03C,M01FF82L07807001C001E03871FC78038F0038038E01E038,M01FE84L07807001E001E03870FC38078F0038038F00E038,M01FC08L07807001E001E038707C38078F003C078F00E038,N0F85M07807I0F001E038703C3C0F0F003C078780E038,N0F03M07807I0F831E038703C1E1F0F001E0F07C1E038,N0702M07807FF87FF9E038701C1FFE0IF0FFE03FFE038,N06O07807FF83FF1E038700C0FFC0IF07FC01FFC038,X03807FF00FC0C038700403F00IF03FI07F0038,,,,,,,,,,,,,,,,,,,';

function buildZPL(assetId, label, copies = 1) {
  const url = `https://id.vlegel.technology/${assetId}`;
  const sticker = `^XA^PW454^LL225^LH0,0^LS0^FO20,10^BQN,2,5^FDHA,${url}^FS^FO210,20^GFA,2496,2496,32,,${VLEGEL_LOGO}^FS^FO230,115^FB210,3,0,L,0^A0N,28,28^FD${label}^FS^XZ`;
  return sticker.repeat(copies);
}

function printZPL(zpl) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.connect(PRINTER_PORT, PRINTER_HOST, () => {
      socket.write(zpl, 'utf8', () => {
        socket.destroy();
        resolve();
      });
    });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Printer timeout')); });
  });
}

app.post('/api/print', async (req, res) => {
  const { assetId, label, copies = 1 } = req.body;
  if (!assetId || !label) return res.status(400).json({ ok: false, error: 'assetId en label zijn verplicht' });
  try {
    const zpl = buildZPL(assetId, label, copies);
    await printZPL(zpl);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 1NCE routes ─────────────────────────────────────────────────────────────

// Zoek SIMs op gedeeltelijke ICCID  →  GET /api/once/sim?q=123456
app.get('/api/once/sim', async (req, res) => {
  const q = (req.query.q ?? '').trim();
  if (!q) return res.json({ ok: false, error: 'q parameter verplicht' });
  try {
    const sims = await onceFetchAllSims();
    const matches = sims
      .filter(s => (s.iccid ?? '').includes(q))
      .map(s => ({
        iccid:  s.iccid,
        label:  s.label ?? '',
        ip:     s.ip_address ?? s.ipAddress ?? '',
        status: s.status ?? ''
      }));
    res.json({ ok: true, sims: matches });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: err.message });
  }
});

// Zet label op een SIM  →  PUT /api/once/sim/:iccid/label
app.put('/api/once/sim/:iccid/label', async (req, res) => {
  const { iccid } = req.params;
  const { label }  = req.body;
  if (!label) return res.json({ ok: false, error: 'label verplicht' });
  try {
    const token = await onceGetToken();
    // 1NCE gebruikt POST /v1/sims met een array voor updates
    const r = await fetch(`${ONCE_API}/v1/sims`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify([{ iccid, label }])
    });
    if (!r.ok) throw new Error(`1NCE label update mislukt: ${r.status} ${await r.text()}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

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

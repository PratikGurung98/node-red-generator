'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const LIB       = path.join(__dirname, '..', 'lib');
const TEMPLATES = path.join(__dirname, '..', 'templates');

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function loadJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function loadLib(dir, name) {
  for (const ext of ['.json', '.js', '']) {
    const p = path.join(LIB, dir, name + ext);
    if (!fs.existsSync(p)) continue;
    if (ext === '.js') return require(p);           // module.exports = [...]
    return JSON.parse(fs.readFileSync(p, 'utf8'));  // raw JSON
  }
  throw new Error(`Template niet gevonden: ${dir}/${name}`);
}

/**
 * Deep-clone a set of nodes and remap all internal IDs.
 * Returns { nodes, idMap } where idMap[oldId] = newId.
 */
function remapIds(nodes) {
  const idMap = {};
  nodes.forEach(n => { if (n.id) idMap[n.id] = uid(); });

  const cloned = JSON.parse(JSON.stringify(nodes));

  cloned.forEach(n => {
    if (n.id)     n.id     = idMap[n.id]     ?? n.id;
    if (n.g)      n.g      = idMap[n.g]      ?? n.g;
    if (n.server) n.server = idMap[n.server] ?? n.server;
    if (n.tls)    n.tls    = idMap[n.tls]    ?? n.tls;
    if (n.broker) n.broker = idMap[n.broker] ?? n.broker;

    if (Array.isArray(n.wires)) {
      n.wires = n.wires.map(outputs =>
        outputs.map(id => idMap[id] ?? id)
      );
    }
    if (Array.isArray(n.links)) {
      n.links = n.links.map(id => idMap[id] ?? id);
    }
    if (Array.isArray(n.scope)) {
      n.scope = n.scope.map(id => idMap[id] ?? id);
    }
    if (Array.isArray(n.nodes)) {
      n.nodes = n.nodes.map(id => idMap[id] ?? id);
    }
  });

  return { nodes: cloned, idMap };
}

/** Replace {meetpunt naam} placeholder in node names. */
function replaceMeetpunt(nodes, naam) {
  nodes.forEach(n => {
    if (n.name)  n.name  = n.name.replace(/\{meetpunt naam\}/gi, naam);
    if (n.label) n.label = n.label.replace(/\{meetpunt naam\}/gi, naam);
  });
}

/** Replace const Dev = "..." inside a function node's func string. */
function replaceDev(funcStr, newDev) {
  return funcStr.replace(
    /const Dev\s*=\s*["'][^"']*["']/g,
    `const Dev = "${newDev}"`
  );
}

/**
 * Replace multiple Dev IDs in multi-output decoders.
 * Matches "36..." patterns (18-char Dev IDs) in order.
 */
function replaceMultiDev(funcStr, assetIds) {
  let idx = 0;
  return funcStr.replace(/"36[0-9x]{14,18}"/gi, () => {
    const id = assetIds[idx] !== undefined ? assetIds[idx] : assetIds[assetIds.length - 1];
    idx++;
    return `"${id}"`;
  });
}

// ── IoT Hub section ───────────────────────────────────────────────────────────

function buildIoTHub(boxName, tabId, gatewayAssetId, credentials) {
  const template = loadJSON(path.join(TEMPLATES, 'iothub.json'));
  const { nodes, idMap } = remapIds(template);

  nodes.forEach(n => {
    // Set tab reference (config nodes stay without z)
    if (n.type !== 'mqtt-broker' && n.type !== 'tls-config') {
      n.z = tabId;
    }

    // Patch MQTT broker: alle velden correct zetten
    if (n.type === 'mqtt-broker') {
      n.clientid = boxName;
      n.name     = boxName + ' Azure IoTHub';
      // Broker URL altijd overschrijven op basis van credentials hostname
      // (template heeft hardcoded Delhaize URL)
      if (credentials?.hostname) {
        n.broker = `ssl://${credentials.hostname}`;
      }
      // Credentials alleen zetten als beschikbaar
      // (Node-RED slaat deze op in credentials store, niet in flow JSON)
      if (credentials?.username) n.user     = credentials.username;
      if (credentials?.sas)      n.password = credentials.sas;
    }

    // Patch MQTT out: topic
    if (n.type === 'mqtt out') {
      n.topic = `devices/${boxName}/messages/events/`;
      n.name  = boxName + ' Azure IoTHub';
    }

    // Patch gateway asset ID in node-redSTART en DATABACKUP
    if (n.type === 'function' && n.func?.includes('GATEWAY_ASSET_ID')) {
      n.func = n.func.replace(/GATEWAY_ASSET_ID/g, gatewayAssetId || 'GATEWAY_ASSET_ID');
    }
  });

  // Find the link in node ID — decoders wire to this
  const linkInNode = nodes.find(n => n.type === 'link in');

  return { nodes, linkInId: linkInNode?.id };
}

// ── LoRaWAN section ───────────────────────────────────────────────────────────

function buildLoRaWAN(devices, tabId, linkInId) {
  const nodes = [];

  // LoRa Input (Milesight proprietary node — one per flow)
  const loraInputId = uid();
  const lowerToUpperId = uid();
  const switchId = uid();

  const checkPort100Id = uid();
  const draginoStateId = uid();
  const draginoDebugId = uid();

  nodes.push({
    id: loraInputId,
    type: 'LoRa Input',
    z: tabId,
    name: '',
    devEUI: '',
    extendedField: '',
    x: 120, y: 200,
    wires: [[lowerToUpperId, checkPort100Id]],  // naar switch én direct naar dragino debug
  });

  nodes.push({
    id: lowerToUpperId,
    type: 'function',
    z: tabId,
    name: 'lowerToUpper',
    func: `if (msg.deveui) {
    msg.deveui = String(msg.deveui).toUpperCase();
}
return msg;`,
    outputs: 1,
    noerr: 0,
    initialize: '', finalize: '', libs: [],
    x: 330, y: 200,
    wires: [[switchId]],
  });

  // Dragino port 100 debug — direct op LoRa Input, buiten switch
  nodes.push({
    id: checkPort100Id,
    type: 'switch',
    z: tabId,
    name: 'check port 100',
    property: 'fport',
    propertyType: 'msg',
    rules: [{ t: 'eq', v: '100', vt: 'str' }],
    checkall: 'true',
    repair: false,
    outputs: 1,
    x: 330, y: 320,
    wires: [[draginoStateId]],
  });

  nodes.push({
    id: draginoStateId,
    type: 'function',
    z: tabId,
    name: 'save device state dragino',
    func: `// Dragino Port 100 decoder + state tracker
function bytesToHex(bytes) { return bytes.map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase(); }
function toBytes(msg) {
    if (Array.isArray(msg.rawBytes)) return msg.rawBytes.slice();
    if (msg.payload && Array.isArray(msg.payload.rawBytes)) return msg.payload.rawBytes.slice();
    if (typeof msg.payload === 'string') { try { return Array.from(Buffer.from(msg.payload,'base64')); } catch(e){ return null; } }
    return null;
}
const bytes = toBytes(msg);
if (!bytes || !bytes.length) { node.warn('Geen bytes'); return null; }
const deveui = (msg.deveui || '').toLowerCase();
const fport = msg.fport ?? msg.fPort;
if (fport !== 100) return null;
const statusByte = bytes[0];
const original = bytes.slice(1);
const hex = bytesToHex(original);
const allState = global.get('dragino_config_state') || {};
const state = allState[deveui] || { deveui, lastSeen: null, lastStatus: null, history: [] };
state.lastSeen = new Date().toISOString();
state.lastStatus = statusByte === 0x01 ? 'SUCCESS' : 'FAIL_' + statusByte;
state.history.unshift({ time: state.lastSeen, status: state.lastStatus, rawHex: bytesToHex(bytes) });
state.history = state.history.slice(0, 50);
allState[deveui] = state;
global.set('dragino_config_state', allState);
msg.topic = 'draginoPort100';
msg.payload = { deveui, fport, status: state.lastStatus, rawHex: hex, state };
return msg;`,
    outputs: 1,
    noerr: 0,
    initialize: '', finalize: '', libs: [],
    x: 560, y: 320,
    wires: [[draginoDebugId]],
  });

  nodes.push({
    id: draginoDebugId,
    type: 'debug',
    z: tabId,
    name: 'dragino port 100',
    active: true,
    tosidebar: true,
    console: false,
    tostatus: false,
    complete: 'payload',
    targetType: 'msg',
    x: 780, y: 320,
    wires: [],
  });

  // Switch node — one rule per device
  nodes.push({
    id: switchId,
    type: 'switch',
    z: tabId,
    name: 'device select',
    property: 'deveui',
    propertyType: 'msg',
    rules: devices.map(d => ({
      t: 'eq',
      v: d.deveui.toUpperCase(),
      vt: 'str',
    })),
    checkall: 'false',
    repair: false,
    outputs: devices.length,
    x: 530, y: 160,
    wires: devices.map(() => []),  // filled in below
  });

  const switchNode = nodes[nodes.length - 1];

  // Één link out node op de Lora tab — alle decoders gaan hiernaar
  const loraLinkOutId = uid();

  // One decoder per device
  devices.forEach((device, idx) => {
    const libNodes = loadLib('lorawan', device.template);

    const { nodes: decoderNodes } = remapIds(libNodes);
    const entryId = decoderNodes[0].id;

    replaceMeetpunt(decoderNodes, device.naam || device.template);

    decoderNodes.forEach(n => {
      n.z = tabId;
      if (n.type === 'function' && n.func) {
        const ids = device.assetIds || [device.assetId];
        if (ids.length > 1) {
          n.func = replaceMultiDev(n.func, ids);
        } else {
          n.func = replaceDev(n.func, ids[0]);
        }
      }
      // Decoder output → link out node
      if (n.wires) {
        n.wires = n.wires.map(() => [loraLinkOutId]);
      }
      if (n.x !== undefined) {
        n.x += 400;
        n.y = 80 + idx * 120;
      }
    });

    switchNode.wires[idx] = [entryId];
    nodes.push(...decoderNodes);
  });

  // Link out node — rechts van de decoders, verticaal gecentreerd
  const loraLinkOutY = devices.length === 1 ? 80 : Math.round((80 + (devices.length - 1) * 120) / 2);
  nodes.push({
    id: loraLinkOutId,
    type: 'link out',
    z: tabId,
    name: 'LINK2IOTHUB',
    mode: 'link',
    links: [],
    x: 1260, y: loraLinkOutY,
    wires: [],
  });

  return { nodes, loraLinkOutId };
}

// ── Modbus section ────────────────────────────────────────────────────────────

/**
 * Build a complete modbus section for N devices.
 * Devices are chained: inject → device1 → device2 → ... (via go2Next output2)
 */
function buildModbus(devices, tabId, linkInId) {
  // Shared modbus-client (Waveshare, always the same IP)
  const clientId = uid();
  const sharedClient = {
    id: clientId,
    type: 'modbus-client',
    name: 'Waveshare',
    clienttype: 'tcp',
    bufferCommands: true,
    stateLogEnabled: false,
    queueLogEnabled: false,
    failureLogEnabled: true,
    tcpHost: '192.168.31.40',
    tcpPort: '502',
    tcpType: 'TCP-RTU-BUFFERED',
    serialPort: '/dev/ttyUSB',
    serialType: 'RTU-BUFFERED',
    serialBaudrate: '9600',
    serialDatabits: '8',
    serialStopbits: '1',
    serialParity: 'none',
    serialConnectionDelay: '100',
    serialAsciiResponseStartDelimiter: '0x3A',
    unit_id: 1,
    commandDelay: 1,
    clientTimeout: 5000,
    reconnectOnTimeout: true,
    reconnectTimeout: 5000,
    parallelUnitIdsAllowed: true,
    showWarnings: true,
    showLogs: true,
  };

  const allNodes  = [sharedClient];
  const groups    = [];

  devices.forEach((device, idx) => {
    const libNodes = loadLib('modbus', device.template);

    // Verwijder modbus-client én inject uit lib — wij beheren die zelf
    const filtered = libNodes.filter(n => n.type !== 'modbus-client' && n.type !== 'inject');
    const { nodes: remapped, idMap } = remapIds(filtered);
    replaceMeetpunt(remapped, device.naam || device.template);

    // Groep label expliciet zetten — vervang ook METERNAAM placeholder
    const groupNode = remapped.find(n => n.type === 'group');
    if (groupNode) {
      const naam = device.naam || device.template;
      // Vervang {meetpunt naam}, METERNAAM, of voeg naam toe als suffix
      let label = (groupNode.name || groupNode.label || device.template);
      label = label
        .replace(/\{meetpunt naam\}/gi, naam)
        .replace(/METERNAAM/g, naam);
      // Als er nog geen naam in zit, suffix toevoegen
      if (!label.includes(naam)) label = `${label} - ${naam}`;
      groupNode.name  = label;
      groupNode.label = label;
    }

    // Identify key nodes
    const getterNode  = remapped.find(n => n.type === 'modbus-getter');
    const go2NextNode = remapped.find(n => n.type === 'function' && n.name?.includes('go2Next'));
    const linkOutNode = remapped.find(n => n.type === 'link out');

    if (!getterNode) throw new Error(`Geen modbus-getter gevonden in template ${device.template}`);

    remapped.forEach(n => {
      n.z = tabId;
      if (n.type === 'modbus-getter') {
        n.server  = clientId;
        n.unitid  = String(device.slaveAddress);
        n.showStatusActivities = true;
        n.showErrors = true;
      }
      if (n.type === 'function' && n.func) {
        n.func = replaceDev(n.func, device.assetId);
      }
      if (n.type === 'link out') {
        n.links = [linkInId];
      }
      if (n.y !== undefined) n.y += idx * 280;
      if (n.x !== undefined && n.type === 'group') n.y += idx * 280; // groep mee verschuiven
    });

    groups.push({ modbusGetterId: getterNode.id, go2NextNode });
    allNodes.push(...remapped);

    // Eerste device: maak inject node aan BUITEN de groep
    if (idx === 0) {
      const injectId = uid();
      allNodes.push({
        id: injectId,
        type: 'inject',
        z: tabId,
        // geen g → buiten de groep
        name: '15min trigger',
        props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
        repeat: '900',
        crontab: '',
        once: true,
        onceDelay: '5',
        topic: '',
        payload: '',
        payloadType: 'date',
        x: groupNode ? groupNode.x - 20 : 60,
        y: groupNode ? groupNode.y + 180 : 180,
        wires: [[getterNode.id]],
      });
    } else {
      // Keten vorige go2Next output2 → deze getter
      const prev = groups[idx - 1];
      if (prev?.go2NextNode) {
        const wires = prev.go2NextNode.wires;
        if (wires.length > 1) wires[1] = [getterNode.id];
      }
    }
  });

  // Last device's go2Next output2 → empty (no next device)
  const last = groups[groups.length - 1];
  if (last?.go2NextNode) {
    const wires = last.go2NextNode.wires;
    if (wires.length > 1) wires[1] = [];
  }

  // Verzamel alle link out node IDs uit de modbus groepen
  const modbusLinkOutIds = allNodes
    .filter(n => n.type === 'link out')
    .map(n => n.id);

  return { nodes: allNodes, modbusLinkOutIds };
}

// ── Main entry point ──────────────────────────────────────────────────────────

function generateFlow({ boxName, gatewayAssetId, gatewayMeterAssetId, devices, iotCredentials, iotHubHostname }) {
  if (!boxName?.trim()) throw new Error('boxName is verplicht');
  if (!Array.isArray(devices) || devices.length === 0) throw new Error('Minimaal 1 device vereist');

  const flow = [];

  const loraDevices   = devices.filter(d => d.commType === 'lorawan');
  const modbusDevices = devices.filter(d => d.commType === 'modbus');

  const tabIoTHub = uid();
  const tabLora   = loraDevices.length   > 0 ? uid() : null;
  const tabModbus = modbusDevices.length > 0 ? uid() : null;

  // IoTHub tab LAATSTE zodat link in/out correct resolven in Node-RED
  if (tabLora)   flow.push({ id: tabLora,   type: 'tab', label: `${boxName} - Lora`,   disabled: false, info: '' });
  if (tabModbus) flow.push({ id: tabModbus, type: 'tab', label: `${boxName} - Modbus`, disabled: false, info: '' });
  flow.push({ id: tabIoTHub, type: 'tab', label: `${boxName} - IoTHub`, disabled: false, info: '' });

  // IoT Hub — nodes op IoTHub tab
  // Merge hostname into credentials if provided separately
  const credentials = iotCredentials
    ? { ...iotCredentials, hostname: iotCredentials.hostname || iotHubHostname }
    : (iotHubHostname ? { hostname: iotHubHostname } : null);
  const { nodes: iothubNodes, linkInId } = buildIoTHub(boxName, tabIoTHub, gatewayMeterAssetId || gatewayAssetId, credentials);
  flow.push(...iothubNodes);

  const allLinkOutIds = [];

  // LoRaWAN → eigen tab
  if (tabLora) {
    const { nodes: loraNodes, loraLinkOutId } = buildLoRaWAN(loraDevices, tabLora, linkInId);
    flow.push(...loraNodes);
    allLinkOutIds.push(loraLinkOutId);
  }

  // Modbus → eigen tab
  if (tabModbus) {
    const { nodes: modbusNodes, modbusLinkOutIds } = buildModbus(modbusDevices, tabModbus, linkInId);
    flow.push(...modbusNodes);
    allLinkOutIds.push(...modbusLinkOutIds);
  }

  // Verbind link in ↔ alle link outs bidirectioneel
  const linkInNode = flow.find(n => n.id === linkInId);
  if (linkInNode) linkInNode.links = allLinkOutIds;

  flow.forEach(n => {
    if (n.type === 'link out' && allLinkOutIds.includes(n.id)) {
      n.links = [linkInId];
    }
  });

  return flow;
}

module.exports = { generateFlow };

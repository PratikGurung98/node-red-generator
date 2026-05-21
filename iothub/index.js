'use strict';
const { execFile } = require('child_process');
const fs           = require('fs');
const path         = require('path');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
}

function getIotHubs() {
  const cfg = loadConfig();
  return cfg.iothubs || [];
}

function getIotHub(label) {
  const hub = getIotHubs().find(h => h.label === label);
  if (!hub) throw new Error(`IoT Hub "${label}" niet gevonden in config.json`);
  return hub;
}

// Voer az command uit - quote argumenten zodat spaties in device IDs werken
function az(args) {
  const { exec } = require('child_process');
  const quoted = args.map(a => '"' + String(a).replace(/"/g, '\\"') + '"').join(' ');
  const cmd = 'az ' + quoted;
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// Check of az CLI ingelogd is en juiste subscription actief is
async function ensureLogin(subscriptionId) {
  try {
    const out = await az(['account', 'show', '--output', 'json']);
    const account = JSON.parse(out);
    if (account.id !== subscriptionId) {
      await az(['account', 'set', '--subscription', subscriptionId]);
    }
    return { loggedIn: true };
  } catch (e) {
    return { loggedIn: false };
  }
}

// Device aanmaken (negeert fout als het al bestaat)
async function createDevice(hubName, deviceId) {
  try {
    const out = await az([
      'iot', 'hub', 'device-identity', 'create',
      '--hub-name', hubName,
      '--device-id', deviceId,
      '--output', 'json',
    ]);
    return JSON.parse(out);
  } catch (e) {
    if (e.message.includes('already exists') || e.message.includes('DeviceAlreadyExists')) {
      return { deviceId, alreadyExisted: true };
    }
    throw e;
  }
}

// SAS token genereren - 1 jaar (31536000 sec)
async function generateSasToken(hubName, deviceId) {
  const out = await az([
    'iot', 'hub', 'generate-sas-token',
    '--hub-name', hubName,
    '--device-id', deviceId,
    '--duration', '31536000',
    '--output', 'json',
  ]);
  const data = JSON.parse(out);
  return data.sas;
}

// Hoofdfunctie: login check + device aanmaken + token genereren
async function provisionDevice(hubLabel, deviceId) {
  // Azure IoT Hub device IDs mogen geen spaties bevatten
  if (/\s/.test(deviceId)) {
    throw new Error('Device ID mag geen spaties bevatten. Gebruik underscores of koppeltekens.');
  }
  // Alleen toegestane tekens: letters, cijfers, -, _, ., :
  if (!/^[a-zA-Z0-9\-_.:\[\]]+$/.test(deviceId)) {
    throw new Error('Device ID bevat ongeldige tekens. Gebruik alleen letters, cijfers, -, _, . of :');
  }

  const hub = getIotHub(hubLabel);

  const loginStatus = await ensureLogin(hub.subscriptionId);
  if (!loginStatus.loggedIn) {
    throw new Error('AZ_LOGIN_REQUIRED');
  }

  await createDevice(hub.hubName, deviceId);

  const sas = await generateSasToken(hub.hubName, deviceId);

  const hostname = `${hub.hubName}.azure-devices.net`;
  const username = `${hostname}/${deviceId}/?api-version=2021-04-12`;

  return { sas, username, hostname, deviceId, hubName: hub.hubName };
}

module.exports = { getIotHubs, provisionDevice };

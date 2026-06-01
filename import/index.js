'use strict';

const fs = require('fs');
const path = require('path');

const MAPPINGS_PATH = path.join(__dirname, '..', 'import-mappings.json');

function loadMappings() {
  if (!fs.existsSync(MAPPINGS_PATH)) {
    throw new Error('import-mappings.json niet gevonden. Zet dit bestand naast config.json.');
  }
  return JSON.parse(fs.readFileSync(MAPPINGS_PATH, 'utf8'));
}

/**
 * Strip versienummer van decoder naam uit import JSON
 * "E_630ML1_DRAG_LORA_V1" → "E_630ML1_DRAG_LORA"
 * "E_630ML4_DRAG_LORA_2DEVICES" → "E_630ML4_DRAG_LORA"
 */
function stripVersion(decoderNaam) {
  return decoderNaam
    .replace(/_V\d+$/i, '')
    .replace(/_\d+DEVICES$/i, '');
}

/**
 * Bepaal lib bestandsnaam op basis van mapping + aantal kanalen
 */
function resolveLib(mapping, aantalKanalen) {
  if (!mapping.multiKanaal) {
    return mapping.lib;
  }

  // LoRa ML4: kies lib op basis van kanaalcount
  if (mapping.libPerKanaal) {
    const lib = mapping.libPerKanaal[String(aantalKanalen)];
    if (!lib) {
      throw new Error(
        `Geen lib gevonden voor ${aantalKanalen} kanalen. ` +
        `Beschikbaar: ${Object.keys(mapping.libPerKanaal).join(', ')}`
      );
    }
    return lib;
  }

  // Modbus ML4: altijd zelfde lib, N aparte devices
  return mapping.lib;
}

/**
 * Verwerk één device uit de import JSON naar UI device formaat(en)
 * Geeft array terug (ML4 kan meerdere devices opleveren)
 */
function verwerkDevice(device, mappings) {
  const rawDecoder = device.decoder || '';

  // TeBepalen detectie
  const teBepalen = rawDecoder.startsWith('**TEBEPALEN');
  if (teBepalen) {
    const categorie = mappings.teBepalenCategories[rawDecoder] || null;
    return [{
      _teBepalen: true,
      _categorie: categorie,
      naam: device.naam || '',
      commType: null,
      template: null,
      assetId: '',
      assetIds: [],
      deveui: '',
      modbusAdres: '',
      meterTypeId: '',
      meterCategory: '',
      enerseeDataTypes: [],
      _ta: null,
      _fases: null
    }];
  }

  // Strip versienummer
  const decoderKey = stripVersion(rawDecoder);

  // Opzoeken in mappings
  const mapping = mappings.decoders[decoderKey];
  if (!mapping) {
    throw new Error(
      `Decoder "${decoderKey}" (uit "${rawDecoder}") niet gevonden in import-mappings.json. ` +
      `Voeg hem toe aan import-mappings.json om door te gaan.`
    );
  }

  const commType = mapping.type; // "lorawan" of "modbus"
  const kanalen = device.kanalen || null;
  const isMulti = mapping.multiKanaal && kanalen && kanalen.length > 0;

  // === LORAWAN MULTI-KANAAL (ML4 LoRa) ===
  // → 1 device met N assetIds, lib gekozen op basis van kanaalcount
  if (commType === 'lorawan' && isMulti) {
    const lib = resolveLib(mapping, kanalen.length);
    return [{
      _teBepalen: false,
      naam: kanalen.map(k => (typeof k === 'string' ? k : k.naam)).join(' / '),
      _kanaalNamen: kanalen.map(k => (typeof k === 'string' ? k : k.naam)),
      commType: 'lorawan',
      template: lib,
      assetId: '',
      assetIds: kanalen.map(() => ''), // jij vult in
      deveui: '',
      meterTypeId: '',
      meterCategory: '',
      enerseeDataTypes: [],
      _ta: null,
      _fases: null
    }];
  }

  // === MODBUS MULTI-KANAAL (ML4 Modbus) ===
  // → N aparte devices, elk eigen naam + modbus adres
  if (commType === 'modbus' && isMulti) {
    const lib = resolveLib(mapping, kanalen.length);
    return kanalen.map(kanaal => {
      const naam = typeof kanaal === 'string' ? kanaal : kanaal.naam;
      const ta = typeof kanaal === 'object' ? (kanaal.ta || null) : null;
      const fases = typeof kanaal === 'object' ? (kanaal.fases || null) : null;
      return {
        _teBepalen: false,
        naam,
        commType: 'modbus',
        template: lib,
        assetId: '',
        assetIds: [''],
        deveui: '',
        modbusAdres: '',
        meterTypeId: '',
        meterCategory: '',
        enerseeDataTypes: [],
        _ta: ta,
        _fases: fases
      };
    });
  }

  // === NORMAAL DEVICE (LoRa of Modbus, 1 kanaal) ===
  const lib = resolveLib(mapping, 1);
  return [{
    _teBepalen: false,
    naam: device.naam || '',
    commType,
    template: lib,
    assetId: '',
    assetIds: [''],
    deveui: '',
    modbusAdres: '',
    meterTypeId: '',
    meterCategory: '',
    enerseeDataTypes: [],
    _ta: null,
    _fases: null
  }];
}

/**
 * Hoofdfunctie — parse volledige import JSON
 * Geeft { boxNaam, devices } terug
 */
function parseImportJSON(importData) {
  const mappings = loadMappings();

  if (!importData.devices || !Array.isArray(importData.devices)) {
    throw new Error('Import JSON moet een "devices" array bevatten.');
  }

  const devices = [];
  const errors = [];

  for (const device of importData.devices) {
    try {
      const parsed = verwerkDevice(device, mappings);
      devices.push(...parsed);
    } catch (err) {
      errors.push(`Device "${device.decoder || device.naam}": ${err.message}`);
    }
  }

  return {
    boxNaam: importData.boxNaam || '',
    devices,
    errors // lege array = alles OK, anders warnings tonen in UI
  };
}

module.exports = { parseImportJSON, stripVersion };

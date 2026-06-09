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
      _ta: device.ta || null,
      _fases: device.fases || null
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
      _fases: null,
      // per-kanaal TA/Fases zodat de frontend elke asset-card juist kan vullen
      _taPerKanaal: kanalen.map(k => (typeof k === 'object' ? (k.ta || null) : null)),
      _fasesPerKanaal: kanalen.map(k => (typeof k === 'object' ? (k.fases || null) : null))
    }];
  }

  // === MODBUS MULTI-KANAAL (ML4 Modbus) ===
  // → N aparte devices, elk eigen naam + modbus adres
  // _ml4KanaalIndex: positie in de groep (0 = hoofdtoestel met ML4 meter, 1+ = enkel CT's)
  // _ml4TotaalKanalen: totaal aantal kanalen in de groep
  if (commType === 'modbus' && isMulti) {
    const lib = resolveLib(mapping, kanalen.length);
    const totaal = kanalen.length;
    return kanalen.map((kanaal, kIdx) => {
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
        _fases: fases,
        _ml4KanaalIndex: kIdx,        // 0 = eerste (heeft ML4 meter), 1+ = enkel CT klemmen
        _ml4TotaalKanalen: totaal,    // totaal kanalen in de ML4 groep
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
    _ta: device.ta || null,
    _fases: device.fases || null
  }];
}

/**
 * Hoofdfunctie — parse volledige import JSON
 * Geeft { boxNaam, devices } terug
 */
// ─────────────────────────────────────────────────────────────────────────────
// TEKST-PARSER (brontype: devops_text)
// Zet geplakte boomstructuur om naar hetzelfde { boxNaam, devices[] } formaat
// dat parseImportJSON gebruikt. Defensief: leunt op regel-PATRONEN, niet op
// exacte inspringing (copy-paste mangelt whitespace).
// ─────────────────────────────────────────────────────────────────────────────

// Decoder-regel: bv. E_630ML4_WAVE_TCP_V1, O_IAQ_AM103L_LORA_V1, W_DRY_EM300_LORA_V1
const DECODER_RE = /^[A-Z]+_[A-Z0-9_]+_(LORA|TCP|RTU)(_V\d+)?$/;

// Regels die nooit een device/kanaal zijn → overslaan
const SKIP_RE = /^(Basispakket|Standaard gateway|Waveshare|Doorvoer|Pulsteller|PULSCONVERSIE|Dragino RS485-LB|Modbus)/i;

// Haal de tekst uit de LAATSTE buitenste haakjes van een regel.
// "ESCT-TA10 ... (1 fase) (SWW 1)" → "SWW 1"
// "Pulsteller ... (Itron ... (2 draden) VL_ITRON_CYBLE_K1)" → hele binnenkant
function laatsteHaakjes(regel) {
  let depth = 0, start = -1, laatste = null;
  for (let i = 0; i < regel.length; i++) {
    if (regel[i] === '(') { if (depth === 0) start = i + 1; depth++; }
    else if (regel[i] === ')') { depth--; if (depth === 0 && start >= 0) laatste = regel.slice(start, i); }
  }
  return laatste ? laatste.trim() : null;
}

// Fases afleiden uit een TA-regel: "1 fase" → 1, "set van 3"/"3 fases" → 3
function fasesUit(regel) {
  if (/\b1\s*fase\b/i.test(regel)) return 1;
  if (/set van 3|3\s*fases?\b/i.test(regel)) return 3;
  const m = regel.match(/(\d+)\s*fase/i);
  return m ? parseInt(m[1], 10) : null;
}

// Is dit een TA/kanaal-regel? (ESCT-... of begint met TA-code)
function isKanaalRegel(regel) {
  return /^ESCT[-\s]|^TA\d|Split core CT|Rogowski/i.test(regel);
}

// Strip de TA-string tot vóór de laatste haakjes (= de naam eraf halen)
function taZonderNaam(regel) {
  const idx = regel.lastIndexOf('(');
  const ta = (idx > 0 ? regel.slice(0, idx) : regel).trim();
  return ta || null;
}

function parseDevopsText(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Geen tekst ontvangen om te parsen.');
  }

  // Splits in logische brokken. De config-tool levert soms newlines, soms
  // tabs, soms meerdere spaties tussen items (copy-paste mangelt dit).
  // Strategie: normaliseer naar 1 regel per "anker" door te splitsen op
  // de bekende start-tokens. We zetten een newline VOOR elk anker.
  let txt = raw
    .replace(/\r/g, '')
    .replace(/\t/g, '\n');               // tabs → newlines

  // Forceer een breuk vóór elk herkenbaar anker, ook als ze aan elkaar plakken
  txt = txt
    .replace(/(\[[^\]]+\])/g, '\n$1')                       // [Categorie] labels
    .replace(/(\*\*TEBEPALEN)/gi, '\n$1')                   // TE BEPALEN
    .replace(/\b([A-Z]+_[A-Z0-9_]+_(?:LORA|TCP|RTU)(?:_V\d+)?)\b/g, '\n$1\n') // decoders
    .replace(/(ESCT[-\s])/g, '\n$1')                        // TA-regels
    .replace(/(Basispakket|Standaard gateway|Waveshare|Doorvoer|Pulsteller|PULSCONVERSIE)/gi, '\n$1');

  // Meerdere spaties (3+) ook als breuk behandelen — vangt resterende gevallen
  txt = txt.replace(/ {3,}/g, '\n');

  const regels = txt.split('\n').map(r => r.trim()).filter(r => r.length > 0);
  if (regels.length === 0) throw new Error('Lege invoer.');

  // Boxnaam = alle regels vóór het eerste anker ([cat], decoder, TEBEPALEN,
  // skip-regel of TA-regel). Die plakken we weer aaneen tot één naam.
  const isAnker = (r) =>
    /^\[[^\]]+\]/.test(r) || DECODER_RE.test(r) || /^\*\*TEBEPALEN/i.test(r) || SKIP_RE.test(r) || isKanaalRegel(r);

  let startIdx = regels.length;
  const boxDelen = [regels[0]];
  for (let i = 1; i < regels.length; i++) {
    if (isAnker(regels[i])) { startIdx = i; break; }
    boxDelen.push(regels[i]);
  }
  let boxNaam = boxDelen.join(' ')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_\-]/g, '')   // az-veilig: enkel letters, cijfers, _ en -
    .replace(/_+/g, '_');

  const devices = [];
  let huidig = null; // device dat nu opgebouwd wordt

  const sluitAf = () => { if (huidig) { devices.push(huidig); huidig = null; } };

  for (let i = startIdx; i < regels.length; i++) {
    const regel = regels[i];

    // [Categorie]-label → context, overslaan (maar sluit huidig device niet af,
    // want decoder komt vlak erna)
    if (/^\[[^\]]+\]/.test(regel)) continue;

    // TE BEPALEN regel:
    //  - ná een decoder zonder naam → dit is het (onbekende) toestel ván die
    //    decoder; gebruik de haakjes-naam als device-naam.
    //  - zonder lopende decoder → echt TE BEPALEN device.
    if (/^\*\*TEBEPALEN/i.test(regel)) {
      const naam = laatsteHaakjes(regel) || '';
      if (huidig && !huidig.naam && (!huidig.kanalen || huidig.kanalen.length === 0)) {
        huidig.naam = naam;
        continue;
      }
      sluitAf();
      huidig = { decoder: regel.split(/\s+/)[0], naam, kanalen: [] };
      continue;
    }

    // Decoder-regel → nieuw device
    if (DECODER_RE.test(regel)) {
      sluitAf();
      huidig = { decoder: regel, naam: '', kanalen: [] };
      continue;
    }

    if (!huidig) continue; // nog geen device gestart → context-regel, overslaan

    // Kanaal-regel (TA)
    if (isKanaalRegel(regel)) {
      const naam = laatsteHaakjes(regel) || '';
      huidig.kanalen.push({ naam, ta: taZonderNaam(regel), fases: fasesUit(regel) });
      continue;
    }

    // Skip-regels (transport, puls, etc.)
    if (SKIP_RE.test(regel)) continue;

    // Toestel-regel met (naam) → device-naam, alleen als nog niet gezet
    const naam = laatsteHaakjes(regel);
    if (naam && !huidig.naam) huidig.naam = naam;
  }
  sluitAf();

  // Normaliseer: device met kanalen → kanalen-vorm; zonder → single met naam
  const out = devices.map(d => {
    if (d.kanalen && d.kanalen.length > 0) {
      // multi-kanaal (bv. ML4). Single kanaal? plat slaan naar naam+ta+fases
      if (d.kanalen.length === 1) {
        const k = d.kanalen[0];
        return { decoder: d.decoder, naam: k.naam || d.naam, ta: k.ta, fases: k.fases };
      }
      return { decoder: d.decoder, kanalen: d.kanalen };
    }
    return { decoder: d.decoder, naam: d.naam };
  });

  return { boxNaam, devices: out };
}

// Tekst → zelfde verwerking als JSON-import (hergebruikt verwerkDevice-keten)
function parseImportText(raw) {
  const tussenvorm = parseDevopsText(raw);
  return parseImportJSON(tussenvorm);
}

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

module.exports = { parseImportJSON, parseImportText, parseDevopsText, stripVersion };

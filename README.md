# AI Acceleration Labs — Node-RED Generator


---

## Wat is dit?

Een lokale web tool (`localhost:3000`) die twee dingen genereert voor het onboarden van een **Vlegelbox**:
1. **Node-RED flow JSON** — klaar om te importeren in Node-RED op de Milesight UG56 gateway
2. **SQL scripts** — voor het aanmaken van Gateway + Meters in de SQL database, inclusief Enersee configuratie

**Taal:** JavaScript — Node.js (Express) backend, vanilla JS frontend. Geen framework, geen build step.

**Starten:**
```cmd
cd C:\node-red-generator
npm install   (eerste keer)
npm start
```
→ `http://localhost:3000`

---

## Context: Wat zijn Vlegelboxen?

Vlegel Technology bouwt energie-monitoring boxen voor klanten (bv. Delhaize winkels). Elke box bevat:
- Een **Milesight UG56 gateway** (draait Node-RED)
- **LoRaWAN devices** (sensoren, meters via Dragino RS485-LB)
- **Modbus devices** (meters via Waveshare TCP-RTU bridge op `192.168.31.40:502`)

Data gaat via **Azure IoT Hub** (MQTT over SSL, SAS token authenticatie) naar een **SQL Server database**.

---

## Architectuur van de gegenereerde Node-RED flows

### Tab structuur (3 tabs per box)
```
{BoxNaam} - Lora      ← alle LoRaWAN devices
{BoxNaam} - Modbus    ← alle Modbus devices (geketend)
{BoxNaam} - IoTHub    ← LAATSTE tab (anders werken link in/out niet)
```

### LoRaWAN flow
```
LoRa Input (Milesight) → lowerToUpper → switch (DevEUI) → decoder(s) → link out → IoTHub
                       ↘ check port 100 → save device state dragino → debug
```

### Modbus flow
```
inject (1x, device 1) → [groep 1: Read → catch error → Parse → Conv → formatter → go2Next]
                                                                              ↓ out2
                         [groep 2: Read → ...] ← go2Next out2 van groep 1
```
- Eerste device: inject node BUITEN de groep, `once: true`, `repeat: 900` (15min)
- Volgende devices: geketend via `go2Next` output 2
- Elke groep: eigen `link out → IoTHub link in`

### IoTHub tab
```
link in → DATABACKUP (buffering 24u) → MQTT out (Azure IoTHub)
                                     ↘ split → delay 100ms → MQTT out (flush)
status node → mqtt status (detecteert disconnect → start buffering)
On Start → Set global MID
inject 60s → node-redSTART (heartbeat event bij deploy)
```

### Standaard output formaat (alle decoders)
```json
{
  "MID": 0,
  "D": [{
    "Dev": "360029042026131259",
    "TS": "2026-05-20T12:00:00.000Z",
    "ED": [],
    "MD": [{ "Id": 4600, "Val": 123.45 }]
  }]
}
```

---

## Project bestandsstructuur

```
node-red-generator/
├── app.js                      ← Express server + alle routes
├── package.json
├── config.json                 ← !! NOOIT VERVANGEN !! DB credentials
├── categories.json             ← !! NOOIT VERVANGEN !! Configureerbare lijsten
├── generator/
│   └── index.js                ← Node-RED flow generator (kern logica)
├── templates/
│   └── iothub.json             ← IoTHub flow template (DATABACKUP, MQTT, etc.)
├── db/
│   ├── connection.js           ← MSSQL connection pool manager
│   ├── routes.js               ← DB API endpoints
│   └── schemas/
│       ├── index.js            ← Schema router (kiest juiste adapter)
│       ├── delhaize.js         ← Delhaize SQL builder (+ Enersee)
│       └── moonfish.js         ← Moonfish SQL builder
├── lib/
│   ├── lorawan/                ← !! NOOIT VERVANGEN !! LoRaWAN decoder JSONs
│   │   ├── E_IEM3255_DRAG_LORA_V1.json
│   │   ├── O_IAQ_AM103L_LORA_V1.json
│   │   └── ...meer decoders...
│   └── modbus/                 ← !! NOOIT VERVANGEN !! Modbus groep JSONs
│       ├── E_630ML1_WAVE_TCP_V1.json
│       └── ...meer modbus...
└── public/
    └── index.html              ← Volledige frontend (single file)
```

### Bij updates: enkel deze vervangen
```
app.js
generator/index.js
templates/iothub.json
public/index.html
db/ (alle files)
```

### NOOIT vervangen
```
config.json          ← DB credentials
categories.json      ← eigen lijsten
lib/                 ← eigen decoders
```

---

## config.json structuur

```json
{
  "databases": [
    {
      "label": "Moonfish",
      "server": "...",
      "port": 1433,
      "database": "uns-database",
      "user": "...",
      "password": "...",
      "schema": "moonfish",
      "default": true
    },
    {
      "label": "Delhaize",
      "server": "delhaize-vlegel.database.windows.net",
      "port": 1433,
      "database": "delhaize-uns",
      "user": "...",
      "password": "...",
      "schema": "delhaize"
    }
  ]
}
```

Nieuwe DB toevoegen = nieuwe entry met `"schema": "moonfish"` (of `"delhaize"` indien afwijkende structuur).

---

## categories.json structuur

```json
{
  "api": [{ "label": "Warmtepomp", "value": "[WP]" }, ...],
  "delhaize": ["COOLING", "GRID", "HVAC", ...],
  "enerseeCategories": ["Heating", "Cooling", "Grid", ...],
  "enerseeNames": ["Elec_Offtake", "Cooling_Prod.", "Vent.", ...]
}
```

---

## lib/ decoder formaat

### LoRaWAN decoder (lib/lorawan/NAAM.json)
```json
[{
  "id": "placeholder_id",
  "type": "function",
  "name": "DECODER_NAAM - {meetpunt naam}",
  "func": "const Dev = \"PLACEHOLDER\"; ... return msg;",
  "outputs": 1,
  "wires": [[]]
}]
```
- `{meetpunt naam}` → vervangen door user input
- `PLACEHOLDER` → vervangen door asset ID
- `outputs: 2` of `outputs: 3` → multi-output decoder (meerdere asset IDs)

### Modbus groep (lib/modbus/NAAM.json)
Complete Node-RED groep met:
- `group` node (label bevat `METERNAAM` als placeholder)
- `modbus-getter` node
- `catch error` function
- Parser function
- `json` conv node
- Formatter function (`const Dev = "PLACEHOLDER"`)
- `error handling` function
- `go2Next || retry` function (3 outputs: retry, next, link out)
- `link out` node (LINK2IOTHUB)
- Comment nodes

**Belangrijk:** inject node staat BUITEN de groep in de lib, maar wordt door de generator genegeerd en opnieuw aangemaakt.

---

## DB Schema verschillen

| | Moonfish | Delhaize |
|---|---|---|
| Gebouwen tabel | `Tenants` | `Buildings` |
| Gateway FK kolom | `TenantId` | `BuildingId` |
| Meters extra | — | `IsVisible`, `OldMeterId` |
| MeterCategory | nullable | NOT NULL (gebruik `''` als leeg) |
| Na insert | — | OldMeterId = Id fix |
| Enersee | niet van toepassing | `EnerseeMetricNames` tabel |

### Enersee tabel (Delhaize)
```sql
EnerseeMetricNames: Id, MeterId, DataTypeId, Name, Category
```
Insert gebruikt subquery omdat MeterId pas bekend is na gateway aanmaken:
```sql
INSERT INTO dbo.EnerseeMetricNames (MeterId, DataTypeId, Name, Category)
SELECT m.Id, {dataTypeId}, '{name}', '{category}'
FROM dbo.Meters m WHERE m.Name = '{assetId_36xxx}';
```

---

## API endpoints

```
GET  /api/templates                     ← beschikbare decoders uit lib/
GET  /api/db/list                       ← DBs uit config.json (geen credentials)
GET  /api/db/test/:label                ← connectie testen
GET  /api/db/:label/buildings           ← gebouwen of tenants
GET  /api/db/:label/metertypes          ← meter types (Id, Name, Tag)
GET  /api/db/:label/datatypes           ← alle data types
GET  /api/db/:label/metertypelinks      ← koppeling MeterType ↔ DataType
GET  /api/db/categories                 ← categories.json serveren
POST /api/generate                      ← genereer flow + SQL
```

### POST /api/generate body
```json
{
  "boxName": "E05_04_2025_..._BOX1",
  "gatewayAssetId": "360029042026125000",
  "selectedDb": "Delhaize",
  "buildingId": "ABC123-GUID",
  "devices": [{
    "commType": "lorawan",
    "template": "E_IEM3255_DRAG_LORA_V1",
    "assetId": "360029042026131259",
    "assetIds": ["360029042026131259"],
    "deveui": "A840417D6C610D24",
    "naam": "Cooling PROD",
    "meterTypeId": "17",
    "meterCategory": "COOLING",
    "enerseeDataTypes": [{
      "dataTypeId": 4600,
      "name": "Elec_Offtake",
      "category": "Grid",
      "visible": true
    }]
  }]
}
```

---

## Generator logica (generator/index.js)

### ID generatie
- Alle Node-RED node IDs zijn random (`crypto.randomBytes(8).toString('hex')`)
- `remapIds(nodes)` → deep clone + remap van alle interne referenties (wires, links, nodes, scope, server, g)

### Placeholders
- `const Dev = "PLACEHOLDER"` → vervangen door `assetId`
- `GATEWAY_ASSET_ID` → vervangen door `gatewayAssetId` (in node-redSTART én DATABACKUP)
- `{meetpunt naam}` of `METERNAAM` → vervangen door `naam`
- `"36[0-9x]{14,18}"` regex → multi-output decoder Dev IDs in volgorde

### Link in/out koppeling
Na opbouwen van alle nodes:
```javascript
linkInNode.links = allLinkOutIds;          // link in kent alle link outs
linkOutNodes.forEach(n => n.links = [linkInId]);  // elke link out kent de link in
```

### Modbus chaining
```javascript
// Device 1: nieuwe inject node aanmaken (BUITEN groep)
// Device N: go2Next[out2] van device N-1 → getter van device N
groups[idx-1].go2NextNode.wires[1] = [getterNode.id];
```

---

## Bekende quirks & oplossingen

| Probleem | Oplossing |
|---|---|
| IoTHub tab moet LAATSTE zijn | Tab volgorde: Lora → Modbus → IoTHub |
| `status` node volgt MQTT node niet | `remapIds` remapt ook `scope` arrays |
| Inline `onchange` op radio buttons werkt niet betrouwbaar | `addEventListener` na `div.innerHTML` |
| `dispatchEvent` op hidden input triggert onchange niet | Direct functie aanroepen na `hidden.value = ...` |
| MeterCategory NOT NULL in Delhaize | Gebruik `''` (lege string) in plaats van `NULL` |
| SQL verdwijnt bij hergenereren | SQL staat in aparte `sql-output` div, state in `lastSQL` variabele |

---

## TODO / Volgende stappen

### V1 — Huidige tool (in productie)
- [x] Node-RED flow genereren (LoRaWAN + Modbus)
- [x] SQL genereren (Gateway + Meters + Enersee)
- [x] DB connectie (Moonfish + Delhaize)
- [x] Buildings/MeterTypes/DataTypes/MeterTypeLinks ophalen
- [x] Enersee configuratie per device
- [x] MeterCategory (API/Delhaize/Custom)
- [x] Sticker sheet — nog te bouwen maar besloten

### V2 Roadmap — prioriteit volgorde

**1. SQL execute met preview (hoog prio)**
- BEGIN TRAN → inserts uitvoeren → SELECT resultaat tonen in UI
- Gebruiker ziet preview → "✅ Commit" of "❌ Rollback"
- Enersee SQL: aparte download knop `{boxnaam}_enersee.sql`
  - Reden: Enersee mag pas worden uitgevoerd NADAT de box geplaatst is
  - Moonfish heeft geen Enersee

**2. Azure IoT Hub automatisering (hoog prio — spaart ~10 min/box)**
- Huidige manuele stappen die wegvallen:
  - Azure portal openen → juiste IoT Hub zoeken
  - Device aanmaken
  - CLI openen → juiste subscription instellen
  - `az iot hub generate-sas-token` commando invullen
  - Token kopiëren → in Node-RED plakken + username invullen
- Implementatie:
  - `config.json` uitbreiden met IoT Hub connection strings
  - Device aanmaken via Azure REST API (geen SDK nodig)
  - SAS token genereren via HMAC-SHA256 (pure Node.js crypto, geen CLI)
  - Token + username automatisch injecteren in gegenereerde flow
- Config toevoeging:
```json
"iothubs": [
  {
    "label": "Delhaize",
    "hostname": "DelhaizeIotHub.azure-devices.net",
    "connectionString": "HostName=...;SharedAccessKeyName=iothubowner;SharedAccessKey=..."
  }
]
```

**3. Standaard presets (medium prio)**
- `presets.json` config (NOOIT in zip, zelf beheren):
```json
{
  "presets": [
    {
      "name": "Standaard Delhaize 7-meter",
      "schema": "delhaize",
      "devices": [
        { "naam": "Elec_Offtake", "commType": "modbus", "decoder": "E_630ROG_WAVE_TCP_V1" },
        { "naam": "Cooling_Prod.1", "commType": "modbus", "decoder": "E_630ML1_WAVE_TCP_V1" },
        { "naam": "Environment", "commType": "lorawan", "decoder": "O_IAQ_AM103L_LORA_V1" }
      ]
    }
  ]
}
```
- Verschillende presets per DB/klant mogelijk
- Preset laden vult alle devices voor, gebruiker vult enkel nog asset IDs en DevEUIs in

**4. Barcode scanner integratie (medium prio)**
- Context: assemblage van bulk bestellingen
- Huidige pijn: DevEUI, AppKey, serienummer manueel overtypen
- Hardware advies: **Tera 2D USB** of **NETUM 2D USB** (€25-35)
  - Leest QR codes (Dragino: DevEUI + AppKey + SN in QR)
  - Leest 1D barcodes (Milesight SN onderaan)
  - Plug & play USB HID — werkt als keyboard, geen drivers
- Dragino labels: QR → DevEUI + AppKey + SN (nog 6-char AT wachtwoord manueel)
- Milesight labels: QR rechtsboven → EUI, 1D barcode → SN
- Implementatie: scan-knop naast DevEUI veld, auto-focus, scanner vuurt enter
- Workflow na implementatie:
```
Per device (~10 seconden):
1. Scan QR/barcode → DevEUI + SN automatisch ingevuld
2. Typ 6 chars AT wachtwoord (Dragino only)
3. Volgende device
```

**5. Sticker sheet generator (medium prio)**
- Na configureren: één klik → PDF met alle stickers voor die box
- Eén A4 in plaats van N individuele prints
- Inhoud per sticker: asset ID, device naam, type, QR code
- Voordeel: altijd correct want gegenereerd op moment van scannen

**6. QA validatie voor deploy (medium prio)**
- Checkt voor genereren:
  - Asset IDs uniek in DB?
  - DevEUI bestaat al in DB?
  - Slave adres al in gebruik op deze gateway?
  - Alle verplichte velden ingevuld?

**7. Node-RED remote deploy (low prio — eerder remote config dan tijdwinst)**
- Node-RED REST API: `POST http://{gateway-ip}:1880/flows`
- Probleem: gateways draaien op SIM + OpenVPN → connectie soms instabiel
- Nuttig voor remote config changes, niet zozeer voor eerste deploy

---

## Hardware context

### Device labels
| Device | QR code | 1D barcode | Bevat |
|---|---|---|---|
| Dragino RS485-LB | ✅ | — | DevEUI, AppKey, SN |
| Milesight AM3xx | ✅ klein | ✅ onderaan | QR: EUI, barcode: SN |

### Aanbevolen scanner
**Tera 2D USB** of **NETUM 2D USB** — €25-35, leest QR + 1D, plug & play

### Gateway connectiviteit
- Milesight UG56 draait op SIM kaart + OpenVPN
- Remote management (Node-RED API, Milesight platform) soms instabiel door slechte 4G verbinding
- Filosofie: **pre-configureer alles voor deployment** → op locatie enkel aanzetten

---

## Timing context

| Stap | Nu | Na optimalisatie |
|---|---|---|
| Asset manager | ~60 min | ~15 min (scanner + batch) |
| Node-RED config | ~45 min | ~5 min (tool) |
| DB inserts | ~15 min | ~2 min (SQL execute) |
| Azure IoT Hub | ~10 min | ~30 sec (automatisch) |
| Stickers | ~15 min | ~2 min (batch print) |
| **Totaal** | **~3 uur** | **~45 min** |


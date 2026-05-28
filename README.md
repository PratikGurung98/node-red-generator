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
├── config.json                 ← !! NOOIT VERVANGEN !! DB credentials + IoT Hub config
├── categories.json             ← !! NOOIT VERVANGEN !! Configureerbare lijsten
├── generator/
│   └── index.js                ← Node-RED flow generator (kern logica)
├── templates/
│   └── iothub.json             ← IoTHub flow template (DATABACKUP, MQTT, etc.)
├── iothub/
│   └── index.js                ← Azure IoT Hub automatisering (az CLI wrapper)
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
iothub/index.js
templates/iothub.json
public/index.html
db/ (alle files behalve schemas/index.js)
```

### NOOIT vervangen
```
config.json          ← DB credentials + IoT Hub config
categories.json      ← eigen lijsten
lib/                 ← eigen decoders
db/schemas/index.js  ← schema router
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
  ],
  "iothubs": [
    {
      "label": "Delhaize",
      "hubName": "DelhaizeIotHub",
      "subscriptionId": "be45c496-f9a2-400b-9fe0-8741406b006a"
    },
    {
      "label": "Moonfish",
      "hubName": "uns-mf-iotHub",
      "subscriptionId": "be45c496-f9a2-400b-9fe0-8741406b006a"
    },
    {
      "label": "Watergroep",
      "hubName": "WatergroepIotHub",
      "subscriptionId": "be45c496-f9a2-400b-9fe0-8741406b006a"
    }
  ]
}
```

Nieuwe DB toevoegen = nieuwe entry met `"schema": "moonfish"` (of `"delhaize"` indien afwijkende structuur).
Nieuwe IoT Hub toevoegen = nieuwe entry in `iothubs` array.

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
| MeterCategory | `''` (nooit NULL) | `''` (nooit NULL) |
| Gateway meter IsVisible | — | `0` |
| Na insert | — | OldMeterId = Id fix |
| Enersee | niet van toepassing | `EnerseeMetricNames` tabel |

### Gateway meter
Elke box krijgt een extra meter row voor de gateway zelf (heartbeat, buffering events, enz.):
- `Name` = Gateway Meter Asset ID (apart veld in UI)
- `MeterTypeId` = opgezocht via subquery op tag `GW_DRY_UG56_MLSGHT_V1` (werkt over alle DBs)
- `ReadableName` = Gateway Meter naam (apart veld in UI)
- Delhaize: `IsVisible = 0`, `MeterCategory = ''`
- Moonfish: geen `IsVisible`

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
GET  /api/iothub/list                   ← IoT Hubs uit config.json
POST /api/iothub/provision              ← device aanmaken + SAS token genereren
POST /api/iothub/login                  ← az login starten (opent browser)
POST /api/generate                      ← genereer flow + SQL
```

### POST /api/generate body
```json
{
  "boxName": "E05_04_2025_..._BOX1",
  "gatewayAssetId": "362025051912254662",
  "gatewayMeterAssetId": "360029042026125000",
  "gatewayMeterNaam": "Gateway UG56 BOX1",
  "selectedDb": "Delhaize",
  "buildingId": "ABC123-GUID",
  "iotHubLabel": "Delhaize",
  "iotCredentials": {
    "sas": "SharedAccessSignature sr=...",
    "username": "DelhaizeIotHub.azure-devices.net/BOXNAME/?api-version=2021-04-12",
    "hostname": "DelhaizeIotHub.azure-devices.net"
  },
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
- `remapIds(nodes)` → deep clone + remap van alle interne referenties: `wires`, `links`, `nodes`, `scope`, `server`, `tls`, `broker`, `g`

### Placeholders
- `const Dev = "PLACEHOLDER"` → vervangen door `assetId`
- `GATEWAY_ASSET_ID` → vervangen door `gatewayMeterAssetId` (in node-redSTART én DATABACKUP)
- `{meetpunt naam}` of `METERNAAM` → vervangen door `naam`
- `"36[0-9x]{14,18}"` regex → multi-output decoder Dev IDs in volgorde

### IoT Hub credentials in flow
- `mqtt-broker` node krijgt `user` + `password` + `broker` URL automatisch ingevuld
- `broker` URL = `ssl://{hubName}.azure-devices.net` op basis van geselecteerde IoT Hub
- **Let op:** Node-RED slaat credentials op in een aparte beveiligde store, niet in de flow JSON zelf → na import moet je in de MQTT broker node de Security tab openen en username + SAS token plakken (copy knoppen in de UI)

### Link in/out koppeling
```javascript
linkInNode.links = allLinkOutIds;
linkOutNodes.forEach(n => n.links = [linkInId]);
```

### Modbus chaining
```javascript
// Device 1: nieuwe inject node aanmaken (BUITEN groep)
// Device N: go2Next[out2] van device N-1 → getter van device N
groups[idx-1].go2NextNode.wires[1] = [getterNode.id];
```

---

## IoT Hub automatisering (iothub/index.js)

Gebruikt Azure CLI (`az`) via `child_process.exec`. Vereist dat `az` geïnstalleerd en ingelogd is.

### Workflow
1. `ensureLogin(subscriptionId)` → checkt `az account show`, wisselt subscription indien nodig
2. `createDevice(hubName, deviceId)` → `az iot hub device-identity create` (negeert "already exists")
3. `generateSasToken(hubName, deviceId)` → `az iot hub generate-sas-token --duration 31536000`
4. Returns `{ sas, username, hostname, deviceId, hubName }`

### Username formaat
```
{hubName}.azure-devices.net/{deviceId}/?api-version=2021-04-12
```

### Az CLI quoting
Argumenten worden gequote via `exec` zodat spaties in device IDs (boxnamen) correct werken.

### Login flow
Als niet ingelogd → UI toont "Az Login" knop → `POST /api/iothub/login` → `az login` opent browser.

---

## Bekende quirks & oplossingen

| Probleem | Oplossing |
|---|---|
| IoTHub tab moet LAATSTE zijn | Tab volgorde: Lora → Modbus → IoTHub |
| `status` node volgt MQTT node niet | `remapIds` remapt ook `scope` arrays |
| `mqtt out` server leeg na import | `remapIds` remapt nu ook `n.broker` (was missing) |
| TLS config node gebroken na import | `remapIds` remapt nu ook `n.tls` (was missing) |
| Inline `onchange` op radio buttons werkt niet betrouwbaar | `addEventListener` na `div.innerHTML` |
| `dispatchEvent` op hidden input triggert onchange niet | Direct functie aanroepen na `hidden.value = ...` |
| MeterCategory nooit NULL (beide schemas) | Gebruik `''` (lege string) |
| SQL verdwijnt bij hergenereren | SQL staat in aparte `sql-output` div, state in `lastSQL` variabele |
| Spaties in boxnaam breken az CLI | `exec` met gequote args i.p.v. `execFile` |

---

## UI workflow (stap voor stap)

1. **Database** selecteren → bouwt verbinding, laadt buildings/metertypes/datatypes
2. **Locatie** selecteren (gebouw of tenant)
3. **Box naam** invullen (= Azure IoT Hub device ID)
4. **IoT Hub credentials** genereren:
   - IoT Hub wordt auto-geselecteerd op basis van DB keuze
   - Klik "Genereer Azure credentials" → device aangemaakt, SAS token gegenereerd
   - Username + token tonen met aparte Copy knoppen
   - Na import in Node-RED: MQTT broker → Security tab → username + password plakken
5. **Box configuratie**: Vlegelbox Asset ID + Gateway Meter Asset ID + Gateway Meter naam
6. **Devices** toevoegen (LoRaWAN of Modbus)
7. **Generate Node-RED Flow** → download JSON, importeer in Node-RED
8. **Generate SQL** → download `{boxnaam}_gateway.sql` en `{boxnaam}_enersee.sql`

---

## TODO / Volgende stappen

### Afgerond deze sessie
- [x] Gateway Meter Asset ID als apart veld (voor Node-RED flow + meter in DB)
- [x] Vlegelbox Asset ID label verduidelijkt (voor gateway table)
- [x] SQL: gateway meter row met MeterTypeId via tag `GW_DRY_UG56_MLSGHT_V1`
- [x] SQL: download knoppen voor gateway SQL en Enersee SQL
- [x] SQL: geen emojis in comments (MSSQL compatibel)
- [x] MeterCategory nooit NULL in beide schemas (altijd `''`)
- [x] Azure IoT Hub automatisering via az CLI (iothub/index.js)
- [x] UI volgorde logisch: boxnaam → credentials → config → devices
- [x] IoT Hub auto-selectie op basis van DB keuze
- [x] Copy knoppen per credential veld
- [x] remapIds fix: `n.tls` en `n.broker` worden nu correct geremapped
- [x] MQTT broker URL dynamisch op basis van geselecteerde IoT Hub

### V2 Roadmap — prioriteit volgorde

**1. SQL execute met preview (hoog prio)**
- BEGIN TRAN → inserts uitvoeren → SELECT resultaat tonen in UI
- Gebruiker ziet preview → "Commit" of "Rollback"
- Enersee SQL apart uitvoeren (na plaatsing box)

**2. Standaard presets (medium prio)**
- `presets.json` config (NOOIT in git, zelf beheren):
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

**3. Barcode scanner integratie (medium prio)**
- Hardware: **Tera 2D USB** of **NETUM 2D USB** (€25-35), plug & play
- Dragino QR → DevEUI + AppKey + SN
- Milesight QR → EUI, barcode → SN
- Scan-knop naast DevEUI veld, auto-focus, scanner vuurt enter

**4. Sticker sheet generator (medium prio)**
- Na configureren: één klik → PDF met alle stickers
- Per sticker: asset ID, device naam, type, QR code

**5. QA validatie voor deploy (medium prio)**
- Asset IDs uniek in DB?
- DevEUI bestaat al?
- Slave adres al in gebruik op deze gateway?

**6. Node-RED remote deploy (low prio)**
- Node-RED REST API: `POST http://{gateway-ip}:1880/flows`
- Probleem: SIM + OpenVPN soms instabiel

---

## Hardware context

### Device labels
| Device | QR code | 1D barcode | Bevat |
|---|---|---|---|
| Dragino RS485-LB | ja | — | DevEUI, AppKey, SN |
| Milesight AM3xx | ja (klein) | ja (onderaan) | QR: EUI, barcode: SN |

### Aanbevolen scanner
**Tera 2D USB** of **NETUM 2D USB** — €25-35, leest QR + 1D, plug & play

### Gateway connectiviteit
- Milesight UG56 draait op SIM kaart + OpenVPN
- Remote management soms instabiel door slechte 4G verbinding
- Filosofie: **pre-configureer alles voor deployment** → op locatie enkel aanzetten

### Azure IoT Hubs (subscription: Vlegel_PartnerCenter_Sponsership)
| Label | Hub naam | Hostname |
|---|---|---|
| Delhaize | DelhaizeIotHub | DelhaizeIotHub.azure-devices.net |
| Moonfish | uns-mf-iotHub | uns-mf-iotHub.azure-devices.net |
| Watergroep | WatergroepIotHub | WatergroepIotHub.azure-devices.net |

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

Sessie 21/05/2026 — toevoegingen:

SQL preview/execute flow (gateway + Enersee)
db/connection.js: previewSQL (altijd rollback) + executeSQL (commit)
db/routes.js: POST /api/db/:label/sql/preview + POST /api/db/:label/sql/execute
UI: Preview & Execute knop → tabel met resultaten → 30s countdown → Commit of Annuleer
Enersee: popup "box geplaatst?" voor preview start

Voeg dit toe onderaan de workfile:

Sessie 27/05/2026 — toevoegingen:

Multi-output naam fix: bij decoders met 2+ outputs krijgt elke asset ID een eigen naam veld in de UI
Modbus client deduplicatie: elke decoder brengt eigen client mee (Waveshare RTU vs PAS800 TCP), gededupliceerd op naam
PowerTag PAS800 TCP decoder toegevoegd aan lib/modbus
LoRaWAN generator herschreven: entry node slim bepaald (Adeunis: Base64 to Hex), enkel formatter krijgt link out wires, interne wires bewaard
Adeunis decoders gefixed: link out node toegevoegd, ASSET_ID_START_MET_36 → ASSET placeholder
Meetpunt naam: alle varianten vervangen ({meetpunt naam}, {meetpunt}, Meetpunt, meetpunt) + suffix als geen placeholder aanwezig
app.js fix: outputs detectie via formatter node ipv eerste function node
generator/index.js fix: .js lib bestanden worden als JSON gelezen ipv via require()
iothub template fix: node-redSTART → rechtstreeks naar DATABACKUP ipv via link in
remapIds fix: n.broker en n.tls worden nu ook geremapped
moonfish gateway meter MeterCategory: NULL → ''
SQL preview/execute: BEGIN TRAN → preview → commit of annuleer, 30s timeout
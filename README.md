# Node-RED Flow Generator

Onderdeel van **AI Acceleration Labs** — Project 1.

Genereert kant-en-klare Node-RED flow JSON bestanden op basis van device parameters. Geen configuratie, geen dependencies, gewoon `node generator.js` aanroepen en importeren.

## Vereisten

- Node.js ≥ 18
- Node-RED installatie (voor het importeren)

## Gebruik

```bash
# LoRaWAN device (DevEUI)
node generator.js --asset-id METER_001 --deveui A1B2C3D4E5F60001 --meter-type electricity

# Modbus device (adres 1-247)
node generator.js --asset-id METER_002 --modbus-address 1 --meter-type gas
```

### Parameters

| Parameter | Verplicht | Beschrijving |
|-----------|-----------|--------------|
| `--asset-id` | ✅ | Unieke ID voor de database (bv. `METER_001`) |
| `--deveui` | ✅ (of modbus) | DevEUI van het LoRaWAN device (16 hex chars) |
| `--modbus-address` | ✅ (of deveui) | Modbus slave adres (1-247) |
| `--meter-type` | ✅ | `electricity`, `gas`, `water`, `heat`, of `solar` |

### Ondersteunde metertypes

| Type | Kanalen | Poll interval |
|------|---------|---------------|
| `electricity` | kWh, W, V, A, power factor | 60s (Modbus) |
| `gas` | m³, m³/h | 300s (Modbus) |
| `water` | m³, L/h | 300s (Modbus) |
| `heat` | kWh, °C aanvoer, °C retour, kW | 60s (Modbus) |
| `solar` | kWh, W, V, A | 60s (Modbus) |

## Gegenereerde flows

Bestanden worden opgeslagen in `output/{asset-id}.json`.

### LoRaWAN flow structuur

```
[mqtt in] ──→ [decode payload] ──→ [normalize] ──→ [db write] ──→ [debug]
                                        │
                                        └──→ [alert check]
```

- **mqtt in**: luistert op `application/+/device/{deveui}/event/up` (ChirpStack formaat)
- **decode payload**: device-specifieke payload decoder (pas aan voor jouw codec)
- **normalize**: voegt metadata toe, valideert
- **db write**: TODO placeholder — vervang door jouw DB node
- **alert check**: TODO placeholder — voeg drempelwaarden toe

### Modbus flow structuur

```
[inject/poll] ──→ [modbus read] ──→ [schaal registers] ──→ [normalize] ──→ [db write] ──→ [debug]
                                                                │
                                                                └──→ [alert check]
```

- **inject**: poll trigger, instelbaar interval
- **modbus read**: leest holding/input registers (vereist `node-red-contrib-modbus`)
- **schaal registers**: converteert ruwe register waarden naar engineering units
- **normalize**: voegt metadata toe
- **db write**: TODO placeholder

## Na het importeren

1. **LoRaWAN**: stel de MQTT broker in en pas de payload decoder aan voor jouw device
2. **Modbus**: stel het IP adres in van je Modbus TCP gateway en controleer register adressen
3. Vervang de `DB write (TODO)` function node door jouw database connectie

## Via Claude Code

In het `ai-acceleration-labs` project kun je ook het `/generate-flow` skill gebruiken:

```
/generate-flow METER_001 A1B2C3D4E5F60001 electricity
/generate-flow METER_002 modbus:1 gas
```

// --- Node-RED Function node: Decode Dragino RS485-LB/LS uplink for Kamstrup MULTICAL 603 ---

let mid = global.get("mid") || 0;

// Zelfde device-idee als je huidige flow; pas aan indien nodig
const Dev = "360002032026090447";

// Zelfde datatype mapping als je huidige MULTICAL603 decoder
const idMapping = {
    flow_v1_actual: 9660,
    flow_v2_actual: 9661,

    temperature_t1: 9701,
    temperature_t2: 9702,
    temperature_t3: 9703,
    temperature_t4: 9704,

    heat_e1: 9600,
    heat_e2: 9603,

    volume_v1: 9650,
    volume_v2: 9651,

    battery: 7200
};

// Verwachte volgorde van de Dragino returns:
// RETURN1..RETURNA in dezelfde volgorde als je AT+COMMAND's
const fields = [
    "flow_v1_actual",
    "flow_v2_actual",
    "temperature_t1",
    "temperature_t2",
    "temperature_t3",
    "temperature_t4",
    "heat_e1",
    "heat_e2",
    "volume_v1",
    "volume_v2"
];

// Payload kan base64 string of Buffer zijn
let buf = (typeof msg.payload === "string")
    ? Buffer.from(msg.payload, "base64")
    : msg.payload;

if (!Buffer.isBuffer(buf)) {
    node.error("Payload is geen geldige Buffer/base64 string", msg);
    return null;
}

// Minstens: 2 bytes batterij + 1 byte payver + 10 * 4 bytes data
if (buf.length < 43) {
    node.error("Payload te klein voor Kamstrup Dragino decoder", msg);
    return null;
}

// --- Header ---
// Byte 0-1 = Battery + interrupt flag
// bit15 = interrupt flag, lower 15 bits = mV
const batteryRaw = buf.readUInt16BE(0);
const batteryMv = batteryRaw & 0x7FFF;
const batteryV = Number((batteryMv / 1000).toFixed(3));

// Byte 2 = PAYVER
const payver = buf.readUInt8(2);

// Optioneel controleren of PAYVER = 1
if (payver !== 1) {
    node.warn(`Onverwachte PAYVER ontvangen: ${payver}`);
}

// Helper: lees float32 BE
function readFloatBE(offset) {
    if (offset + 4 > buf.length) return null;

    const raw = buf.readUInt32BE(offset);

    // Kamstrup invalid float
    if (raw === 0x4F800000) {
        return null;
    }

    const val = buf.readFloatBE(offset);
    if (!Number.isFinite(val)) {
        return null;
    }

    return Number(val.toFixed(3));
}

// Decode floats
let decoded = {};
let offset = 3;

for (let i = 0; i < fields.length; i++) {
    decoded[fields[i]] = readFloatBE(offset);
    offset += 4;
}

// Bouw resultaatstructuur
let result = {
    MID: mid,
    D: [
        {
            Dev: Dev,
            TS: msg.time ? new Date(msg.time).toISOString() : new Date().toISOString(),
            ED: [],
            MD: []
        }
    ]
};

// Voeg meetwaarden toe
for (const [key, val] of Object.entries(decoded)) {
    if (val === null || val === undefined) continue;

    const id = idMapping[key];
    if (id === undefined) continue;

    result.D[0].MD.push({
        Id: id,
        Val: val
    });
}

// Voeg batterij toe
result.D[0].MD.push({
    Id: idMapping.battery,
    Val: batteryV
});

// Optioneel ook snr/rssi meenemen als aanwezig
if (msg.snr !== undefined) {
    result.D[0].MD.push({
        Id: 5400,
        Val: parseFloat(msg.snr)
    });
}

if (msg.rssi !== undefined) {
    result.D[0].MD.push({
        Id: 5500,
        Val: parseFloat(msg.rssi)
    });
}

if (msg.dr && msg.dr.spreadFactor !== undefined) {
    result.D[0].MD.push({
        Id: 5200,
        Val: parseFloat(msg.dr.spreadFactor)
    });
}

// Alleen MID verhogen als er minstens 1 meetwaarde is
if (result.D[0].MD.length > 0) {
    global.set("mid", mid + 1);
} else {
    node.warn("Geen geldige Kamstrup meetwaarden gevonden");
}

msg.payload = result;
return msg;
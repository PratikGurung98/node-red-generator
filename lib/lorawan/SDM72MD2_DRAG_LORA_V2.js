var mid = global.get("mid") || 0;

var Dev = "ASSET_ID";

// 1) Definitie van je kanalen en mapping
var channels = [
    { prop: "total_system_power_W", reg: 0x0034, id: 4200 },
    { prop: "total_system_var_VAr", reg: 0x003C, id: 4300 },
    { prop: "total_import_kWh", reg: 0x0048, id: 4600 },
    { prop: "total_export_kWh", reg: 0x004A, id: 4500 }
];

// De ID’s die je moet schalen door 1000
var scaleBy1000 = [4200, 4300];

// 2) Decode Base64-payload naar Buffer
var buf = (typeof msg.payload === "string")
    ? Buffer.from(msg.payload, "base64")
    : msg.payload;

if (!Buffer.isBuffer(buf) || buf.length < 7) {
    node.error("Invalid payload", msg);
    return null;
}

// 3) Lees header en bepaal offset
var HEADER_LEN = 3;
var dataLen = buf.length - HEADER_LEN;
var floatCount = Math.floor(dataLen / 4);

// 4) Helper om een Big-Endian float32 te lezen en afronden
function readF(off) {
    if (off + 4 > buf.length) { return null; }
    var v = buf.readFloatBE(off);
    if (isNaN(v)) { return null; }
    return Math.round(v * 100) / 100;
}

// 5) Decode battery (bytes 0–1) en alle float-slots
var measurements = {
    battery: (((buf[0] << 8) | buf[1]) & 0x7fff) / 1000
};

for (var i = 0; i < floatCount && i < channels.length; i++) {
    var off = HEADER_LEN + i * 4;
    measurements[channels[i].prop] = readF(off);
}

// 6) Bouw de standaardstructuur
var result = {
    MID: mid,
    D: [{
        Dev: Dev,
        TS: msg.time ? new Date(msg.time).toISOString() : undefined,
        ED: [],
        MD: []
    }]
};

// 7) Vul MD uit je kanaaltabel en het measurements-object
channels.forEach(function (ch) {
    var val = measurements[ch.prop];
    if (val != null) {
        if (scaleBy1000.indexOf(ch.id) !== -1) {
            val = Math.round((val / 1000) * 1000) / 1000;
        }

        result.D[0].MD.push({
            Id: ch.id,
            Val: val
        });
    }
});

// batterij
result.D[0].MD.push({
    Id: 7200,
    Val: measurements.battery
});

// 8) Optioneel: snr, rssi uit msg
[["snr", 5400], ["rssi", 5500]].forEach(function (item) {
    var key = item[0], id = item[1];
    if (msg[key] !== undefined) {
        result.D[0].MD.push({
            Id: id,
            Val: parseFloat(msg[key])
        });
    }
});

// spreadFactor uit msg.dr
if (msg.dr) {
    [["spreadFactor", 5200]].forEach(function (item) {
        var key = item[0], id = item[1];
        if (msg.dr[key] !== undefined) {
            result.D[0].MD.push({
                Id: id,
                Val: parseFloat(msg.dr[key])
            });
        }
    });
}

// 9) Increment MID en return
global.set("mid", mid + 1);
msg.payload = result;
return msg;
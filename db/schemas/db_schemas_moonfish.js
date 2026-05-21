'use strict';

function esc(v) {
  return String(v ?? '').replace(/'/g, "''").trim();
}

function sqlVal(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 'NULL';
  return `'${esc(v)}'`;
}

function buildSQL({ gatewayAssetId, gatewayMeterAssetId, gatewayMeterNaam, buildingId, devices }) {
  const gwName   = esc(gatewayAssetId);
  const tenantId = esc(buildingId);

  const rows = [];
  devices.forEach(device => {
    const ids = device.assetIds?.length ? device.assetIds : [device.assetId];
    ids.forEach((assetId, i) => {
      const naam   = ids.length > 1 ? `${device.naam || ''} ${i + 1}`.trim() : (device.naam || '');
      const catSql = device.meterCategory ? `'${esc(device.meterCategory)}'` : "''";
      rows.push({
        name:         esc(assetId),
        readableName: sqlVal(naam),
        meterTypeId:  device.meterTypeId || 'NULL',
        category:     catSql,
      });
    });
  });

  const valuesSql = rows.map(r =>
    `  ('${r.name}', ${r.readableName}, @GatewayDbId, ${r.meterTypeId}, NULL, 0, ${r.category})`
  ).join(',\n');

  const gwMeterName = esc(gatewayMeterAssetId || '');
  const gwMeterReadableName = sqlVal(gatewayMeterNaam || '');

  return `
-- ===== MOONFISH INSERT =======================================================

-- 1) Gateway aanmaken
INSERT INTO dbo.Gateways (Name, TenantId)
VALUES ('${gwName}', '${tenantId}');

-- 2) GatewayDbId ophalen
DECLARE @GatewayDbId INT;
SELECT @GatewayDbId = Id FROM dbo.Gateways WHERE Name = '${gwName}';

-- 3) Gateway meter aanmaken (UG56 events: heartbeat, buffering, enz.)
DECLARE @GwMeterTypeId INT;
SELECT @GwMeterTypeId = Id FROM dbo.MeterTypes WHERE Tag = 'GW_DRY_UG56_MLSGHT_V1';

INSERT INTO dbo.Meters
  (Name, ReadableName, GatewayId, MeterTypeId, ParentMeterId, RetentionDays, MeterCategory)
VALUES
  ('${gwMeterName}', ${gwMeterReadableName}, @GatewayDbId, @GwMeterTypeId, NULL, 0, NULL);

-- 4) Meters aanmaken
INSERT INTO dbo.Meters
  (Name, ReadableName, GatewayId, MeterTypeId, ParentMeterId, RetentionDays, MeterCategory)
VALUES
${valuesSql};

-- 5) Verificatie
SELECT Id, Name, ReadableName, MeterTypeId, MeterCategory
FROM dbo.Meters
WHERE GatewayId = @GatewayDbId;
`.trim();
}

module.exports = { buildSQL };

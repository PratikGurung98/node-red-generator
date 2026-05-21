'use strict';

function esc(v) {
  return String(v ?? '').replace(/'/g, "''").trim();
}

function sqlVal(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 'NULL';
  return `'${esc(v)}'`;
}

function buildSQL({ gatewayAssetId, gatewayMeterAssetId, gatewayMeterNaam, buildingId, devices }) {
  const gwName = esc(gatewayAssetId);
  const bldId  = esc(buildingId);

  // Rows voor normale meters
  const rows = [];
  devices.forEach(device => {
    const ids  = device.assetIds?.length ? device.assetIds : [device.assetId];
    ids.forEach((assetId, i) => {
      const naam   = ids.length > 1 ? `${device.naam || ''} ${i + 1}`.trim() : (device.naam || '');
      const catSql = device.meterCategory ? `'${esc(device.meterCategory)}'` : `''`;
      rows.push({
        name:         esc(assetId),
        readableName: sqlVal(naam),
        meterTypeId:  device.meterTypeId || 'NULL',
        category:     catSql,
      });
    });
  });

  const valuesSql = rows.map(r =>
    `  ('${r.name}', ${r.readableName}, @GatewayDbId, ${r.meterTypeId}, NULL, 0, ${r.category}, 1)`
  ).join(',\n');

  const batchNames = rows.map(r => `  ('${r.name}')`).join(',\n');

  // Gateway meter rij (apart, metertype via subquery op tag)
  const gwMeterName = esc(gatewayMeterAssetId || '');
  const gwMeterReadableName = sqlVal(gatewayMeterNaam || '');

  return `
-- ===== DELHAIZE INSERT =======================================================

-- 1) Gateway aanmaken
INSERT INTO dbo.Gateways (Name, BuildingId)
VALUES ('${gwName}', '${bldId}');

-- 2) GatewayDbId ophalen
DECLARE @GatewayDbId INT;
SELECT @GatewayDbId = Id FROM dbo.Gateways WHERE Name = '${gwName}';

-- 3) Gateway meter aanmaken (UG56 events: heartbeat, buffering, enz.)
DECLARE @GwMeterTypeId INT;
SELECT @GwMeterTypeId = Id FROM dbo.MeterTypes WHERE Tag = 'GW_DRY_UG56_MLSGHT_V1';

INSERT INTO dbo.Meters
  (Name, ReadableName, GatewayId, MeterTypeId, ParentMeterId, RetentionDays, MeterCategory, IsVisible)
VALUES
  ('${gwMeterName}', ${gwMeterReadableName}, @GatewayDbId, @GwMeterTypeId, NULL, 0, '', 0);

-- 4) Meters aanmaken
INSERT INTO dbo.Meters
  (Name, ReadableName, GatewayId, MeterTypeId, ParentMeterId, RetentionDays, MeterCategory, IsVisible)
VALUES
${valuesSql};

-- 5) OldMeterId fix (Delhaize-specifiek: alle meters inclusief gateway meter)
;WITH Batch(Name) AS (
  SELECT v.Name FROM (VALUES
  ('${gwMeterName}'),
${batchNames}
  ) v(Name)
)
UPDATE m
SET m.OldMeterId = m.Id
FROM dbo.Meters m
JOIN Batch b ON b.Name = m.Name
WHERE m.GatewayId = @GatewayDbId
  AND (m.OldMeterId IS NULL OR m.OldMeterId = 0);

-- 6) Verificatie
SELECT Id, Name, ReadableName, MeterTypeId, MeterCategory, IsVisible
FROM dbo.Meters
WHERE GatewayId = @GatewayDbId;
`.trim();
}

function buildEnerseeSQL({ devices }) {
  const lines = [];

  devices.forEach(device => {
    const ids = device.assetIds?.length ? device.assetIds : [device.assetId];
    ids.forEach((assetId, i) => {
      const naam      = ids.length > 1 ? `${device.naam || ''} ${i + 1}`.trim() : (device.naam || '');
      const visibleDts = (device.enerseeDataTypes || []).filter(dt => dt.visible && dt.name && dt.category);
      if (visibleDts.length === 0) return;

      lines.push(`-- Meter: ${assetId} (${naam})`);
      visibleDts.forEach(dt => {
        lines.push(
          `INSERT INTO dbo.EnerseeMetricNames (MeterId, DataTypeId, Name, Category)\n` +
          `SELECT m.Id, ${dt.dataTypeId}, '${esc(dt.name)}', '${esc(dt.category)}'\n` +
          `FROM dbo.Meters m WHERE m.Name = '${esc(assetId)}';`
        );
      });
      lines.push('');
    });
  });

  if (lines.length === 0) return null;

  return `-- ===== ENERSEE INSERTS (uitvoeren NA gateway aanmaken) =======================\n\n` + lines.join('\n');
}

module.exports = { buildSQL, buildEnerseeSQL };

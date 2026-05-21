'use strict';

/**
 * Moonfish SQL schema adapter (standaard structuur)
 * - Gateways: (Name, TenantId)
 * - Meters: (Name, ReadableName, GatewayId, MeterTypeId, ParentMeterId, RetentionDays, MeterCategory)
 * - Geen OldMeterId fix
 */

function esc(v) {
  return String(v ?? '').replace(/'/g, "''").trim();
}

function sqlVal(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 'NULL';
  return `'${esc(v)}'`;
}

function buildSQL({ gatewayAssetId, buildingId, devices }) {
  const gwName  = esc(gatewayAssetId);
  const tenantId = esc(buildingId);

  // ── Rows per meter ──────────────────────────────────────────────────────────
  const rows = [];
  devices.forEach(device => {
    const ids = device.assetIds?.length ? device.assetIds : [device.assetId];
    ids.forEach((assetId, i) => {
      const naam  = ids.length > 1 ? `${device.naam || ''} ${i + 1}`.trim() : (device.naam || '');
      const catSql = device.meterCategory ? `'${esc(device.meterCategory)}'` : 'NULL';
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

  return `
-- ══ MOONFISH INSERT ══════════════════════════════════════════════════════════

-- 1) Gateway aanmaken
INSERT INTO dbo.Gateways (Name, TenantId)
VALUES ('${gwName}', '${tenantId}');

-- 2) GatewayDbId ophalen
DECLARE @GatewayDbId INT;
SELECT @GatewayDbId = Id FROM dbo.Gateways WHERE Name = '${gwName}';

-- 3) Meters aanmaken
INSERT INTO dbo.Meters
  (Name, ReadableName, GatewayId, MeterTypeId, ParentMeterId, RetentionDays, MeterCategory)
VALUES
${valuesSql};

-- 4) Verificatie
SELECT Id, Name, ReadableName, MeterTypeId, MeterCategory
FROM dbo.Meters
WHERE GatewayId = @GatewayDbId;
`.trim();
}

module.exports = { buildSQL };

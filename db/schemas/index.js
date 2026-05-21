'use strict';
const path = require('path');
const { loadConfig } = require('../connection');

const SCHEMAS = {
  delhaize: require('./delhaize'),
  moonfish: require('./moonfish'),
  // Nieuwe DB toevoegen: zet schema: "moonfish" in config.json
  // of maak een nieuwe adapter hier
};

/**
 * Genereert SQL voor de opgegeven DB label.
 * Valt terug op moonfish als schema onbekend is.
 */
function buildSQL(dbLabel, params) {
  const cfg    = loadConfig();
  const dbCfg  = cfg.databases.find(d => d.label === dbLabel);
  const schema = dbCfg?.schema || 'moonfish';
  const adapter = SCHEMAS[schema] || SCHEMAS.moonfish;
  return adapter.buildSQL(params);
}

function buildEnerseeSQL(dbLabel, params) {
  const cfg    = loadConfig();
  const dbCfg  = cfg.databases.find(d => d.label === dbLabel);
  const schema = dbCfg?.schema || 'moonfish';
  // Enersee is Delhaize-specifiek
  if (schema !== 'delhaize') return null;
  return require('./delhaize').buildEnerseeSQL(params);
}

module.exports = { buildSQL, buildEnerseeSQL };

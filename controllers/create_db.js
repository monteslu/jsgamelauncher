import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import parseCfg from './parse_cfg.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const xmlFile = path.join(__dirname, './knulli_es_input.cfg');
const batoceraXmlFile = path.join(__dirname, './batocera_es_input.cfg');

const uniqueMap = {};

const delimiter = '____';

async function createDb() {
  const cfgList = await parseCfg(xmlFile);
  cfgList.forEach((cfg) => {
    cfg.name = ('' + cfg.name).trim();
    cfg.fromDB = 'knulli';
    uniqueMap[cfg.name + delimiter + cfg.guid] = cfg;
  });
  console.log('knulli controller count', cfgList.length);

  const batoceraCfgList = await parseCfg(batoceraXmlFile);
  let batoceraCount = 0;
  batoceraCfgList.forEach((cfg) => {
    cfg.name = ('' + cfg.name).trim();
    if (!uniqueMap[cfg.name + delimiter + cfg.guid]) {
      cfg.fromDB = 'batocera';
      uniqueMap[cfg.name + delimiter + cfg.guid] = cfg;
      batoceraCount++;
      cfgList.push(cfg);
      console.log('batocera', cfg.name, cfg.guid);
    }
  });
  console.log('batocera only controller count', batoceraCount);

  fs.writeFileSync(path.join(__dirname, './db.json'), JSON.stringify(cfgList));
  return cfgList;
}

createDb()
  .then(() => {
    console.log('db.json created');
  })
  .catch((err) => {
    console.error('error creating db.json', err);
  });

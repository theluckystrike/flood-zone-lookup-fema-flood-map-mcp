// Fixtures in test/fixtures/ were downloaded 2026-11-17 from the FEMA NFHL map service (hazards.fema.gov, layers 28, 3, 1, 22, 16
// and 0) and the Census geocoder. File names: fema-<layer>-<lon>,<lat>-d<distance>.json (coordinates to 5 decimals), census-<place>.json.
// Values read off those files: 1000 Ocean Dr, Miami Beach is AE with STATIC_BFE 8 ft NGVD29 on panel 12086C0319L (EFF_DATE
// 1252627200000 = 2009-09-11), City of Miami Beach CID 120651. 2328 Seawall Blvd, Galveston is AO with DEPTH 2 ft on 48167C0441G
// (2019-08-15). 1701 Wynkoop St, Denver is X "AREA OF MINIMAL FLOOD HAZARD"; the point intersects three panels and the right one is
// 0800460088H (DFIRM 080046, 2013-11-20), not 08005C0025K or 08001C0625H. 701 Bourbon St is X "AREA WITH REDUCED FLOOD RISK DUE TO
// LEVEE" on 22071C0229F. -105.01795,39.72895 is shaded X under LOMR 25-08-0172P effective 2026-05-20 (1779235200000). -105.0084,39.752 is
// AE with no static BFE; the BFE lines within 300 m are 5186 ft (11 m), 5183 ft (135 m) and 5187 ft (276 m). Toronto has no NFHL data.
// Nearby, Denver 1000 m: shaded X 295 m, AE floodway 420 m, AE 635 m, AH 650 m (BFE 5187). Galveston 300 m: AO at the point,
// VE 5 m (BFE 18, 19), shaded X 50 m, AE 110 m (BFE 10, 11). Distances computed independently in Python from the same fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  zoneKey, describeZone, explainZone, insuranceNote, msDate, insideRings, distanceToLines, femaUrl, resolveLocation,
  floodZoneLookup, floodZoneNearby, InputError, UpstreamError, UTM, FEMA,
} from '../dist/core.js';

const dir = new URL('./fixtures/', import.meta.url);
const fx = (n) => readFileSync(new URL(n, dir), 'utf8');
const CENSUS = {
  '1000 Ocean Dr, Miami Beach, FL 33139': 'miami', '2328 Seawall Blvd, Galveston, TX 77550': 'galveston',
  '1701 Wynkoop St, Denver, CO 80202': 'denver', '701 Bourbon St, New Orleans, LA 70116': 'nola', '123 Nowhere Rd, Faketown, ZZ 00000': 'nomatch',
};
const seen = [];
const f = async (u) => {
  seen.push(u);
  const url = new URL(u);
  if (url.hostname === 'geocoding.geo.census.gov') {
    const k = CENSUS[url.searchParams.get('address')];
    if (k) return fx(`census-${k}.json`);
    throw new Error(`HTTP 404 (no census fixture for ${u})`);
  }
  const m = /\/NFHL\/MapServer\/(\d+)\/query$/.exec(url.pathname);
  if (url.hostname === 'hazards.fema.gov' && m) {
    const [lon, lat] = url.searchParams.get('geometry').split(',').map(Number);
    const n = `fema-${m[1]}-${lon.toFixed(5)},${lat.toFixed(5)}-d${url.searchParams.get('distance') ?? 0}.json`;
    if (existsSync(new URL(n, dir))) return fx(n);
  }
  throw new Error(`HTTP 404 (no fixture for ${u})`);
};
const NOW = new Date('2026-11-17T12:00:00Z');

test('zone codes, subtypes and insurance notes', () => {
  assert.equal(zoneKey('AE'), 'AE'); assert.equal(zoneKey('A12'), 'AE'); assert.equal(zoneKey('V7'), 'VE'); assert.equal(zoneKey('zone ao'), 'AO');
  assert.equal(zoneKey('X', 'AREA OF MINIMAL FLOOD HAZARD'), 'X'); assert.equal(zoneKey('X', '0.2 PCT ANNUAL CHANCE FLOOD HAZARD'), 'X_SHADED');
  assert.equal(zoneKey('X', 'AREA WITH REDUCED FLOOD RISK DUE TO LEVEE'), 'X_SHADED'); assert.equal(zoneKey('X', null), 'X');
  assert.equal(zoneKey('B'), 'X_SHADED'); assert.equal(zoneKey('C'), 'X'); assert.equal(zoneKey('shaded X'), 'X_SHADED'); assert.equal(zoneKey('A99'), 'A99');
  assert.equal(zoneKey('D'), 'D'); assert.equal(zoneKey('OPEN WATER'), 'OPEN WATER'); assert.equal(zoneKey('Q'), '');
  const fw = describeZone('AE', 'FLOODWAY', 'T');
  assert.equal(fw.sfha, true); assert.equal(fw.floodway, true); assert.equal(fw.risk, 'high'); assert.match(fw.meaning, /regulatory floodway/);
  assert.equal(describeZone('VE').risk, 'high_coastal'); assert.equal(describeZone('X', '0.2 PCT ANNUAL CHANCE FLOOD HAZARD').sfha, false);
  assert.equal(describeZone('D').risk, 'undetermined'); assert.throws(() => describeZone('Q'), UpstreamError);
  assert.match(insuranceNote('high'), /mandatory/); assert.match(insuranceNote('high'), /26% chance/); assert.match(insuranceNote('moderate'), /not federally required/);
  assert.equal(msDate(1252627200000), '2009-09-11'); assert.equal(msDate(null), null); assert.equal(msDate(-1), null);
});

test('explain: one zone and the full list', () => {
  const ve = explainZone({ zone: 'VE' }, NOW);
  assert.equal(ve.zone.risk, 'high_coastal'); assert.match(ve.summary, /^Zone VE: high coastal flood risk, inside the Special Flood Hazard Area/);
  const b = explainZone({ zone: 'b' }, NOW);
  assert.equal(b.zone.label, 'Zone X (shaded)'); assert.equal(b.zone.sfha, false);
  const all = explainZone({}, NOW);
  assert.equal(all.zones.length, 12); assert.ok(all.more.includes(UTM));
  assert.throws(() => explainZone({ zone: 'Q7' }, NOW), InputError);
});

test('geometry: point in polygon with a hole, distance to a line', () => {
  const sq = [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]], [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]]];
  assert.equal(insideRings(sq, 0.2, 0.2), true); assert.equal(insideRings(sq, 0.5, 0.5), false); assert.equal(insideRings(sq, 1.5, 0.5), false);
  // 0.001 degrees of latitude is 111.2 m
  assert.equal(Math.round(distanceToLines([[[-105, 39.751], [-104.99, 39.751]]], -104.995, 39.752)), 111);
});

test('URL shape and location parsing', async () => {
  const u = new URL(femaUrl(28, -90.065671, 29.95867, { fields: 'FLD_ZONE', distance: 300, where: "FLD_ZONE <> 'X'", geometry: true, offset: 0.0001, count: 200 }));
  assert.equal(u.origin + u.pathname, `${FEMA}/28/query`); assert.equal(u.searchParams.get('geometry'), '-90.065671,29.95867');
  assert.equal(u.searchParams.get('units'), 'esriSRUnit_Meter'); assert.equal(u.searchParams.get('outSR'), '4326'); assert.equal(u.searchParams.get('f'), 'json');
  const p = await resolveLocation(f, { address: '29.958670, -90.065671' });
  assert.deepEqual([p.latitude, p.longitude, p.matched_address], [29.95867, -90.065671, null]);
  const g = await resolveLocation(f, { address: '1701 Wynkoop St, Denver, CO 80202' });
  assert.deepEqual([g.latitude, g.longitude, g.matched_address, g.state], [39.752852, -104.999839, '1701 WYNKOOP ST, DENVER, CO, 80202', 'CO']);
  await assert.rejects(resolveLocation(f, { address: '123 Nowhere Rd, Faketown, ZZ 00000' }), InputError);
  await assert.rejects(resolveLocation(f, {}), InputError);
  await assert.rejects(resolveLocation(f, { latitude: 40 }), InputError);
  await assert.rejects(resolveLocation(f, { latitude: -40, longitude: 20 }), InputError);
});

test('lookup Miami Beach: AE, BFE 8 ft NGVD29, panel 12086C0319L, insurance required', async () => {
  const r = await floodZoneLookup(f, { address: '1000 Ocean Dr, Miami Beach, FL 33139' }, NOW);
  assert.equal(r.zone.code, 'AE'); assert.equal(r.zone.special_flood_hazard_area, true); assert.equal(r.zone.base_flood_elevation_ft, 8); assert.equal(r.zone.vertical_datum, 'NGVD29');
  assert.deepEqual(r.firm_panel, { panel: '12086C0319L', effective_date: '2009-09-11', panel_type: 'Countywide, Panel Printed', dfirm_id: '12086C' });
  assert.deepEqual(r.community, { name: 'City of Miami Beach', nfip_community_id: '120651' });
  assert.deepEqual(r.bfe_lines_nearby, []); assert.deepEqual(r.letters_of_map_revision, []);
  assert.match(r.summary, /^1000 OCEAN DR, MIAMI BEACH, FL, 33139 is in FEMA flood zone AE: high risk, inside the Special Flood Hazard Area \(1% annual chance flood\)\. Base flood elevation 8 ft \(NGVD29\)\. FIRM panel 12086C0319L effective 2009-09-11\./);
  assert.match(r.summary, /Flood insurance is required for a federally backed mortgage\.$/);
  assert.match(r.insurance, /mandatory purchase requirement/); assert.ok(r.official_map.startsWith('https://msc.fema.gov/portal/search?AddressQuery=1000%20OCEAN%20DR'));
  assert.ok(seen.every((u) => !u.includes('/MapServer/16/'))); // static BFE: no BFE-line query
});

test('lookup Galveston: AO with a 2 ft depth', async () => {
  const r = await floodZoneLookup(f, { address: '2328 Seawall Blvd, Galveston, TX 77550' }, NOW);
  assert.equal(r.zone.code, 'AO'); assert.equal(r.zone.flood_depth_ft, 2); assert.equal(r.zone.base_flood_elevation_ft, null);
  assert.equal(r.firm_panel.panel, '48167C0441G'); assert.equal(r.firm_panel.effective_date, '2019-08-15'); assert.equal(r.community.nfip_community_id, '485469');
  assert.match(r.summary, /Base flood depth 2 ft above ground\./);
});

test('lookup Denver: unshaded X, the panel of the zone\'s own DFIRM out of three', async () => {
  const r = await floodZoneLookup(f, { address: '1701 Wynkoop St, Denver, CO 80202' }, NOW);
  assert.equal(r.zone.code, 'X'); assert.equal(r.zone.label, 'Zone X (unshaded)'); assert.equal(r.zone.risk, 'minimal'); assert.equal(r.zone.special_flood_hazard_area, false);
  assert.equal(r.firm_panel.panel, '0800460088H'); assert.equal(r.firm_panel.effective_date, '2013-11-20');
  assert.deepEqual(r.community, { name: 'City and County of Denver', nfip_community_id: '080046' });
  assert.match(r.summary, /is in FEMA flood zone X \(unshaded\): minimal risk, outside the Special Flood Hazard Area\..*Flood insurance is optional/);
  assert.ok(r.notes.some((n) => /flood_zone_nearby/.test(n)));
});

test('lookup New Orleans: shaded X behind a levee', async () => {
  const r = await floodZoneLookup(f, { address: '701 Bourbon St, New Orleans, LA 70116' }, NOW);
  assert.equal(r.zone.label, 'Zone X (shaded)'); assert.equal(r.zone.risk, 'moderate'); assert.match(r.zone.meaning, /levee/);
  assert.equal(r.firm_panel.panel, '22071C0229F'); assert.equal(r.community.name, 'City of New Orleans and Orleans Parish');
});

test('lookup by coordinates: LOMR 25-08-0172P, and an AE polygon with BFE lines', async () => {
  const l = await floodZoneLookup(f, { latitude: 39.72895, longitude: -105.01795 }, NOW);
  assert.equal(l.zone.label, 'Zone X (shaded)'); assert.deepEqual(l.letters_of_map_revision, [{ case_no: '25-08-0172P', effective_date: '2026-05-20', status: 'Effective' }]);
  assert.equal(l.firm_panel.panel, '0800460182K'); assert.match(l.summary, /Revised by LOMR 25-08-0172P \(2026-05-20\)\./);
  const a = await floodZoneLookup(f, { latitude: 39.752, longitude: -105.0084 }, NOW);
  assert.equal(a.zone.code, 'AE'); assert.equal(a.zone.base_flood_elevation_ft, null); assert.equal(a.firm_panel.panel, '0800460069J');
  assert.deepEqual(a.bfe_lines_nearby.map((b) => [b.elevation_ft, b.distance_m]), [[5186, 11], [5183, 135], [5187, 276]]);
  assert.match(a.summary, /nearest BFE lines are 5186 ft at 11 m, 5183 ft at 135 m, 5187 ft at 276 m \(NAVD88\)/);
});

test('lookup outside FEMA maps: Toronto has no digital flood map', async () => {
  const r = await floodZoneLookup(f, { latitude: 43.65, longitude: -79.38 }, NOW);
  assert.equal(r.zone, null); assert.equal(r.digital_flood_map, false); assert.match(r.summary, /FEMA has no digital flood map/);
});

test('nearby Denver 1000 m: shaded X 295 m, AE floodway 420 m, AE 635 m, AH 650 m', async () => {
  const r = await floodZoneNearby(f, { address: '1701 Wynkoop St, Denver, CO 80202', radius_m: 1000 }, NOW);
  assert.deepEqual(r.zones.map((z) => [z.label, z.distance_m]), [['Zone X (shaded)', 295], ['Zone AE floodway', 420], ['Zone AE', 635], ['Zone AH', 650]]);
  assert.equal(r.nearest_high_risk.label, 'Zone AE floodway'); assert.equal(r.nearest_high_risk.distance_ft, 1378); assert.equal(r.at_point, null);
  assert.deepEqual(r.zones[3].base_flood_elevations_ft, [5187]);
  assert.match(r.summary, /^Nearest high-risk \(1% annual chance\) flood zone to 1701 WYNKOOP ST, DENVER, CO, 80202: Zone AE floodway 420 m \(1378 ft\) away\./);
});

test('nearby Galveston 300 m: inside AO, VE 5 m away', async () => {
  const r = await floodZoneNearby(f, { address: '2328 Seawall Blvd, Galveston, TX 77550', radius_m: 300 }, NOW);
  assert.equal(r.at_point.code, 'AO');
  assert.deepEqual(r.zones.map((z) => [z.code, z.distance_m]), [['AO', 0], ['VE', 5], ['X', 50], ['AE', 110]]);
  assert.deepEqual(r.zones[1].base_flood_elevations_ft, [18, 19]); assert.deepEqual(r.zones[3].base_flood_elevations_ft, [10, 11]);
  assert.match(r.summary, /is inside a high-risk flood zone \(Zone AO\)/);
  await assert.rejects(floodZoneNearby(f, { latitude: 39.75, longitude: -105, radius_m: 5000 }, NOW), InputError);
});

test('upstream errors: ArcGIS error JSON, HTML and a repeated 525', async () => {
  await assert.rejects(floodZoneLookup(async (u) => (u.includes('census') ? fx('census-denver.json') : '{"error":{"code":400,"message":"Failed to execute query.","details":[]}}'), { address: '1701 Wynkoop St, Denver, CO 80202' }, NOW), UpstreamError);
  await assert.rejects(floodZoneLookup(async () => '<html>', { latitude: 39.75, longitude: -105 }, NOW), UpstreamError);
  let n = 0;
  await assert.rejects(floodZoneLookup(async () => { n++; throw new Error('HTTP 525'); }, { latitude: 39.75, longitude: -105 }, NOW), UpstreamError);
  assert.ok(n >= 2);
  // one 525 then success on the zone layer is absorbed
  let first = true;
  const flaky = async (u) => { if (first && u.includes('/MapServer/28/')) { first = false; throw new Error('HTTP 525'); } return f(u); };
  const r = await floodZoneLookup(flaky, { address: '1000 Ocean Dr, Miami Beach, FL 33139' }, NOW);
  assert.equal(r.zone.code, 'AE');
});

test('stdio: initialize, tools/list with annotations and a tools/call error over JSON-RPC (offline)', async () => {
  const child = spawn(process.execPath, [new URL('../dist/stdio.js', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = []; let buf = '';
  const got = (id) => new Promise((res) => { const iv = setInterval(() => { const m = lines.find((l) => l.id === id); if (m) { clearInterval(iv); res(m); } }, 10); });
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal((await got(1)).result.serverInfo.name, 'flood-zone-lookup-fema-flood-map-mcp');
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  const tools = (await got(2)).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['flood_zone_lookup', 'flood_zone_nearby', 'flood_zone_explain']);
  for (const t of tools) { assert.ok(t.title); assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.destructiveHint, false); }
  send({ id: 3, method: 'tools/call', params: { name: 'flood_zone_explain', arguments: { zone: 'Q7' } } });
  const r3 = await got(3);
  send({ id: 4, method: 'tools/call', params: { name: 'flood_zone_explain', arguments: { zone: 'AE' } } });
  const r4 = await got(4);
  child.kill();
  assert.equal(r3.result?.isError ?? Boolean(r3.error), true);
  assert.match(r4.result.structuredContent.summary, /^Zone AE: high flood risk/);
});

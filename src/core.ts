// Pure core for flood-zone-lookup-fema-flood-map-mcp. The only I/O is keyless reads of the FEMA National Flood Hazard Layer
// (NFHL) ArcGIS map service and the U.S. Census Bureau one-line address geocoder, done through an injected fetchText.
//
// Sources (public, no key):
//   https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/{layer}/query   (ArcGIS REST, f=json)
//     layer 28 Flood Hazard Zones: FLD_ZONE (A, AE, AH, AO, AR, A99, V, VE, X, D, OPEN WATER), ZONE_SUBTY ("FLOODWAY",
//       "0.2 PCT ANNUAL CHANCE FLOOD HAZARD", "AREA OF MINIMAL FLOOD HAZARD", "AREA WITH REDUCED FLOOD RISK DUE TO LEVEE" ...),
//       SFHA_TF (T/F), STATIC_BFE and DEPTH (-9999 when not set), V_DATUM (NAVD88, NGVD29), LEN_UNIT, DFIRM_ID
//     layer 3 FIRM Panels: FIRM_PAN (e.g. 12086C0319L), EFF_DATE (epoch ms), PANEL_TYP, DFIRM_ID. Panel polygons of neighbouring
//       studies overlap, so the panel is chosen by the DFIRM_ID of the flood zone at the point (a White House point intersects
//       Fairfax and Arlington panels as well as the DC one).
//     layer 1 LOMRs (Letters of Map Revision): CASE_NO, EFF_DATE, STATUS
//     layer 22 Political Jurisdictions: POL_NAME1, CID (NFIP community id), DFIRM_ID
//     layer 16 Base Flood Elevations (lines): ELEV, LEN_UNIT, V_DATUM. Used when an A zone has no single static BFE.
//     layer 0 NFHL Availability: STUDY_ID. Used to say whether FEMA has a digital flood map at a point at all.
//   https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=...&benchmark=Public_AR_Current&format=json
//     result.addressMatches[0].coordinates {x: lon, y: lat}, matchedAddress
//
// hazards.fema.gov sometimes answers a Cloudflare Worker with HTTP 525 (about 1 in 12 requests on 2026-11-17). fetchText retries
// once; femaJson retries once more, so a request fails only when four attempts in a row fail.
import type { FetchText } from './types.js';

export const REPO = 'flood-zone-lookup-fema-flood-map-mcp';
export const SITE = 'https://www.mcpstamp.com';
export const UTM = `utm_source=mcp&utm_medium=${REPO}`;
export const more = () => `${SITE}/servers/?${UTM}`;
export const FEMA = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
export const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
export const LAYER = { availability: 0, lomr: 1, panels: 3, bfe: 16, jurisdictions: 22, zones: 28 } as const;
export const SOURCE =
  'FEMA National Flood Hazard Layer (hazards.fema.gov NFHL map service: flood hazard zones, FIRM panels, LOMRs, base flood elevations) ' +
  'and the U.S. Census Bureau geocoder for addresses, read at call time. The effective FIRM is the official map; this is not a flood zone ' +
  'determination for insurance or lending (that needs a Standard Flood Hazard Determination Form or an elevation certificate).';
const TTL = 86400;

export class InputError extends Error {}
export class UpstreamError extends Error {}

// ---------- zones ----------

export type Risk = 'high_coastal' | 'high' | 'undetermined' | 'moderate' | 'minimal' | 'open_water';
export interface ZoneDef { label: string; risk: Risk; sfha: boolean; meaning: string }

export const ZONES: Record<string, ZoneDef> = {
  A: { label: 'Zone A', risk: 'high', sfha: true,
    meaning: '1% annual chance (100-year) floodplain mapped by an approximate study. No base flood elevation (BFE) has been determined, so building rules rely on local estimates or an engineering study.' },
  AE: { label: 'Zone AE', risk: 'high', sfha: true,
    meaning: '1% annual chance (100-year) floodplain with base flood elevations from a detailed study. The lowest floor of new or substantially improved buildings must be at or above the BFE (often plus local freeboard). Older maps call it A1 to A30.' },
  AH: { label: 'Zone AH', risk: 'high', sfha: true,
    meaning: '1% annual chance shallow flooding, usually ponding, with average depths of 1 to 3 feet. Base flood elevations are determined.' },
  AO: { label: 'Zone AO', risk: 'high', sfha: true,
    meaning: '1% annual chance shallow flooding, usually sheet flow on sloping ground, with average depths of 1 to 3 feet. The map gives a flood depth above ground instead of a BFE.' },
  AR: { label: 'Zone AR', risk: 'high', sfha: true,
    meaning: 'Area that a flood control system such as a levee used to protect and that is being restored. It is treated as a 1% annual chance floodplain until the system is restored.' },
  A99: { label: 'Zone A99', risk: 'high', sfha: true,
    meaning: '1% annual chance floodplain that will be protected by a federal flood protection system still under construction. No BFE is set.' },
  V: { label: 'Zone V', risk: 'high_coastal', sfha: true,
    meaning: 'Coastal high hazard area: 1% annual chance coastal flooding with storm wave action (velocity), mapped by an approximate study without base flood elevations.' },
  VE: { label: 'Zone VE', risk: 'high_coastal', sfha: true,
    meaning: 'Coastal high hazard area: 1% annual chance coastal flooding with waves of 3 feet or more, with base flood elevations. Buildings must be elevated on open foundations (piles or columns) with the bottom of the lowest horizontal member at or above the BFE. Older maps call it V1 to V30.' },
  X_SHADED: { label: 'Zone X (shaded)', risk: 'moderate', sfha: false,
    meaning: 'Moderate flood hazard: the 0.2% annual chance (500-year) floodplain, 1% annual chance flooding with average depths under 1 foot or drainage areas under 1 square mile, or land protected from the 1% annual chance flood by a levee. Older maps call it Zone B.' },
  X: { label: 'Zone X (unshaded)', risk: 'minimal', sfha: false,
    meaning: 'Minimal flood hazard: outside the 0.2% annual chance (500-year) floodplain. Floods can still happen here, from heavy rain and poor drainage. Older maps call it Zone C.' },
  D: { label: 'Zone D', risk: 'undetermined', sfha: false,
    meaning: 'Possible but undetermined flood hazard: FEMA has not studied this area (or a levee here is not accredited and its risk is not yet mapped).' },
  'OPEN WATER': { label: 'Open water', risk: 'open_water', sfha: false,
    meaning: 'A river, lake, bay or ocean shown as open water on the flood map.' },
};

const RANK: Record<Risk, number> = { high_coastal: 6, high: 5, undetermined: 3, moderate: 2, minimal: 1, open_water: 0 };

/** Normalize a FEMA zone code and subtype to a ZONES key. */
export function zoneKey(code: string | null | undefined, subtype?: string | null): string {
  let c = String(code ?? '').trim().toUpperCase().replace(/^ZONE\s+/, '').replace(/[()]/g, '').replace(/\s+/g, ' ');
  const sub = String(subtype ?? '').toUpperCase();
  if (/^A([1-9]|[12]\d|30)$/.test(c)) return 'AE';
  if (/^V([1-9]|[12]\d|30)$/.test(c)) return 'VE';
  if (c === 'B' || c === 'X500' || c === '0.2 PCT' || c === 'SHADED X' || c === 'X SHADED' || c === 'SHADED') return 'X_SHADED';
  if (c === 'C' || c === 'UNSHADED X' || c === 'X UNSHADED' || c === 'UNSHADED') return 'X';
  if (c === 'OPEN WATER' || c === 'WATER' || c === 'OPEN_WATER') return 'OPEN WATER';
  if (c === 'X_SHADED') return 'X_SHADED';
  if (c === 'X') {
    if (/MINIMAL/.test(sub) || !sub.trim()) return 'X';
    if (/0\.2 ?PCT|1 PCT|LEVEE|REDUCED FLOOD/.test(sub)) return 'X_SHADED';
    return 'X';
  }
  if (c === 'AR' || /^A99$/.test(c) || ['A', 'AE', 'AH', 'AO', 'V', 'VE', 'D'].includes(c)) return c;
  if (/^AR\b/.test(c)) return 'AR';
  if (/^A/.test(c)) return 'A';
  if (/^V/.test(c)) return 'V';
  return '';
}

export function insuranceNote(risk: Risk): string {
  const tail = ' Since NFIP Risk Rating 2.0 (2021) the premium depends on the building\'s own flood risk, not only on the zone. A new NFIP policy usually takes effect after a 30-day wait.';
  switch (risk) {
    case 'high_coastal':
    case 'high':
      return 'High-risk Special Flood Hazard Area: flood insurance is mandatory for a mortgage from a federally regulated or insured lender (the NFIP mandatory purchase requirement). ' +
        'A 1% annual chance flood has about a 26% chance of happening at least once over a 30-year mortgage.' +
        (risk === 'high_coastal' ? ' Coastal V zones add storm wave action and stricter building rules, and usually carry the highest premiums.' : '') + tail;
    case 'moderate':
      return 'Moderate risk: flood insurance is not federally required, but a lender may still ask for it. The 0.2% annual chance (500-year) flood has about a 6% chance of happening at least once in 30 years.' + tail;
    case 'minimal':
      return 'Minimal risk: flood insurance is not federally required and is usually cheapest here, but it is available through the NFIP or private insurers, and minimal does not mean none.' + tail;
    case 'undetermined':
      return 'Undetermined risk: the flood hazard has not been studied. Flood insurance is available and not federally required, but rates reflect the unknown risk.' + tail;
    default:
      return 'Open water: no buildings are rated here; look up the address of the building itself.';
  }
}

export interface ZoneInfo {
  code: string; key: string; subtype: string | null; label: string; risk: Risk; sfha: boolean; floodway: boolean; meaning: string;
}

export function describeZone(code: string | null | undefined, subtype?: string | null, sfhaFlag?: string | null): ZoneInfo {
  const key = zoneKey(code, subtype);
  const def = ZONES[key];
  if (!def) throw new UpstreamError(`unknown FEMA zone code "${code}"`);
  const sub = subtype && subtype.trim() && subtype.trim() !== '<Null>' ? subtype.trim() : null;
  const floodway = /FLOODWAY/i.test(sub ?? '');
  let meaning = def.meaning;
  if (floodway) meaning += ' This is the regulatory floodway: the channel and nearby land that must stay free of obstructions so the base flood can pass. New building or fill there needs an engineering analysis showing no rise in flood levels.';
  if (key === 'X_SHADED' && sub && /LEVEE/i.test(sub)) meaning += ' Here the reason is a levee: if it fails or is overtopped the area floods.';
  const sfha = key === 'OPEN WATER' ? sfhaFlag === 'T' : def.sfha;
  return { code: String(code ?? '').trim().toUpperCase(), key, subtype: sub, label: def.label, risk: def.risk, sfha, floodway, meaning };
}

/** Static explanation of a zone code (or of every zone when code is empty). */
export function explainZone(a: { zone?: string; subtype?: string } = {}, now = new Date()) {
  const base = { as_of: now.toISOString().slice(0, 10), source: 'FEMA flood zone definitions (FEMA Flood Insurance Rate Map legend and NFIP rules).', more: more() };
  if (!a.zone || !String(a.zone).trim()) {
    const zones = Object.entries(ZONES).map(([k, d]) => ({ key: k, label: d.label, risk: d.risk, sfha: d.sfha, meaning: d.meaning }));
    return {
      summary: 'FEMA flood zones: high risk (Special Flood Hazard Area, 1% annual chance) A, AE, AH, AO, AR, A99 and coastal V, VE; moderate risk shaded X (0.2% annual chance, old Zone B); minimal risk unshaded X (old Zone C); D undetermined.',
      zones, ...base,
    };
  }
  const key = zoneKey(a.zone, a.subtype);
  if (!key) throw new InputError(`unknown flood zone "${a.zone}". Use one of A, AE, AH, AO, AR, A99, V, VE, X, shaded X (or B), unshaded X (or C), D.`);
  const code = key === 'X_SHADED' ? 'X' : key;
  const z = describeZone(code, key === 'X_SHADED' ? (a.subtype || '0.2 PCT ANNUAL CHANCE FLOOD HAZARD') : a.subtype ?? null);
  const insurance = insuranceNote(z.risk);
  return {
    summary: `${z.label}: ${z.risk.replace('_', ' ')} flood risk${z.sfha ? ', inside the Special Flood Hazard Area' : ', outside the Special Flood Hazard Area'}. ${z.meaning} ${insurance.split('. ')[0]}.`,
    zone: z, insurance, ...base,
  };
}

// ---------- geometry ----------

const R = 6371008.8;
function proj(lon: number, lat: number, lat0: number): [number, number] {
  const k = (Math.PI / 180) * R;
  return [lon * k * Math.cos((lat0 * Math.PI) / 180), lat * k];
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
/** Even-odd point in polygon over all rings (ArcGIS holes are separate rings). */
export function insideRings(rings: number[][][], lon: number, lat: number): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
/** Metres from a point to a set of lines (paths or polygon rings). */
export function distanceToLines(lines: number[][][], lon: number, lat: number): number {
  const [px, py] = proj(lon, lat, lat);
  let best = Infinity;
  for (const l of lines) {
    for (let i = 1; i < l.length; i++) {
      const [ax, ay] = proj(l[i - 1][0], l[i - 1][1], lat);
      const [bx, by] = proj(l[i][0], l[i][1], lat);
      best = Math.min(best, segDist(px, py, ax, ay, bx, by));
    }
    if (l.length === 1) { const [ax, ay] = proj(l[0][0], l[0][1], lat); best = Math.min(best, Math.hypot(px - ax, py - ay)); }
  }
  return best;
}
export function distanceToPolygon(rings: number[][][], lon: number, lat: number): number {
  return insideRings(rings, lon, lat) ? 0 : distanceToLines(rings, lon, lat);
}

// ---------- upstream ----------

export interface FemaOpts { fields: string; distance?: number; where?: string; geometry?: boolean; offset?: number; count?: number }
export function femaUrl(layer: number, lon: number, lat: number, o: FemaOpts): string {
  const p = new URLSearchParams();
  p.set('geometry', `${lon},${lat}`);
  p.set('geometryType', 'esriGeometryPoint');
  p.set('inSR', '4326');
  p.set('spatialRel', 'esriSpatialRelIntersects');
  if (o.distance) { p.set('distance', String(o.distance)); p.set('units', 'esriSRUnit_Meter'); }
  if (o.where) p.set('where', o.where);
  p.set('outFields', o.fields);
  p.set('returnGeometry', o.geometry ? 'true' : 'false');
  if (o.geometry) {
    p.set('outSR', '4326');
    p.set('geometryPrecision', '5');
    if (o.offset) p.set('maxAllowableOffset', String(o.offset));
  }
  if (o.count) p.set('resultRecordCount', String(o.count));
  p.set('f', 'json');
  return `${FEMA}/${layer}/query?${p.toString()}`;
}

export interface Feature { attributes: Record<string, any>; geometry?: { rings?: number[][][]; paths?: number[][][] } }
interface FemaResult { features: Feature[]; exceeded: boolean }

export async function femaJson(fetchText: FetchText, layer: number, lon: number, lat: number, o: FemaOpts): Promise<FemaResult> {
  const url = femaUrl(layer, lon, lat, o);
  let body = '';
  for (let attempt = 0; ; attempt++) {
    try {
      body = await fetchText(url, { cacheTtl: TTL, timeoutMs: 20000 });
      break;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= 1 || !/HTTP 5\d\d|no answer|fetch failed|network/i.test(msg)) throw new UpstreamError(`FEMA flood map service (layer ${layer}): ${msg}`);
    }
  }
  let d: any;
  try { d = JSON.parse(body); } catch { throw new UpstreamError(`FEMA flood map service (layer ${layer}) did not return JSON: ${body.slice(0, 80)}`); }
  if (d?.error) throw new UpstreamError(`FEMA flood map service (layer ${layer}): ${d.error.message ?? 'error'} ${(d.error.details ?? []).join(' ')}`.trim());
  if (!Array.isArray(d?.features)) throw new UpstreamError(`FEMA flood map service (layer ${layer}) returned no feature list`);
  return { features: d.features, exceeded: Boolean(d.exceededTransferLimit) };
}

export interface Location { input: string; latitude: number; longitude: number; matched_address: string | null; state: string | null; geocoder: string | null }

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export async function resolveLocation(fetchText: FetchText, a: { address?: string; latitude?: number; longitude?: number }): Promise<Location> {
  let lat = a.latitude, lon = a.longitude;
  const addr = typeof a.address === 'string' ? a.address.trim() : '';
  if ((lat === undefined) !== (lon === undefined)) throw new InputError('give both latitude and longitude, or an address.');
  if (lat === undefined && addr) {
    const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(addr);
    if (m) { lat = Number(m[1]); lon = Number(m[2]); }
  }
  if (lat !== undefined && lon !== undefined) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -15 || lat > 72 || lon < -180 || lon > 180) {
      throw new InputError(`latitude ${lat}, longitude ${lon} is outside the area FEMA maps (the 50 states, DC and the US territories). Give latitude first, then longitude (west is negative).`);
    }
    return { input: addr || `${lat},${lon}`, latitude: r6(lat), longitude: r6(lon), matched_address: null, state: null, geocoder: null };
  }
  if (!addr) throw new InputError('give a US street address (for example "701 Bourbon St, New Orleans, LA 70116") or latitude and longitude.');
  if (addr.length > 200) throw new InputError('the address is too long (200 characters at most).');
  const url = `${CENSUS}?address=${encodeURIComponent(addr)}&benchmark=Public_AR_Current&format=json`;
  let d: any;
  try { d = JSON.parse(await fetchText(url, { cacheTtl: TTL, timeoutMs: 20000 })); } catch (e) {
    if (e instanceof SyntaxError) throw new UpstreamError('the Census geocoder did not return JSON');
    throw new UpstreamError(`Census geocoder: ${(e as Error).message}`);
  }
  const matches = d?.result?.addressMatches;
  if (!Array.isArray(matches)) throw new UpstreamError(`Census geocoder: ${(d?.errors ?? ['unexpected answer']).join(' ')}`);
  if (!matches.length) {
    throw new InputError(`the Census geocoder found no match for "${addr}". Give a full street address with city and state or ZIP (a ZIP code or city alone is not enough, because flood zones change from one lot to the next), or latitude and longitude.`);
  }
  const m = matches[0];
  return {
    input: addr, latitude: r6(Number(m.coordinates.y)), longitude: r6(Number(m.coordinates.x)), matched_address: m.matchedAddress ?? null,
    state: m.addressComponents?.state ?? null, geocoder: 'U.S. Census Bureau geocoder (Public_AR_Current)',
  };
}

// ---------- helpers ----------

export function msDate(ms: unknown): string | null {
  const n = Number(ms);
  if (ms === null || ms === undefined || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString().slice(0, 10);
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > -9000 ? v : null);
const title = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bOf\b/g, 'of').replace(/\bAnd\b/g, 'and');
const where = (loc: Location) => loc.matched_address ?? `${loc.latitude}, ${loc.longitude}`;
export function officialMapUrl(loc: Location): string {
  return `https://msc.fema.gov/portal/search?AddressQuery=${encodeURIComponent(loc.matched_address ?? `${loc.latitude}, ${loc.longitude}`)}`;
}
const m2ft = (m: number) => Math.round(m * 3.28084);

interface PointZone extends ZoneInfo {
  base_flood_elevation_ft: number | null; vertical_datum: string | null; flood_depth_ft: number | null; dfirm_id: string | null; study_type: string | null;
}

function pointZone(a: Record<string, any>): PointZone {
  const z = describeZone(a.FLD_ZONE, a.ZONE_SUBTY, a.SFHA_TF);
  const unit = String(a.LEN_UNIT ?? '').toLowerCase();
  const toFt = (v: number | null) => (v === null ? null : unit.startsWith('met') ? Math.round(v * 3.28084 * 10) / 10 : v);
  return {
    ...z, base_flood_elevation_ft: toFt(num(a.STATIC_BFE)), vertical_datum: a.V_DATUM ? String(a.V_DATUM) : null,
    flood_depth_ft: toFt(num(a.DEPTH)), dfirm_id: a.DFIRM_ID ?? null, study_type: a.STUDY_TYP ?? null,
  };
}

// ---------- tools ----------

export async function floodZoneLookup(fetchText: FetchText, a: { address?: string; latitude?: number; longitude?: number }, now = new Date()) {
  const loc = await resolveLocation(fetchText, a);
  const { longitude: lon, latitude: lat } = loc;
  const notes: string[] = [];
  const soft = async <T>(label: string, p: Promise<T>): Promise<T | null> => {
    try { return await p; } catch (e) { notes.push(`${label} could not be read: ${(e as Error).message}`); return null; }
  };
  const [zonesR, panelsR, lomrR, juriR] = await Promise.all([
    femaJson(fetchText, LAYER.zones, lon, lat, { fields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DEPTH,V_DATUM,LEN_UNIT,DFIRM_ID,STUDY_TYP' }),
    soft('FIRM panel', femaJson(fetchText, LAYER.panels, lon, lat, { fields: 'FIRM_PAN,EFF_DATE,PANEL_TYP,DFIRM_ID' })),
    soft('Letters of Map Revision', femaJson(fetchText, LAYER.lomr, lon, lat, { fields: 'CASE_NO,EFF_DATE,STATUS,DFIRM_ID' })),
    soft('Community', femaJson(fetchText, LAYER.jurisdictions, lon, lat, { fields: 'POL_NAME1,CID,DFIRM_ID' })),
  ]);

  // distinct zones at the point, riskiest first
  const seen = new Set<string>();
  const zones: PointZone[] = [];
  for (const f of zonesR.features) {
    let z: PointZone;
    try { z = pointZone(f.attributes); } catch (e) { notes.push((e as Error).message); continue; }
    const k = `${z.code}|${z.subtype}|${z.base_flood_elevation_ft}|${z.flood_depth_ft}`;
    if (seen.has(k)) continue;
    seen.add(k);
    zones.push(z);
  }
  zones.sort((x, y) => RANK[y.risk] - RANK[x.risk] || Number(y.sfha) - Number(x.sfha));
  const zone = zones[0] ?? null;
  const dfirm = zone?.dfirm_id ?? null;

  const juris = (juriR?.features ?? []).map((f) => f.attributes);
  const j = juris.find((x) => x.DFIRM_ID === dfirm) ?? (juris.length === 1 ? juris[0] : null);
  const community = j ? { name: title(String(j.POL_NAME1 ?? '').trim()), nfip_community_id: j.CID ?? null } : null;

  const panels = (panelsR?.features ?? []).map((f) => f.attributes);
  const wantDfirm = dfirm ?? j?.DFIRM_ID ?? null;
  const pm = panels.filter((p) => wantDfirm && p.DFIRM_ID === wantDfirm);
  const pick = (pm.length ? pm : panels.length === 1 ? panels : []).sort((x, y) => Number(y.EFF_DATE ?? 0) - Number(x.EFF_DATE ?? 0))[0];
  const firm_panel = pick ? { panel: pick.FIRM_PAN, effective_date: msDate(pick.EFF_DATE), panel_type: pick.PANEL_TYP ?? null, dfirm_id: pick.DFIRM_ID ?? null } : null;

  const lomrs = (lomrR?.features ?? []).map((f) => f.attributes)
    .filter((l) => !wantDfirm || !l.DFIRM_ID || l.DFIRM_ID === wantDfirm)
    .map((l) => ({ case_no: l.CASE_NO, effective_date: msDate(l.EFF_DATE), status: l.STATUS ?? null }))
    .sort((x, y) => String(y.effective_date).localeCompare(String(x.effective_date)));

  let bfe_lines_nearby: { elevation_ft: number; vertical_datum: string | null; distance_m: number }[] = [];
  if (zone && zone.sfha && zone.base_flood_elevation_ft === null && zone.flood_depth_ft === null && zone.key !== 'A' && zone.key !== 'V' && zone.key !== 'A99') {
    const r = await soft('Base flood elevation lines', femaJson(fetchText, LAYER.bfe, lon, lat, { fields: 'ELEV,LEN_UNIT,V_DATUM', distance: 300, geometry: true, count: 50 }));
    const byElev = new Map<number, { elevation_ft: number; vertical_datum: string | null; distance_m: number }>();
    for (const f of r?.features ?? []) {
      const e = num(f.attributes.ELEV);
      if (e === null || !f.geometry?.paths) continue;
      const ft = String(f.attributes.LEN_UNIT ?? '').toLowerCase().startsWith('met') ? Math.round(e * 3.28084 * 10) / 10 : e;
      const d = Math.round(distanceToLines(f.geometry.paths, lon, lat));
      const prev = byElev.get(ft);
      if (!prev || d < prev.distance_m) byElev.set(ft, { elevation_ft: ft, vertical_datum: f.attributes.V_DATUM || null, distance_m: d });
    }
    bfe_lines_nearby = [...byElev.values()].sort((x, y) => x.distance_m - y.distance_m).slice(0, 4);
  }

  let mapped = true;
  if (!zone) {
    const av = await soft('NFHL availability', femaJson(fetchText, LAYER.availability, lon, lat, { fields: 'STUDY_ID' }));
    mapped = Boolean(av && av.features.length);
  }

  const place = where(loc);
  let summary: string;
  if (zone) {
    const risk = zone.risk === 'high_coastal' ? 'high risk (coastal, with wave action)' : zone.risk === 'open_water' ? 'open water' : `${zone.risk} risk`;
    const sfha = zone.sfha ? 'inside the Special Flood Hazard Area (1% annual chance flood)' : 'outside the Special Flood Hazard Area';
    const parts = [`${place} is in FEMA flood zone ${zone.code}${zone.key === 'X_SHADED' ? ' (shaded)' : zone.key === 'X' ? ' (unshaded)' : ''}${zone.floodway ? ', regulatory floodway' : ''}: ${risk}, ${sfha}.`];
    if (zone.subtype && !zone.floodway) parts.push(`Subtype: ${title(zone.subtype)}.`);
    if (zone.base_flood_elevation_ft !== null) parts.push(`Base flood elevation ${zone.base_flood_elevation_ft} ft${zone.vertical_datum ? ` (${zone.vertical_datum})` : ''}.`);
    if (zone.flood_depth_ft !== null) parts.push(`Base flood depth ${zone.flood_depth_ft} ft above ground.`);
    if (bfe_lines_nearby.length) parts.push(`No single BFE for this polygon; the nearest BFE lines are ${bfe_lines_nearby.map((b) => `${b.elevation_ft} ft at ${b.distance_m} m`).join(', ')}${bfe_lines_nearby[0].vertical_datum ? ` (${bfe_lines_nearby[0].vertical_datum})` : ''}.`);
    if (firm_panel) parts.push(`FIRM panel ${firm_panel.panel}${firm_panel.effective_date ? ` effective ${firm_panel.effective_date}` : ''}.`);
    if (lomrs.length) parts.push(`Revised by LOMR ${lomrs.map((l) => `${l.case_no}${l.effective_date ? ` (${l.effective_date})` : ''}`).join(', ')}.`);
    if (zones.length > 1) parts.push(`The point touches ${zones.length} zones (${zones.map((z) => z.code + (z.floodway ? ' floodway' : '')).join(', ')}); the riskiest is shown. A survey or elevation certificate settles which applies to the building.`);
    parts.push(zone.sfha ? 'Flood insurance is required for a federally backed mortgage.' : zone.risk === 'open_water' ? '' : 'Flood insurance is optional (not federally required).');
    summary = parts.filter(Boolean).join(' ');
  } else if (mapped) {
    summary = `${place}: FEMA's digital flood map covers this area but has no flood zone polygon at this exact point. Check the effective FIRM at msc.fema.gov.`;
  } else {
    summary = `${place}: FEMA has no digital flood map (National Flood Hazard Layer) here. The community may have only a paper FIRM (search msc.fema.gov), may not be mapped, or the point is outside the US.`;
  }
  if (zones.length > 1) notes.push('The point lies on or near a boundary between flood zones.');
  if (loc.matched_address) notes.push(`Address matched by the Census geocoder to ${loc.matched_address} (${loc.latitude}, ${loc.longitude}); the geocoded point is on the street segment, not the building footprint.`);
  if (zone?.sfha) notes.push('An elevation certificate compares the building\'s lowest floor with the BFE and drives the premium; a Letter of Map Amendment (LOMA) can remove a building on naturally high ground from the SFHA.');
  if (zone && !zone.sfha && zone.risk !== 'open_water') notes.push('Use flood_zone_nearby to see how far the nearest high-risk zone is.');

  return {
    summary,
    location: loc,
    zone: zone ? {
      code: zone.code, label: zone.label, subtype: zone.subtype, risk: zone.risk, special_flood_hazard_area: zone.sfha, floodway: zone.floodway,
      base_flood_elevation_ft: zone.base_flood_elevation_ft, vertical_datum: zone.vertical_datum, flood_depth_ft: zone.flood_depth_ft, meaning: zone.meaning,
    } : null,
    other_zones_at_point: zones.slice(1).map((z) => ({ code: z.code, subtype: z.subtype, risk: z.risk, special_flood_hazard_area: z.sfha, base_flood_elevation_ft: z.base_flood_elevation_ft })),
    bfe_lines_nearby,
    insurance: zone ? insuranceNote(zone.risk) : null,
    firm_panel,
    community,
    letters_of_map_revision: lomrs,
    digital_flood_map: zone ? true : mapped,
    official_map: officialMapUrl(loc),
    notes,
    as_of: now.toISOString(),
    source: SOURCE,
    more: more(),
  };
}

const NEARBY_WHERE = "FLD_ZONE <> 'X' OR ZONE_SUBTY <> 'AREA OF MINIMAL FLOOD HAZARD'";

export async function floodZoneNearby(fetchText: FetchText, a: { address?: string; latitude?: number; longitude?: number; radius_m?: number }, now = new Date()) {
  const radius = a.radius_m === undefined ? 500 : Math.round(Number(a.radius_m));
  if (!Number.isFinite(radius) || radius < 50 || radius > 2000) throw new InputError('radius_m must be between 50 and 2000 metres.');
  const loc = await resolveLocation(fetchText, a);
  const { longitude: lon, latitude: lat } = loc;
  const r = await femaJson(fetchText, LAYER.zones, lon, lat, {
    fields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DEPTH,LEN_UNIT,V_DATUM', distance: radius, where: NEARBY_WHERE, geometry: true, offset: 0.0001, count: 200,
  });
  interface Group { code: string; subtype: string | null; label: string; risk: Risk; special_flood_hazard_area: boolean; floodway: boolean; distance_m: number; distance_ft: number; polygons: number; base_flood_elevations_ft: number[] }
  const groups = new Map<string, Group>();
  let atPoint: PointZone | null = null;
  for (const f of r.features) {
    if (!f.geometry?.rings) continue;
    let z: PointZone;
    try { z = pointZone(f.attributes); } catch { continue; }
    if (z.risk === 'open_water' || z.risk === 'minimal') continue;
    const d = distanceToPolygon(f.geometry.rings, lon, lat);
    if (d === 0 && (!atPoint || RANK[z.risk] > RANK[atPoint.risk])) atPoint = z;
    const key = `${z.code}|${z.floodway ? 'FW' : ''}|${z.key}`;
    const dm = Math.round(d / 5) * 5;
    const g = groups.get(key) ?? { code: z.code, subtype: z.floodway ? 'FLOODWAY' : z.key === 'X_SHADED' ? z.subtype : null, label: z.label + (z.floodway ? ' floodway' : ''), risk: z.risk, special_flood_hazard_area: z.sfha, floodway: z.floodway, distance_m: dm, distance_ft: m2ft(dm), polygons: 0, base_flood_elevations_ft: [] };
    g.polygons++;
    if (dm < g.distance_m) { g.distance_m = dm; g.distance_ft = m2ft(dm); }
    if (z.base_flood_elevation_ft !== null && !g.base_flood_elevations_ft.includes(z.base_flood_elevation_ft)) g.base_flood_elevations_ft.push(z.base_flood_elevation_ft);
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((x, y) => x.distance_m - y.distance_m || RANK[y.risk] - RANK[x.risk]);
  for (const g of list) g.base_flood_elevations_ft.sort((x, y) => x - y);
  const high = list.filter((g) => g.special_flood_hazard_area);
  const nearestHigh = high[0] ?? null;
  const nearestModerate = list.find((g) => g.risk === 'moderate') ?? null;
  const place = where(loc);
  const fmt = (g: Group) => `${g.label} ${g.distance_m === 0 ? 'at the point' : `${g.distance_m} m (${g.distance_ft} ft) away`}`;
  let summary: string;
  if (!list.length) {
    summary = `No high-risk, moderate-risk or undetermined FEMA flood zone within ${radius} m of ${place}: everything mapped within that radius is minimal-hazard zone X or open water (or there is no digital flood map here; flood_zone_lookup says which).`;
  } else {
    const head = nearestHigh
      ? (nearestHigh.distance_m === 0 ? `${place} is inside a high-risk flood zone (${nearestHigh.label}).` : `Nearest high-risk (1% annual chance) flood zone to ${place}: ${fmt(nearestHigh)}.`)
      : `No high-risk (1% annual chance) flood zone within ${radius} m of ${place}.`;
    summary = `${head} Within ${radius} m: ${list.slice(0, 6).map(fmt).join('; ')}.`;
  }
  const notes = ['Distances are straight-line to the edge of each mapped zone, from generalized polygons (about 10 m accuracy). Distance alone does not set the insurance requirement; the zone at the building does.'];
  if (r.exceeded) notes.push('FEMA returned its maximum of 200 polygons; a smaller radius gives a complete list.');
  if (!atPoint) notes.push('At the point itself: minimal-hazard zone X or no mapped zone (run flood_zone_lookup for the exact zone, panel and BFE).');
  return {
    summary, location: loc, radius_m: radius,
    at_point: atPoint ? { code: atPoint.code, label: atPoint.label, risk: atPoint.risk, special_flood_hazard_area: atPoint.sfha } : null,
    nearest_high_risk: nearestHigh, nearest_moderate_risk: nearestModerate, zones: list,
    notes, official_map: officialMapUrl(loc), as_of: now.toISOString(), source: SOURCE, more: more(),
  };
}

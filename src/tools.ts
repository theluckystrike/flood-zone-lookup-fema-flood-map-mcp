// Tool registry shared by the stdio and Worker entries.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { InputError, REPO, SITE, explainZone, floodZoneLookup, floodZoneNearby } from './core.js';
import type { FetchText } from './types.js';

export const VERSION = '1.0.0';

export const META = {
  alias: 'flood-zone',
  metaDescription: 'MCP server for FEMA flood zone lookup by address: the flood zone from the FEMA flood map (National Flood Hazard Layer), base flood elevation, FIRM panel and effective date, map revisions, nearby high-risk zones and what the zone means for flood insurance.',
  intro: 'FEMA flood zone lookup for AI assistants: the flood zone at any US address, read live from the FEMA National Flood Hazard Layer, with the base flood elevation, FIRM panel and what it means for flood insurance.',
};

export const TOOL_INFO = [
  { name: 'flood_zone_lookup', blurb: 'The FEMA flood zone at a US address or point: zone, Special Flood Hazard Area yes or no, base flood elevation or depth, FIRM panel and effective date, LOMRs, community, and the flood insurance meaning.' },
  { name: 'flood_zone_nearby', blurb: 'High-risk, moderate-risk and undetermined flood zones within a radius of an address, with the distance to the nearest of each.' },
  { name: 'flood_zone_explain', blurb: 'What a FEMA flood zone code means (A, AE, AH, AO, AR, A99, V, VE, shaded or unshaded X, D) and its flood insurance rules.' },
];

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(data: Record<string, unknown> & { summary: string }) {
  return { content: [{ type: 'text' as const, text: `${data.summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}
function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text' as const, text: `${e instanceof InputError ? 'Error' : 'Upstream FEMA or Census error'}: ${msg}` }] };
}
const wrap = <A>(fn: (a: A) => unknown) => async (a: A) => { try { return ok((await fn(a)) as any); } catch (e) { return fail(e); } };

const where = {
  address: z.string().min(3).max(200).optional().describe('US street address with city and state or ZIP, e.g. "701 Bourbon St, New Orleans, LA 70116". "lat,lon" also works.'),
  latitude: z.number().min(-90).max(90).optional().describe('Latitude in decimal degrees, instead of an address.'),
  longitude: z.number().min(-180).max(180).optional().describe('Longitude in decimal degrees (negative west), with latitude.'),
};

export function createServer(fetchText: FetchText): McpServer {
  const server = new McpServer({ name: REPO, version: VERSION, websiteUrl: SITE } as any, {
    instructions:
      'FEMA flood zones read at call time from the FEMA National Flood Hazard Layer (the digital FEMA flood map), with addresses geocoded by the U.S. Census Bureau. ' +
      'A model cannot know the flood zone of a specific lot. Use flood_zone_lookup for "what flood zone is this address in", "is this house in a flood zone", "do I need flood insurance" ' +
      'or "what is the base flood elevation"; flood_zone_nearby for "how close is the floodplain"; flood_zone_explain for what a zone code such as AE, VE or shaded X means. ' +
      'Results are informational, not an official flood zone determination.',
  });

  server.registerTool('flood_zone_lookup', {
    title: 'Flood zone lookup by address',
    description:
      'The FEMA flood zone at a US street address or latitude/longitude, from the National Flood Hazard Layer: zone code (A, AE, AH, AO, V, VE, shaded or unshaded X, D), ' +
      'whether it is in the Special Flood Hazard Area (high risk, 1% annual chance), the base flood elevation or flood depth, the FIRM panel number and effective date, ' +
      'Letters of Map Revision, the NFIP community, whether flood insurance is federally required, and a link to the official FEMA map.',
    inputSchema: where,
    annotations: { title: 'Flood zone lookup', ...RO },
  }, wrap((a: any) => floodZoneLookup(fetchText, a)));

  server.registerTool('flood_zone_nearby', {
    title: 'Flood zones near an address',
    description:
      'High-risk (A and V zones, including floodways), moderate-risk (shaded X, 0.2% annual chance) and undetermined (D) FEMA flood zones within a radius of a US address or point ' +
      '(default 500 m, up to 2000 m), with the straight-line distance to the nearest of each and their base flood elevations. Answers "how far is this house from the floodplain".',
    inputSchema: { ...where, radius_m: z.number().min(50).max(2000).optional().describe('Search radius in metres, 50 to 2000. Default 500.') },
    annotations: { title: 'Flood zones nearby', ...RO },
  }, wrap((a: any) => floodZoneNearby(fetchText, a)));

  server.registerTool('flood_zone_explain', {
    title: 'What a flood zone means',
    description:
      'What a FEMA flood zone code means and its flood insurance rules: A, AE, AH, AO, AR, A99, V, VE, shaded X (old B, 0.2% annual chance), unshaded X (old C), D. ' +
      'Omit the zone for the full list. No address needed.',
    inputSchema: {
      zone: z.string().max(40).optional().describe('Zone code, e.g. AE, VE, X, "shaded X", B, C, D. Omit for every zone.'),
      subtype: z.string().max(100).optional().describe('Optional zone subtype from a map, e.g. "FLOODWAY" or "0.2 PCT ANNUAL CHANCE FLOOD HAZARD".'),
    },
    annotations: { title: 'Flood zone meaning', ...RO, openWorldHint: false },
  }, wrap(async (a: any) => explainZone(a)));

  return server;
}

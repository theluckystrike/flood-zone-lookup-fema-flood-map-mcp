# flood-zone-lookup-fema-flood-map-mcp

**FEMA flood zone, base flood elevation and Special Flood Hazard Area status for any US address, from the FEMA flood map (NFHL), as an MCP server.** Free and hosted: no API key, no sign-up.

Hosted MCP URL (Streamable HTTP):

```
https://flood-zone-lookup-fema-flood-map-mcp.lipmichal.workers.dev/mcp
```

## Quick start

### Claude

Claude Desktop or claude.ai: Settings > Connectors > Add custom connector, then paste the URL above.

Claude Code:

```
claude mcp add --transport http flood-zone https://flood-zone-lookup-fema-flood-map-mcp.lipmichal.workers.dev/mcp
```

Claude Desktop config file (`claude_desktop_config.json`), through the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "flood-zone": { "command": "npx", "args": ["-y", "mcp-remote", "https://flood-zone-lookup-fema-flood-map-mcp.lipmichal.workers.dev/mcp"] }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "flood-zone": { "url": "https://flood-zone-lookup-fema-flood-map-mcp.lipmichal.workers.dev/mcp" }
  }
}
```

## About

FEMA flood zone lookup for AI assistants. Ask what flood zone an address is in, whether a house is in the 100-year floodplain, what the base flood elevation is, whether flood insurance is required, or how far the nearest high-risk zone is.

This is a Model Context Protocol (MCP) server. It reads the FEMA National Flood Hazard Layer (the digital FEMA flood map) and geocodes addresses with the U.S. Census Bureau geocoder at call time. It needs no API key.

## Tools

| Tool | What it returns |
| --- | --- |
| `flood_zone_lookup` | The FEMA flood zone at a US street address or latitude/longitude: zone code, Special Flood Hazard Area yes or no, base flood elevation or flood depth (or the nearest BFE lines), FIRM panel number and effective date, Letters of Map Revision, NFIP community, flood insurance meaning and a link to the official FEMA map. |
| `flood_zone_nearby` | High-risk (A and V zones and floodways), moderate-risk (shaded X) and undetermined (D) flood zones within 50 to 2000 m of an address, with the distance to the nearest of each and their base flood elevations. |
| `flood_zone_explain` | What a zone code means (A, AE, AH, AO, AR, A99, V, VE, shaded X or B, unshaded X or C, D) and its flood insurance rules. No address needed. |

Every result has structured JSON, a plain-text summary, `as_of`, `source` and `more` (a page on [mcpstamp.com](https://www.mcpstamp.com/servers/?utm_source=mcp&utm_medium=flood-zone-lookup-fema-flood-map-mcp)). Every tool is marked read-only.

## What it knows that your model does not

- The flood zone of a specific lot, which changes from one side of a street to the other and which no model has memorized: FEMA's current effective map, including Letters of Map Revision issued this year.
- The base flood elevation and its datum (NAVD88 or NGVD29), or the flood depth in AO zones, and the FIRM panel that applies. Where panels of neighbouring counties overlap, it picks the panel of the flood study that covers the point.
- How close the floodplain is: the straight-line distance to the nearest high-risk, floodway and 0.2% annual chance zones.

## Other clients and local install

### Hosted (custom connector, ChatGPT developer mode, any remote MCP client)

Paste this URL. No token, no sign-up.

```
https://flood-zone-lookup-fema-flood-map-mcp.lipmichal.workers.dev/mcp
```

### VS Code

Add to `.vscode/mcp.json`.

```json
{
  "servers": {
    "flood-zone": { "type": "http", "url": "https://flood-zone-lookup-fema-flood-map-mcp.lipmichal.workers.dev/mcp" }
  }
}
```

### Local stdio

The npm package is not published. Build it from this repository with Node 20 or newer, then point your MCP client at `node /path/to/flood-zone-lookup-fema-flood-map-mcp/dist/stdio.js`.

```
git clone https://github.com/theluckystrike/flood-zone-lookup-fema-flood-map-mcp && cd flood-zone-lookup-fema-flood-map-mcp
npm install && npm run build
node dist/stdio.js
```

## Example prompts

- "What flood zone is 1000 Ocean Dr, Miami Beach, FL 33139 in, and do I need flood insurance?"
- "Is 1701 Wynkoop St, Denver in a flood zone? How far is the nearest floodplain?"
- "What does flood zone AE mean compared with shaded X?"
- "What is the base flood elevation at 29.2896, -94.7888?"

## Data sources

Full list in [DATA_SOURCES.md](DATA_SOURCES.md).

- FEMA National Flood Hazard Layer map service (hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer): flood hazard zones (layer 28), FIRM panels (3), LOMRs (1), base flood elevation lines (16), political jurisdictions (22), NFHL availability (0).
- U.S. Census Bureau geocoder (geocoding.geo.census.gov), one-line address search, Public_AR_Current benchmark.

## Limitations

- Not an official flood zone determination. Lenders and insurers use a Standard Flood Hazard Determination Form; building rules use an elevation certificate. The official map is linked in every lookup (msc.fema.gov).
- The geocoded point is on the street segment, not the building footprint. On a zone boundary the riskiest zone is shown and the others are listed.
- Areas with only a paper FIRM, or no FEMA map, return no zone. Preliminary (not yet effective) maps are not included.
- Nearby distances come from generalized polygons and are accurate to about 10 m.

## More

More MCP servers that answer questions your assistant cannot answer alone are on [mcpstamp.com](https://www.mcpstamp.com/servers/?utm_source=mcp&utm_medium=flood-zone-lookup-fema-flood-map-mcp).

Part of the Zovo MCP collection at https://mcp.zovo.one

Built by [theluckystrike](https://github.com/theluckystrike).

## Development

```
npm install
npm test                              # builds, then runs the fixture tests and an offline stdio test
node scripts/stdio-transcript.mjs     # live stdio round trip, writes .live/stdio-transcript.jsonl
```

CI (`.github/workflows/bundle.yml`) runs the tests, the type check and `wrangler deploy --dry-run --outdir out`, and uploads the Worker bundle as an artifact.

## License

MIT

# Data sources

| Data | Source | How it is read |
| --- | --- | --- |
| Flood hazard zones (FLD_ZONE, ZONE_SUBTY, SFHA_TF, STATIC_BFE, DEPTH, V_DATUM) | FEMA National Flood Hazard Layer, layer 28, https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28 | ArcGIS REST point query; distance query with generalized geometry for nearby zones |
| FIRM panels (FIRM_PAN, EFF_DATE, PANEL_TYP) | NFHL layer 3 | Point query; the panel whose DFIRM_ID matches the flood zone is used |
| Letters of Map Revision (CASE_NO, EFF_DATE, STATUS) | NFHL layer 1 | Point query |
| Base flood elevation lines (ELEV) | NFHL layer 16 | 300 m distance query, only for A-zone polygons without a single static BFE |
| NFIP community (POL_NAME1, CID) | NFHL layer 22 | Point query |
| Whether a digital map exists | NFHL layer 0 (NFHL Availability) | Point query, only when no zone is found |
| Address to coordinates | U.S. Census Bureau geocoder, https://geocoding.geo.census.gov/geocoder/locations/onelineaddress (benchmark Public_AR_Current) | One-line address search |

All sources are public and need no key. The hosted Worker caches answers at the Cloudflare edge for one day. hazards.fema.gov occasionally answers HTTP 525 to Cloudflare; each FEMA request is retried up to three times.

Zone meanings follow the FEMA Flood Insurance Rate Map legend and NFIP rules (mandatory purchase requirement in Special Flood Hazard Areas, Risk Rating 2.0 pricing since 2021).

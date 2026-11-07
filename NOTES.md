# Notes

Decision log, unconfirmed assumptions and known limitations. One line each: decision / alternative / trade-off.

## Location names (LOCATION_NAMES.md)
- Stacked the PR on #33 (top of the restructure stack), not main / main has no backend yet / retarget to main once the stack merges.
- Boundaries from geoBoundaries CGAZ ADM0-2 (+ gbOpen ADM3 with an allowed license) / OSM admin_level extracts / CGAZ is one clean global file with CC BY 4.0, but city coverage is patchy and attribution is required.
- Loading with `shp2pgsql` (ships with PostGIS) / an npm shapefile parser / no new dependency, but the full seed needs the PostGIS CLI tools on the machine.
- Kept `gyms.country_code`, now set from country polygons instead of Photon / derive currency from `area_id` / currency code untouched, small duplication of the country.
- Unapproved add_gym rows resolve `place` with a read-time ST_Contains on `areas` / a stored area_id on gym_changes / no extra column; local indexed query, not geocoding.
- Assumption (unconfirmed): showing "City, Region, Country" next to / instead of the address counts as Joey's OK for that visible change (the brief asks for it).
- Limitation: city is missing wherever no ADM3 polygon exists (open question 1 in LOCATION_NAMES.md).
- Limitation: postcode only from OSM addr:postcode; Google Maps / website don't expose a structured postcode yet.

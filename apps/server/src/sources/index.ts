// Source selection is "by region + config" (DESIGN_DISCUSSION.md), not
// a demo/scale switch like the other three interfaces - Overpass is the
// only one built in this slice. The Google Maps scraper (sweeps, FR-11)
// is its own module, built separately.
import { OverpassSource } from "./overpass-source.js"
import type { SourceInterface } from "../interfaces/source.js"

export const overpassSource: SourceInterface = new OverpassSource()

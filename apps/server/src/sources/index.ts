// Source selection is "by region + config" (DESIGN_DISCUSSION.md), not
// a demo/scale switch like the other three interfaces.
import { OverpassSource } from "./overpass-source.js"
import { googleMapsSource } from "./google-maps-source.js"
import type { SourceInterface } from "../interfaces/source.js"

export const overpassSource: SourceInterface = new OverpassSource()
export { googleMapsSource }

// Client-side mirror of apps/server/src/lib.ts's geohash functions - no
// shared package wired up yet, so duplicated.
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface Bbox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export function encodeGeohash(lat: number, lng: number, precision = 4): string {
  let minLat = -90;
  let maxLat = 90;
  let minLng = -180;
  let maxLng = 180;
  let isEvenBit = true;
  let bit = 0;
  let charIdx = 0;
  let geohash = '';

  while (geohash.length < precision) {
    if (isEvenBit) {
      const mid = (minLng + maxLng) / 2;
      if (lng >= mid) {
        charIdx |= 1 << (4 - bit);
        minLng = mid;
      } else {
        maxLng = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) {
        charIdx |= 1 << (4 - bit);
        minLat = mid;
      } else {
        maxLat = mid;
      }
    }
    isEvenBit = !isEvenBit;
    if (bit < 4) {
      bit++;
    } else {
      geohash += GEOHASH_BASE32[charIdx];
      bit = 0;
      charIdx = 0;
    }
  }
  return geohash;
}

function decodeGeohashBounds(geohash: string): Bbox {
  let minLat = -90;
  let maxLat = 90;
  let minLng = -180;
  let maxLng = 180;
  let isEvenBit = true;

  for (const char of geohash.toLowerCase()) {
    const idx = GEOHASH_BASE32.indexOf(char);
    if (idx === -1) throw new Error(`Invalid geohash character: ${char}`);
    for (let bit = 4; bit >= 0; bit--) {
      const bitValue = (idx >> bit) & 1;
      if (isEvenBit) {
        const mid = (minLng + maxLng) / 2;
        if (bitValue) minLng = mid;
        else maxLng = mid;
      } else {
        const mid = (minLat + maxLat) / 2;
        if (bitValue) minLat = mid;
        else maxLat = mid;
      }
      isEvenBit = !isEvenBit;
    }
  }
  return { minLat, maxLat, minLng, maxLng };
}

// Grid-walks at half a tile's span so no edge sliver is skipped;
// oversampling is harmless (the Set dedupes).
function tilesCoveringBbox(bbox: Bbox, precision: number): string[] {
  const sample = decodeGeohashBounds(encodeGeohash(bbox.minLat, bbox.minLng, precision));
  const latStep = (sample.maxLat - sample.minLat) / 2;
  const lngStep = (sample.maxLng - sample.minLng) / 2;
  const tiles = new Set<string>();

  const lats: number[] = [];
  for (let lat = bbox.minLat; lat < bbox.maxLat; lat += latStep) lats.push(lat);
  lats.push(bbox.maxLat);
  const lngs: number[] = [];
  for (let lng = bbox.minLng; lng < bbox.maxLng; lng += lngStep) lngs.push(lng);
  lngs.push(bbox.maxLng);

  for (const lat of lats) for (const lng of lngs) tiles.add(encodeGeohash(lat, lng, precision));
  return [...tiles];
}

// For GET /v1/tiles/{geohash4} - map data loading.
export function geohash4TilesCoveringBbox(bbox: Bbox): string[] {
  return tilesCoveringBbox(bbox, 4);
}

// For POST /v1/sweeps - one sweep per covering geohash5 cell, not one
// bbox call.
export function geohash5TilesCoveringBbox(bbox: Bbox): string[] {
  return tilesCoveringBbox(bbox, 5);
}

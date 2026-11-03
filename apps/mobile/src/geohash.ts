// Client-side mirror of apps/server/src/lib.ts's encodeGeohash/
// geohash5TilesCoveringBbox, at precision 4 instead of 5 - the map
// needs to work out which geohash4 tiles cover the current viewport
// (API.md 2.2: "The app works out which geohash4 cells cover the
// screen and requests them in parallel"). Not imported from the server
// package (there's no shared package wired up between apps/mobile and
// apps/server for this yet - packages/shared is still an empty
// placeholder) - duplicated deliberately rather than standing up that
// cross-package plumbing for one small, pure, already-tested algorithm.
// The server-side version is confirmed correct against real PostGIS
// output (encodeGeohash(-8.6501, 115.1385, 5) === "qw3yu", matching
// ST_GeoHash exactly) - this is the identical algorithm, just stopped
// one character earlier.
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

// Grid-walks at HALF a tile's own span, not a full one - a thin sliver
// near the viewport's edge would otherwise be silently skipped, since
// the geohash grid isn't aligned to the viewport's own corner.
// Oversampling is harmless (the Set dedupes).
function tilesCoveringBbox(bbox: Bbox, precision: number): string[] {
  const sample = decodeGeohashBounds(encodeGeohash(bbox.minLat, bbox.minLng, precision));
  const latStep = (sample.maxLat - sample.minLat) / 2;
  const lngStep = (sample.maxLng - sample.minLng) / 2;
  const tiles = new Set<string>();

  for (let lat = bbox.minLat; lat <= bbox.maxLat; lat += latStep) {
    for (let lng = bbox.minLng; lng <= bbox.maxLng; lng += lngStep) {
      tiles.add(encodeGeohash(lat, lng, precision));
    }
    tiles.add(encodeGeohash(lat, bbox.maxLng, precision));
  }
  tiles.add(encodeGeohash(bbox.maxLat, bbox.maxLng, precision));
  return [...tiles];
}

// For GET /v1/tiles/{geohash4} - map data loading (API.md 2.2).
export function geohash4TilesCoveringBbox(bbox: Bbox): string[] {
  return tilesCoveringBbox(bbox, 4);
}

// For POST /v1/sweeps - only a single geohash5 cell per request (API.md
// 2.4's sweep scope cut), so "find more gyms" over a whole viewport
// means one sweep per covering geohash5 cell, not one bbox call like
// the old demo's /api/gyms/find-more.
export function geohash5TilesCoveringBbox(bbox: Bbox): string[] {
  return tilesCoveringBbox(bbox, 5);
}

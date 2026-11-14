import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

// Only this file (and gym-map-screen.tsx's WebView bridge) touches Leaflet
// directly - gym-panels.tsx has everything else (chat, reviews, edit/add-
// gym forms) shared between both platforms. Leaflet is DOM-only, so this
// file only renders on web; see gym-map-screen.tsx for native's WebView-
// wrapped version of the same map.
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngBounds } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import Supercluster from 'supercluster';

import { API_BASE_URL } from '@/config';
import {
  type Gym,
  type FxRate,
  type NewGymLocation,
  GYM_CATEGORIES,
  UNKNOWN_CATEGORY,
  formatCents,
  acceptsDropIn,
  gymMatchesSearch,
  prefetchAreaCell,
  TrialSection,
  ReviewsSection,
  ChatSection,
  SubmitGymForm,
  SuggestEditForm,
  panelStyles,
} from '@/components/gym-panels';

// Below this zoom, individual amenity filters stop making sense (you're
// looking at aggregated counts, not individual gyms) and get hidden.
const FILTERS_VISIBLE_AT_ZOOM = 11;

// The one gym-map screen now, for any area - replaces the old fixed
// /indonesia/bali route. Reached only via a Photon search result on the
// home screen, which always supplies these params; there's no fixed
// "launch city" list anymore (see docs/gym-data-design.md).
function MapResize({ panelOpen }: { panelOpen: boolean }) {
  const map = useMap();
  useEffect(() => {
    const id = requestAnimationFrame(() => map.invalidateSize());
    return () => cancelAnimationFrame(id);
  }, [panelOpen, map]);
  return null;
}

// react-leaflet's MapContainer only reads its center/zoom props once, in
// the ref callback that constructs the underlying Leaflet map on first
// mount (confirmed in react-leaflet's own source: center/zoom are inside
// `if (!mapInstanceRef.current)`, never read again after). If this screen
// stays mounted across navigations - search a city, go back, hit "Near
// me" - the route's params change but the map itself silently stays put,
// since nothing ever calls setView for anything after the first render.
// This is that missing call, keyed on the route's own center so it never
// fights with the user's own panning (which doesn't change params.lat/lng
// at all - see ViewportUrlSync's comment).
function MapViewSync({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1]]);
  return null;
}

// "View on map" from the detail panel - a fresh object each press (even
// re-pressing for the same gym) so this effect's dependency always
// re-fires, not just on the first press for a given gym.
function FlyToGym({ target }: { target: { lat: number; lng: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.setView([target.lat, target.lng], 16);
  }, [target, map]);
  return null;
}

function MapClickHandler({ active, onPick }: { active: boolean; onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      if (active) onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// Mirrors the live viewport into the URL (?lat=&lng=&zoom=), the same
// pattern other map apps use so a pan/zoom is shareable and survives a
// refresh. history.replaceState, not router.setParams - this should never
// trigger a re-render/re-fetch of the screen itself, only update the
// address bar. Web-only, same as the rest of this file (Leaflet is
// DOM-only), so window is always defined here.
function ViewportUrlSync() {
  const map = useMap();
  const sync = () => {
    const center = map.getCenter();
    const url = new URL(window.location.href);
    url.searchParams.set('lat', center.lat.toFixed(5));
    url.searchParams.set('lng', center.lng.toFixed(5));
    url.searchParams.set('zoom', String(map.getZoom()));
    window.history.replaceState(null, '', url.toString());
  };
  useMapEvents({ moveend: sync, zoomend: sync });
  return null;
}

// Supercluster point features carry just enough to look the real gym back
// up afterward - the clustering math only needs coordinates, everything
// else stays in the `gyms` array and gets joined back in by id.
type GymPoint = Supercluster.PointFeature<{ gymId: number }>;

// So the "Find more gyms" button can animate its own opacity for the
// unscanned-area nudge below - plain Pressable can't take an
// Animated.Value in its style.
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function gymsToPoints(gyms: Gym[]): GymPoint[] {
  return gyms.map((g) => ({
    type: 'Feature',
    properties: { gymId: g.id },
    geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
  }));
}

// Renders individual gym markers once zoomed in enough to be looking at a
// specific city/neighborhood, and nothing at all once zoomed out past
// that - changed from growing count-bubbles (per explicit request) to
// just disappearing, rather than showing an aggregate at every zoom
// level. Lives inside <MapContainer> so it can read the live viewport via
// useMap/useMapEvents - the zoom cutoff is viewport-dependent, not
// something that can be precomputed once.
function ClusterLayer({
  gyms,
  selectedGymId,
  onSelectGym,
  onZoomChange,
  onBoundsChange,
}: {
  gyms: Gym[];
  selectedGymId: number | null;
  onSelectGym: (gym: Gym) => void;
  onZoomChange: (zoom: number) => void;
  onBoundsChange: (bounds: LatLngBounds) => void;
}) {
  const map = useMap();
  const [viewport, setViewport] = useState(() => ({
    zoom: map.getZoom(),
    bounds: map.getBounds(),
  }));

  useEffect(() => {
    onZoomChange(viewport.zoom);
  }, [viewport.zoom, onZoomChange]);

  useEffect(() => {
    onBoundsChange(viewport.bounds);
  }, [viewport.bounds, onBoundsChange]);

  useMapEvents({
    moveend: () => setViewport({ zoom: map.getZoom(), bounds: map.getBounds() }),
    zoomend: () => setViewport({ zoom: map.getZoom(), bounds: map.getBounds() }),
  });

  const index = useMemo(() => {
    // maxZoom bumped from 16 to 20 - this is what makes the "no clusters
    // above FILTERS_VISIBLE_AT_ZOOM" rule below actually produce fully
    // individual points when forced, not just smaller ones. supercluster
    // reuses its highest built zoom level's tree for any requested zoom
    // at or above it, so a tree that only goes to 16 could still merge
    // two gyms sitting right next to each other even when we ask for
    // "basically unclustered."
    const sc = new Supercluster<{ gymId: number }>({ radius: 60, maxZoom: 20 });
    sc.load(gymsToPoints(gyms));
    return sc;
  }, [gyms]);

  const gymsById = useMemo(() => new Map(gyms.map((g) => [g.id, g])), [gyms]);

  // Below the same zoom the filter chips use as their own cutoff, you're
  // looking at a whole region/country - too far out for individual gym
  // pins to mean anything, so nothing renders at all rather than growing
  // into aggregate bubbles.
  if (viewport.zoom < FILTERS_VISIBLE_AT_ZOOM) return null;

  const bbox: [number, number, number, number] = [
    viewport.bounds.getWest(),
    viewport.bounds.getSouth(),
    viewport.bounds.getEast(),
    viewport.bounds.getNorth(),
  ];
  // Always queried at supercluster's finest granularity now - there's no
  // zoomed-out bubble view left to produce. maxZoom 20 on the index above
  // still means this only ever merges two gyms sitting at (near-)
  // identical coordinates, not ones that are merely close by.
  const clusters = index.getClusters(bbox, 20);

  return (
    <>
      {clusters.map((feature) => {
        const [lng, lat] = feature.geometry.coordinates;
        const { cluster, point_count: pointCount, cluster_id: clusterId, gymId } = feature.properties as any;

        if (cluster) {
          // Rare fallback - two (near-)identical coordinates merged by
          // supercluster, not the old "zoom out and watch it grow" bubble.
          const radius = 14 + Math.min(18, Math.log(pointCount) * 6);
          return (
            <CircleMarker
              key={`cluster-${clusterId}`}
              center={[lat, lng]}
              radius={radius}
              pathOptions={{ color: '#146C5F', fillColor: '#146C5F', fillOpacity: 0.75 }}
              eventHandlers={{
                click: () => {
                  const expansionZoom = Math.min(index.getClusterExpansionZoom(clusterId), 18);
                  map.setView([lat, lng], expansionZoom);
                },
              }}
            >
              <Tooltip direction="top" offset={[0, -6]}>
                {pointCount} gyms
              </Tooltip>
            </CircleMarker>
          );
        }

        const gym = gymsById.get(gymId);
        if (!gym) return null;
        return (
          <CircleMarker
            key={gym.id}
            center={[gym.lat, gym.lng]}
            radius={8}
            pathOptions={{
              color: '#146C5F',
              fillColor: gym.id === selectedGymId ? '#146C5F' : '#3FA393',
              fillOpacity: 0.9,
            }}
            eventHandlers={{ click: () => onSelectGym(gym) }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              {gym.name} {gym.rating ? `· ⭐ ${gym.rating}` : ''}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

// Hover-ahead of the actual pan: starts loading OSM/Overpass data for
// whatever's under the cursor before the user actually pans there, so by
// the time they do, ensureAreaFresh on the server has already warmed
// fetched_areas for that spot and the real pan's by-area call just hits
// Postgres instead of waiting on a live Overpass round-trip. Grid-keyed
// in a plain Set kept in a ref, not state - this never needs to trigger
// a render, it's pure fire-and-forget prefetching, and it doesn't even
// need the response (gyms for that area land on screen normally once the
// user actually pans there and the usual mapBounds-driven load runs).
// prefetchAreaCell/onLoadingChange are shared with native's drag-based
// equivalent (gym-panels.tsx) - same dedup+fetch logic, different
// trigger (hover here, in-progress drag there).
const HOVER_PREFETCH_DEBOUNCE_MS = 600;

function HoverPrefetch({ onLoadingChange }: { onLoadingChange: (delta: number) => void }) {
  const prefetchedCells = useRef(new Set<string>());
  const lastFireRef = useRef(0);

  useMapEvents({
    mousemove: (e) => {
      const now = Date.now();
      if (now - lastFireRef.current < HOVER_PREFETCH_DEBOUNCE_MS) return;
      lastFireRef.current = now;
      prefetchAreaCell(e.latlng.lat, e.latlng.lng, prefetchedCells.current, onLoadingChange);
    },
  });
  return null;
}

export default function MapScreen() {
  const params = useLocalSearchParams<{
    name: string;
    lat: string;
    lng: string;
    minLat: string;
    minLng: string;
    maxLat: string;
    maxLng: string;
    zoom?: string;
  }>();
  const router = useRouter();

  // areaGyms: the result of the Overpass-backed by-area lookup for the
  // location that was actually searched - this is what triggers/reflects
  // the freshness refresh, drives the initial loading/error state, and
  // backs the "<area> - N gyms" badge count.
  // allGyms: every gym worldwide (GET /api/gyms/all, loaded once), kept up
  // to date by merging areaGyms' rows in whenever a lookup resolves. The
  // map renders from this, not areaGyms, so panning away from the searched
  // area still shows whatever's already in Postgres instead of going
  // blank - supercluster indexes the whole set client-side, so this stays
  // cheap even as the dataset grows (see docs/gym-data-design.md).
  const [areaGyms, setAreaGyms] = useState<Gym[] | null>(null);
  const [allGyms, setAllGyms] = useState<Gym[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGym, setSelectedGym] = useState<Gym | null>(null);
  // "View on map" in the detail panel - re-centers/zooms without
  // touching selectedGym, so the panel doesn't need to close on web
  // (nothing's blocking the map here, unlike native).
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number } | null>(null);
  const [suggestingEdit, setSuggestingEdit] = useState(false);
  // Resets whenever a different gym (or no gym) is selected, rather than
  // threading a reset into every setSelectedGym call site - there are
  // several (map click, price-list rows, chat update, close button) and
  // all of them should drop back to the normal detail view.
  useEffect(() => setSuggestingEdit(false), [selectedGym?.id]);
  const [addingGym, setAddingGym] = useState(false);
  const [newGymLocation, setNewGymLocation] = useState<NewGymLocation | null>(null);
  const [dropInOnly, setDropInOnly] = useState(false);
  const [trialOnly, setTrialOnly] = useState(false);
  // Live, substring, case-insensitive against name/description/address/
  // categories (gymMatchesSearch in gym-panels.tsx) - filters the actual
  // markers on screen (same filter chain as drop-in/trial/category
  // below), not a separate search-results list, per explicit request
  // that every keystroke should make gyms appear/disappear on the map
  // itself.
  const [searchQuery, setSearchQuery] = useState('');
  // Empty set = no filter applied (show every category) - same
  // "unchecked means unfiltered" convention as dropInOnly/trialOnly,
  // just extended to multiple simultaneous choices since a gym's
  // category isn't a single yes/no the way drop-ins/trials are.
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const initialZoom = params.zoom ? parseFloat(params.zoom) : 12;
  const [zoom, setZoom] = useState(initialZoom);
  const [mapBounds, setMapBounds] = useState<LatLngBounds | null>(null);

  // Tied to the live map viewport (mapBounds' center), not the originally
  // searched location - a real bug in the first version of this: search
  // one city, pan the map to another country entirely (which this screen
  // fully supports - every gym worldwide stays visible while panning),
  // and prices kept showing in the FIRST city's currency since the fetch
  // was keyed on params.lat/lng, fixed at page load. Debounced so panning
  // doesn't fire a lookup on every intermediate frame - country-sized
  // currency zones don't need pixel-level reactivity. Still not fully
  // correct per-gym at world zoom (one viewport can span many countries;
  // picking a currency per visible marker would need a reverse-geocode
  // each), but it now tracks where you're actually looking, not just
  // where you started.
  const [fx, setFx] = useState<FxRate>({ currency: 'USD', rate: 1 });

  const fetchFx = (lat: number, lng: number) => {
    fetch(`${API_BASE_URL}/api/fx?lat=${lat}&lng=${lng}`)
      .then((r) => r.json())
      .then(setFx)
      .catch((e) => console.error('Failed to load FX rate', e));
  };

  // Immediate, on the searched location - guarantees the common case
  // (search a city, see that city's currency right away) is correct from
  // the first paint, without waiting on mapBounds to exist at all.
  useEffect(() => {
    fetchFx(parseFloat(params.lat), parseFloat(params.lng));
  }, [params.lat, params.lng]);

  // Debounced, on the live viewport - keeps it correct as you pan
  // somewhere else entirely (this screen shows every gym worldwide while
  // panning, not just the searched area), without firing a lookup on
  // every intermediate frame. Whichever of the two resolves last wins;
  // for a fresh search they agree anyway, this one only matters once you
  // actually move away from where you started.
  useEffect(() => {
    if (!mapBounds) return;
    const center = mapBounds.getCenter();
    const id = setTimeout(() => fetchFx(center.lat, center.lng), 500);
    return () => clearTimeout(id);
  }, [mapBounds]);

  const center: [number, number] = [parseFloat(params.lat), parseFloat(params.lng)];

  // Checked once per fresh arrival (keyed on the search/"near me" params,
  // same as the fetchFx effect above) - deliberately NOT keyed on
  // mapBounds, so panning around never re-triggers this. Only tells the
  // user "no one's scanned here yet" the one time that's actually true:
  // right when they land somewhere via search or geolocation.
  const [showScanNudge, setShowScanNudge] = useState(false);
  useEffect(() => {
    setShowScanNudge(false);
    fetch(
      `${API_BASE_URL}/api/gyms/area-scanned?minLat=${params.minLat}&minLng=${params.minLng}` +
        `&maxLat=${params.maxLat}&maxLng=${params.maxLng}`
    )
      .then((r) => r.json())
      .then((data) => setShowScanNudge(!data.scanned))
      .catch((e) => console.error('Area-scanned check failed', e));
  }, [params.minLat, params.minLng, params.maxLat, params.maxLng]);

  const mergeFreshGyms = (fresh: Gym[]) => {
    setAllGyms((prev) => {
      const byId = new Map((prev ?? []).map((g) => [g.id, g]));
      fresh.forEach((g) => byId.set(g.id, g));
      return Array.from(byId.values());
    });
  };

  // A counter, not a boolean - hover-prefetch and the committed pan-load
  // can overlap (prefetching one spot while actually loading another),
  // and a boolean would flicker false the instant either one resolves
  // even with the other still in flight.
  const [osmLoadingCount, setOsmLoadingCount] = useState(0);
  const bumpOsmLoading = (delta: number) => setOsmLoadingCount((c) => Math.max(0, c + delta));

  const [findingMore, setFindingMore] = useState(false);
  const [findMoreMessage, setFindMoreMessage] = useState<string | null>(null);

  // Scrapes Google Maps for the "gym" category across whatever's
  // currently in view - a different source from Overpass/OSM (what
  // ensureAreaFresh already pulls), so this can genuinely turn up gyms
  // OSM doesn't have. Real latency here: the gym-finding scrape alone is
  // ~15s, but the per-gym price lookups that follow (each a real
  // Anthropic call + web search) run sequentially and can push this past
  // a minute - the loading message says so rather than implying it's
  // quick.
  const findMoreGyms = () => {
    if (!mapBounds || findingMore) return;
    // Clicking IS the thing the nudge was asking for - dismiss
    // immediately rather than waiting on the request to resolve.
    setShowScanNudge(false);
    setFindingMore(true);
    setFindMoreMessage(null);
    fetch(`${API_BASE_URL}/api/gyms/find-more`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minLat: mapBounds.getSouth(),
        minLng: mapBounds.getWest(),
        maxLat: mapBounds.getNorth(),
        maxLng: mapBounds.getEast(),
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data.scrapeFailed) {
          setFindMoreMessage("Couldn't reach Google Maps - try again?");
          return;
        }
        mergeFreshGyms([...data.newGyms, ...(data.updatedGyms ?? [])]);
        const researchNote = data.researchAttempted > 0 ? `, researched ${data.researchAttempted} of them` : '';
        setFindMoreMessage(
          data.newGyms.length > 0 ? `Found ${data.newGyms.length} new gym(s)${researchNote}.` : 'No new gyms found here.'
        );
      })
      .catch((e) => {
        console.error('Find more gyms failed', e);
        setFindMoreMessage("Something went wrong - try again?");
      })
      .finally(() => setFindingMore(false));
  };

  // Blinking "Find more gyms" while the nudge is showing - looped
  // opacity pulse, not a native-driver animation, since this same value
  // also has to work on RN Web where the native driver doesn't exist.
  const nudgeBlink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!showScanNudge) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(nudgeBlink, { toValue: 0.35, duration: 650, useNativeDriver: false }),
        Animated.timing(nudgeBlink, { toValue: 1, duration: 650, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [showScanNudge, nudgeBlink]);

  // Measured, not guessed - a percentage-based arrow position drifts off
  // the real button on different screen sizes (confirmed live on native;
  // fixed here too for the same reason). mapAreaRef is the same
  // position:'relative' ancestor the overlay/arrow are positioned
  // against, so measureLayout against it gives coordinates in that exact
  // space, no extra conversion needed.
  const mapAreaRef = useRef<View>(null);
  const findMoreButtonRef = useRef<any>(null);
  const [findMoreButtonLayout, setFindMoreButtonLayout] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null
  );
  const measureFindMoreButton = () => {
    findMoreButtonRef.current?.measureLayout?.(
      mapAreaRef.current,
      (x: number, y: number, width: number, height: number) => setFindMoreButtonLayout({ x, y, width, height }),
      () => {}
    );
  };

  const loadGyms = () => {
    const url =
      `${API_BASE_URL}/api/gyms/by-area?minLat=${params.minLat}&minLng=${params.minLng}` +
      `&maxLat=${params.maxLat}&maxLng=${params.maxLng}`;
    bumpOsmLoading(1);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        // A failed Overpass refresh with no existing Postgres data to fall
        // back to looks identical to "genuinely zero gyms here" unless we
        // check this explicitly - that's not acceptable for a brand-new
        // area a user is searching for the first time.
        if (data.refreshFailed && data.gyms.length === 0) {
          setError("Couldn't reach OpenStreetMap to look up this area. Try again?");
          return;
        }
        setAreaGyms(data.gyms);
        mergeFreshGyms(data.gyms);
      })
      .catch((e) => {
        console.error('Failed to load area gyms', e);
        setError("Couldn't load gyms for this area. Try again?");
      })
      .finally(() => bumpOsmLoading(-1));
  };

  const loadAllGyms = () => {
    fetch(`${API_BASE_URL}/api/gyms/all`)
      .then((r) => r.json())
      .then((data) => mergeFreshGyms(data.gyms))
      .catch((e) => console.error('Failed to load world gym list', e));
  };

  useEffect(loadGyms, [params.minLat, params.minLng, params.maxLat, params.maxLng]);
  useEffect(loadAllGyms, []);

  const mapGyms = allGyms ?? areaGyms ?? [];

  const hasUnknownCategoryGyms = mapGyms.some((g) => g.categories.length === 0);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleGyms = mapGyms
    .filter((g) => gymMatchesSearch(g, normalizedSearch))
    .filter((g) => !dropInOnly || acceptsDropIn(g))
    .filter((g) => !trialOnly || (g.trial_days != null && g.trial_days > 0))
    .filter(
      (g) =>
        selectedCategories.size === 0 ||
        g.categories.some((c) => selectedCategories.has(c)) ||
        (g.categories.length === 0 && selectedCategories.has(UNKNOWN_CATEGORY))
    );

  // The drop-in price list is meant to reflect what's on screen, not every
  // gym on the planet that has a day-pass price - restrict it to the
  // current viewport now that visibleGyms is world-wide.
  const inViewGyms = mapBounds ? visibleGyms.filter((g) => mapBounds.contains([g.lat, g.lng])) : visibleGyms;

  const confirmedPriceGyms = [...inViewGyms]
    .filter((g) => g.day_pass_price_cents != null)
    .sort((a, b) => a.day_pass_price_cents! - b.day_pass_price_cents!);

  const suggestedPriceGyms = [...inViewGyms]
    .filter((g) => g.day_pass_price_cents == null && g.suggested_day_pass_price_cents != null)
    .sort((a, b) => a.suggested_day_pass_price_cents! - b.suggested_day_pass_price_cents!);

  const startAddingGym = () => {
    setSelectedGym(null);
    setNewGymLocation(null);
    setAddingGym(true);
  };

  const cancelAddingGym = () => {
    setAddingGym(false);
    setNewGymLocation(null);
  };

  const mergeNewGym = (newGym: Gym | null) => {
    if (newGym) mergeFreshGyms([newGym]);
  };

  const showPriceList = dropInOnly && !selectedGym && !newGymLocation;
  const panelOpen = !!selectedGym || !!newGymLocation || showPriceList;

  return (
    <View style={styles.root}>
      <View style={styles.mapArea} ref={mapAreaRef}>
        <MapContainer center={center} zoom={initialZoom} style={styles.map}>
          <MapResize panelOpen={panelOpen} />
          <MapViewSync center={center} zoom={initialZoom} />
          <FlyToGym target={flyTo} />
          <ViewportUrlSync />
          <HoverPrefetch onLoadingChange={bumpOsmLoading} />
          <MapClickHandler
            active={addingGym && !newGymLocation}
            onPick={(lat, lng) => {
              setNewGymLocation({ lat, lng });
              setAddingGym(false);
            }}
          />
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
          <ClusterLayer
            gyms={visibleGyms}
            selectedGymId={selectedGym?.id ?? null}
            onSelectGym={(gym) => {
              cancelAddingGym();
              setSelectedGym(gym);
            }}
            onZoomChange={setZoom}
            onBoundsChange={setMapBounds}
          />
          {newGymLocation && (
            <CircleMarker
              center={[newGymLocation.lat, newGymLocation.lng]}
              radius={8}
              pathOptions={{ color: '#B8860B', fillColor: '#E0A500', fillOpacity: 0.9, dashArray: '2' }}
            >
              <Tooltip direction="top" offset={[0, -6]} permanent>
                New gym (pending)
              </Tooltip>
            </CircleMarker>
          )}
        </MapContainer>

        <Pressable style={styles.backButton} onPress={() => router.push('/GymFinder')}>
          <Text style={styles.backButtonText}>← Search again</Text>
        </Pressable>

        {osmLoadingCount > 0 && (
          <View style={styles.osmLoadingNote} pointerEvents="none">
            <Text style={styles.osmLoadingNoteText}>Finding gyms on OSM…</Text>
          </View>
        )}

        {zoom >= FILTERS_VISIBLE_AT_ZOOM && (
          <View style={styles.searchFilterWrap}>
            <TextInput
              style={styles.searchFilterInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search gyms on screen…"
              placeholderTextColor="#9AA3AB"
            />
            {searchQuery.length > 0 && (
              <Pressable style={styles.searchFilterClear} onPress={() => setSearchQuery('')}>
                <Text style={styles.searchFilterClearText}>✕</Text>
              </Pressable>
            )}
          </View>
        )}

        {zoom >= FILTERS_VISIBLE_AT_ZOOM && (
          <View style={styles.categoryFilterWrap}>
            <Pressable style={styles.categoryFilterButton} onPress={() => setCategoryDropdownOpen((v) => !v)}>
              <Text style={styles.dropInFilterText}>
                Category{selectedCategories.size > 0 ? ` (${selectedCategories.size})` : ''}
              </Text>
              <Text style={styles.categoryFilterChevron}>{categoryDropdownOpen ? '▾' : '▸'}</Text>
            </Pressable>
            {categoryDropdownOpen && (
              <View style={styles.categoryDropdown}>
                {GYM_CATEGORIES.map((cat) => (
                  <Pressable
                    key={cat}
                    style={styles.categoryDropdownRow}
                    onPress={() =>
                      setSelectedCategories((prev) => {
                        const next = new Set(prev);
                        if (next.has(cat)) next.delete(cat);
                        else next.add(cat);
                        return next;
                      })
                    }
                  >
                    <View style={[styles.checkbox, selectedCategories.has(cat) && styles.checkboxChecked]}>
                      {selectedCategories.has(cat) && <Text style={styles.checkboxMark}>✓</Text>}
                    </View>
                    <Text style={styles.categoryDropdownRowText}>{cat}</Text>
                  </Pressable>
                ))}
                {hasUnknownCategoryGyms && (
                  <Pressable
                    style={styles.categoryDropdownRow}
                    onPress={() =>
                      setSelectedCategories((prev) => {
                        const next = new Set(prev);
                        if (next.has(UNKNOWN_CATEGORY)) next.delete(UNKNOWN_CATEGORY);
                        else next.add(UNKNOWN_CATEGORY);
                        return next;
                      })
                    }
                  >
                    <View style={[styles.checkbox, selectedCategories.has(UNKNOWN_CATEGORY) && styles.checkboxChecked]}>
                      {selectedCategories.has(UNKNOWN_CATEGORY) && <Text style={styles.checkboxMark}>✓</Text>}
                    </View>
                    <Text style={styles.categoryDropdownRowText}>Unknown</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        )}

        {zoom >= FILTERS_VISIBLE_AT_ZOOM && (
          <>
            <Pressable
              style={styles.dropInFilter}
              onPress={() => {
                const turningOn = !dropInOnly;
                setDropInOnly(turningOn);
                if (turningOn) {
                  // showPriceList requires !selectedGym && !newGymLocation -
                  // without clearing these, turning the filter on while a
                  // gym's detail panel (or the add-gym flow) is open would
                  // silently do nothing visible, since that panel keeps
                  // occupying the same slot the price list wants.
                  setSelectedGym(null);
                  setAddingGym(false);
                  setNewGymLocation(null);
                }
              }}
            >
              <View style={[styles.checkbox, dropInOnly && styles.checkboxChecked]}>
                {dropInOnly && <Text style={styles.checkboxMark}>✓</Text>}
              </View>
              <Text style={styles.dropInFilterText}>Accepts drop-ins</Text>
            </Pressable>
            <Pressable style={styles.trialFilter} onPress={() => setTrialOnly((v) => !v)}>
              <View style={[styles.checkbox, trialOnly && styles.checkboxChecked]}>
                {trialOnly && <Text style={styles.checkboxMark}>✓</Text>}
              </View>
              <Text style={styles.dropInFilterText}>Has a trial</Text>
            </Pressable>
          </>
        )}
        {!addingGym && !newGymLocation && zoom >= FILTERS_VISIBLE_AT_ZOOM && showScanNudge && (
          <>
            <Pressable style={styles.scanNudgeOverlay} onPress={() => setShowScanNudge(false)} />
            <View style={styles.scanNudgeMessageBox} pointerEvents="none">
              <Text style={styles.scanNudgeMessageText}>
                No one has scanned this area for gyms yet. Click &quot;Find more gyms&quot; for better results.
              </Text>
            </View>
            {findMoreButtonLayout && (
              <Text
                style={[
                  styles.scanNudgeArrow,
                  {
                    top: findMoreButtonLayout.y + findMoreButtonLayout.height + 6,
                    left: findMoreButtonLayout.x + findMoreButtonLayout.width / 2 - 18,
                  },
                ]}
                pointerEvents="none"
              >
                ↑
              </Text>
            )}
          </>
        )}
        {!addingGym && !newGymLocation && (
          <View style={styles.topRightButtons}>
            {zoom >= FILTERS_VISIBLE_AT_ZOOM && (
              <AnimatedPressable
                ref={findMoreButtonRef}
                onLayout={measureFindMoreButton}
                style={[
                  styles.findMoreButton,
                  findingMore && panelStyles.submitButtonDisabled,
                  showScanNudge && { opacity: nudgeBlink },
                ]}
                onPress={findMoreGyms}
              >
                <Text style={styles.addGymButtonText}>{findingMore ? 'Finding…' : 'Find more gyms'}</Text>
              </AnimatedPressable>
            )}
            {zoom >= FILTERS_VISIBLE_AT_ZOOM && (
              <Pressable style={styles.addGymButton} onPress={startAddingGym}>
                <Text style={styles.addGymButtonText}>+ Add a gym</Text>
              </Pressable>
            )}
          </View>
        )}
        {(findingMore || findMoreMessage) && (
          <View style={styles.findMoreMessage}>
            <Text style={styles.findMoreMessageText}>
              {findingMore
                ? 'Our bot has to pretend to be human while it scrapes the internet - this might take a while.'
                : findMoreMessage}
            </Text>
          </View>
        )}
        {addingGym && (
          <View style={styles.placingHint}>
            <Text style={styles.placingHintText}>Click the map to place your gym</Text>
            <Pressable onPress={cancelAddingGym}>
              <Text style={styles.placingHintCancel}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {areaGyms === null && !error && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color="#146C5F" />
            <Text style={styles.overlayTitle}>Finding gyms in {params.name}…</Text>
            <Text style={styles.overlaySubtitle}>
              First look at a new area can take up to 30 seconds while it pulls from OpenStreetMap.
            </Text>
          </View>
        )}
        {error && (
          <View style={styles.overlay}>
            <Text style={styles.overlayTitle}>{error}</Text>
            <Pressable
              style={styles.retryButton}
              onPress={() => {
                setError(null);
                setAreaGyms(null);
                loadGyms();
              }}
            >
              <Text style={styles.retryButtonText}>Try again</Text>
            </Pressable>
          </View>
        )}
      </View>

      {selectedGym && (
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>{selectedGym.name}</Text>
            <View style={styles.panelHeaderActions}>
              {!suggestingEdit && (
                <Pressable onPress={() => setSuggestingEdit(true)}>
                  <Text style={styles.suggestEditLink}>Suggest an edit</Text>
                </Pressable>
              )}
              <Pressable style={styles.panelCloseHit} onPress={() => setSelectedGym(null)}>
                <Text style={styles.panelClose}>✕</Text>
              </Pressable>
            </View>
          </View>
          {suggestingEdit ? (
            <SuggestEditForm
              gym={selectedGym}
              onDone={(updatedGym) => {
                if (updatedGym) {
                  setSelectedGym(updatedGym);
                  mergeFreshGyms([updatedGym]);
                }
              }}
              onCancel={() => setSuggestingEdit(false)}
            />
          ) : (
          <ScrollView style={panelStyles.panelScroll} contentContainerStyle={panelStyles.panelScrollContent}>
            {selectedGym.rating && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Rating</Text>
                <Text style={panelStyles.panelValue}>⭐ {selectedGym.rating}</Text>
              </View>
            )}
            {selectedGym.categories.length > 0 && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Category</Text>
                <Text style={panelStyles.panelValue}>{selectedGym.categories.join(', ')}</Text>
              </View>
            )}
            {selectedGym.description && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Description</Text>
                <Text style={panelStyles.panelValue}>{selectedGym.description}</Text>
              </View>
            )}
            {selectedGym.address && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Address</Text>
                <Text style={panelStyles.panelValue}>{selectedGym.address}</Text>
              </View>
            )}
            {acceptsDropIn(selectedGym) && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Drop-ins</Text>
                <Text style={panelStyles.panelValue}>Yes</Text>
              </View>
            )}
            <TrialSection key={`trial-${selectedGym.id}`} gym={selectedGym} />
            {(formatCents(selectedGym.day_pass_price_cents, fx) ||
              formatCents(selectedGym.week_pass_price_cents, fx) ||
              formatCents(selectedGym.month_pass_price_cents, fx)) && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Pricing</Text>
                {formatCents(selectedGym.day_pass_price_cents, fx) && (
                  <Text style={panelStyles.panelValue}>Day pass: {formatCents(selectedGym.day_pass_price_cents, fx)}</Text>
                )}
                {formatCents(selectedGym.week_pass_price_cents, fx) && (
                  <Text style={panelStyles.panelValue}>Week pass: {formatCents(selectedGym.week_pass_price_cents, fx)}</Text>
                )}
                {formatCents(selectedGym.month_pass_price_cents, fx) && (
                  <Text style={panelStyles.panelValue}>
                    Month pass: {formatCents(selectedGym.month_pass_price_cents, fx)}
                  </Text>
                )}
              </View>
            )}
            <View style={panelStyles.panelRow}>
              <Text style={panelStyles.panelLabel}>Coordinates</Text>
              <Text style={panelStyles.panelValue}>
                {selectedGym.lat.toFixed(5)}, {selectedGym.lng.toFixed(5)}
              </Text>
              <Pressable onPress={() => setFlyTo({ lat: selectedGym.lat, lng: selectedGym.lng })}>
                <Text style={styles.suggestEditLink}>View on map</Text>
              </Pressable>
            </View>
            <ReviewsSection key={`reviews-${selectedGym.id}`} gym={selectedGym} />
            <ChatSection
              key={`chat-${selectedGym.id}`}
              gym={selectedGym}
              onGymUpdated={(updatedGym) => {
                setSelectedGym(updatedGym);
                mergeFreshGyms([updatedGym]);
              }}
            />
          </ScrollView>
          )}
        </View>
      )}
      {showPriceList && (
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Day-pass prices</Text>
            <Pressable style={styles.panelCloseHit} onPress={() => setDropInOnly(false)}>
              <Text style={styles.panelClose}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={panelStyles.panelScroll} contentContainerStyle={panelStyles.panelScrollContent}>
            {confirmedPriceGyms.length === 0 && suggestedPriceGyms.length === 0 ? (
              <Text style={panelStyles.panelValue}>No day-pass pricing found yet, confirmed or unverified.</Text>
            ) : (
              <>
                {confirmedPriceGyms.map((gym) => (
                  <Pressable key={gym.id} style={styles.priceRow} onPress={() => setSelectedGym(gym)}>
                    <Text style={styles.priceRowName}>{gym.name}</Text>
                    <Text style={styles.priceRowPrice}>{formatCents(gym.day_pass_price_cents, fx)}</Text>
                  </Pressable>
                ))}
                {suggestedPriceGyms.length > 0 && (
                  <View style={styles.priceDivider}>
                    <Text style={styles.priceDividerText}>Unverified — based on reviews</Text>
                  </View>
                )}
                {suggestedPriceGyms.map((gym) => (
                  <Pressable key={gym.id} style={styles.priceRow} onPress={() => setSelectedGym(gym)}>
                    <Text style={styles.priceRowName}>{gym.name}</Text>
                    <Text style={styles.priceRowPriceSuggested}>
                      ~{formatCents(gym.suggested_day_pass_price_cents, fx)}
                    </Text>
                  </Pressable>
                ))}
              </>
            )}
          </ScrollView>
        </View>
      )}
      {newGymLocation && (
        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Add a gym</Text>
            <Pressable style={styles.panelCloseHit} onPress={cancelAddingGym}>
              <Text style={styles.panelClose}>✕</Text>
            </Pressable>
          </View>
          <SubmitGymForm location={newGymLocation} onSubmitted={mergeNewGym} onClose={cancelAddingGym} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // @ts-expect-error - web-only CSS sizing, fine for the demo
  root: { flex: 1, flexDirection: 'row', height: '100vh' },
  mapArea: { flex: 1, position: 'relative' },
  map: { height: '100%', width: '100%' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  backButton: {
    position: 'absolute',
    top: 16,
    left: 16,
    backgroundColor: 'white',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
    zIndex: 1000,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  backButtonText: { fontSize: 13, fontWeight: '600', color: '#1C2430' },
  searchFilterWrap: {
    position: 'absolute',
    top: 56,
    left: 16,
    zIndex: 1000,
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchFilterInput: {
    width: 200,
    backgroundColor: 'white',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    fontSize: 13,
    color: '#1C2430',
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
  },
  searchFilterClear: {
    position: 'absolute',
    right: 10,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  searchFilterClearText: { fontSize: 13, color: '#6B7680' },
  categoryFilterWrap: {
    position: 'absolute',
    top: 96,
    left: 16,
    // Higher than dropInFilter/trialFilter's 1000 - the open dropdown's
    // row list extends down far enough to visually overlap those two
    // buttons underneath it, and with equal z-index the later-in-DOM
    // buttons win hit-testing over the dropdown despite being drawn
    // underneath - caught live via a click on a category row landing on
    // "Accepts drop-ins" instead.
    zIndex: 1100,
  },
  categoryFilterButton: {
    backgroundColor: 'white',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  categoryFilterChevron: { fontSize: 11, color: '#6B7680' },
  categoryDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: 4,
    minWidth: 220,
    maxHeight: 260,
    backgroundColor: 'white',
    borderRadius: 8,
    paddingVertical: 4,
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)' as unknown as undefined,
    // @ts-expect-error - web-only scroll behavior, fine for the demo
    overflowY: 'auto',
  },
  categoryDropdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  categoryDropdownRowText: { fontSize: 13, color: '#1C2430', flex: 1 },
  dropInFilter: {
    position: 'absolute',
    top: 136,
    left: 16,
    backgroundColor: 'white',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
    zIndex: 1000,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  dropInFilterText: { fontSize: 13, color: '#1C2430', fontWeight: '600' },
  trialFilter: {
    position: 'absolute',
    top: 176,
    left: 16,
    backgroundColor: 'white',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
    zIndex: 1000,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#EFEFEF',
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  priceRowName: { fontSize: 14, color: '#1C2430', flex: 1, paddingRight: 8 },
  priceRowPrice: { fontSize: 14, fontWeight: '700', color: '#146C5F' },
  priceRowPriceSuggested: { fontSize: 14, fontWeight: '700', color: '#B8860B' },
  priceDivider: {
    paddingTop: 14,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#DDE2E6',
  },
  priceDividerText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8A94A0',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  topRightButtons: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 1000,
    flexDirection: 'row',
    gap: 8,
  },
  addGymButton: {
    backgroundColor: '#146C5F',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  findMoreButton: {
    backgroundColor: '#1C2430',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  addGymButtonText: { color: 'white', fontWeight: '600', fontSize: 13 },
  // Bottom-left, deliberately quiet - this can fire a lot while panning
  // around, so it's a small ambient note, not an attention-grabbing one
  // like the scan nudge above.
  osmLoadingNote: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    backgroundColor: 'rgba(28, 36, 48, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    zIndex: 900,
  },
  osmLoadingNoteText: { color: 'white', fontSize: 11 },
  findMoreMessage: {
    position: 'absolute',
    top: 56,
    right: 16,
    maxWidth: 220,
    backgroundColor: 'white',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
    zIndex: 999,
  },
  findMoreMessageText: { fontSize: 12, color: '#1C2430' },
  // zIndex sits below topRightButtons (1000) on purpose - the button
  // itself needs to pop out brighter against this dimmed backdrop, not
  // get dimmed along with everything else. A real Pressable (not a
  // decorative View) so clicking anywhere on the map also dismisses the
  // nudge, not just clicking the button itself.
  scanNudgeOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(10, 14, 20, 0.45)',
    zIndex: 950,
  },
  scanNudgeMessageBox: {
    position: 'absolute',
    top: '38%',
    left: '50%',
    transform: [{ translateX: -140 }],
    width: 280,
    backgroundColor: 'white',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 16,
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)' as unknown as undefined,
    zIndex: 960,
  },
  scanNudgeMessageText: { fontSize: 14, color: '#1C2430', textAlign: 'center', lineHeight: 20 },
  // top/left are set inline, measured from the real "Find more gyms"
  // button (findMoreButtonLayout) rather than guessed as a percentage -
  // a percentage drifted off the actual button on a real device.
  scanNudgeArrow: {
    position: 'absolute',
    fontSize: 40,
    color: 'white',
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
    zIndex: 960,
  },
  placingHint: {
    position: 'absolute',
    top: 16,
    right: 16,
    backgroundColor: '#1C2430',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    zIndex: 1000,
  },
  placingHintText: { color: 'white', fontSize: 13 },
  // @ts-expect-error - web-only cursor hint, fine for the demo
  placingHintCancel: { color: '#9AA3AB', fontSize: 13, fontWeight: '600', cursor: 'pointer' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(253,251,247,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    zIndex: 1500,
    paddingHorizontal: 40,
  },
  overlayTitle: { fontSize: 16, fontWeight: '700', color: '#1C2430', textAlign: 'center' },
  overlaySubtitle: { fontSize: 13, color: '#7A6F63', textAlign: 'center' },
  retryButton: {
    backgroundColor: '#146C5F',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 4,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  retryButtonText: { color: 'white', fontWeight: '600', fontSize: 13 },
  panel: {
    width: 320,
    backgroundColor: 'white',
    boxShadow: '-2px 0 8px rgba(0,0,0,0.15)' as unknown as undefined,
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E9EC',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  panelTitle: { fontSize: 18, fontWeight: '700', color: '#1C2430', flex: 1, paddingRight: 8 },
  panelHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  suggestEditLink: { fontSize: 12, fontWeight: '600', color: '#146C5F' },
  // @ts-expect-error - web-only cursor hint, fine for the demo
  panelCloseHit: { cursor: 'pointer', padding: 8 },
  panelClose: { fontSize: 16, color: '#6B7680' },
  editFieldPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  editFieldChip: { borderWidth: 1, borderColor: '#DDE2E6', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  editFieldChipActive: { backgroundColor: '#146C5F', borderColor: '#146C5F' },
  editFieldChipText: { fontSize: 12, color: '#5B6470', fontWeight: '600' },
  editFieldChipTextActive: { color: 'white' },
  panelScroll: { flex: 1 },
  panelScrollContent: { padding: 20, gap: 20 },
  panelRow: { gap: 8 },
  panelLabel: { fontSize: 11, fontWeight: '600', color: '#8A94A0', textTransform: 'uppercase', letterSpacing: 0.5 },
  panelValue: { fontSize: 14, color: '#1C2430', lineHeight: 20 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  sectionChevron: { fontSize: 12, color: '#8A94A0' },
  sectionHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reviewForm: {
    gap: 8,
    backgroundColor: '#F7F8F9',
    borderRadius: 10,
    padding: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#DDE2E6',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    backgroundColor: 'white',
  },
  textarea: { minHeight: 60, textAlignVertical: 'top' },
  ratingPicker: { flexDirection: 'row', gap: 2 },
  // @ts-expect-error - web-only cursor hint, fine for the demo
  starHit: { cursor: 'pointer', padding: 2 },
  star: { fontSize: 18, color: '#D7DBDF' },
  starFilled: { color: '#E0A500' },
  submitButton: {
    backgroundColor: '#146C5F',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitButtonText: { color: 'white', fontWeight: '600', fontSize: 13 },
  reviewCard: {
    gap: 4,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#EFEFEF',
  },
  reviewCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reviewAuthor: { fontSize: 13, fontWeight: '700', color: '#1C2430' },
  reviewStars: { fontSize: 12, color: '#E0A500' },
  chatBox: { gap: 8 },
  chatBubble: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '85%' },
  chatBubbleUser: { backgroundColor: '#146C5F', alignSelf: 'flex-end' },
  chatBubbleAssistant: { backgroundColor: '#F7F8F9', alignSelf: 'flex-start' },
  chatBubbleUserText: { color: 'white', fontSize: 13, lineHeight: 18 },
  chatBubbleAssistantText: { color: '#1C2430', fontSize: 13, lineHeight: 18 },
  chatInputRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  chatInput: { flex: 1 },
  chatInputLarge: { minHeight: 72, textAlignVertical: 'top' },
  chatSendButton: { paddingHorizontal: 16 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#DDE2E6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#146C5F', borderColor: '#146C5F' },
  checkboxMark: { color: 'white', fontSize: 12, fontWeight: '700' },
});

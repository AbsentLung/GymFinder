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
import { useAuth } from '@/auth-context';
import { geohash4TilesCoveringBbox, geohash5TilesCoveringBbox } from '@/geohash';
import {
  type Gym,
  type GymDetails,
  type GymRequest,
  type NewGymLocation,
  GYM_CATEGORIES,
  UNKNOWN_CATEGORY,
  formatPrice,
  isPriceVerified,
  acceptsDropIn,
  gymMatchesSearch,
  pollRequest,
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
              {gym.name} {gym.rating ? `· ⭐ ${gym.rating.toFixed(1)}` : ''}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
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
  const { user, authHeaders } = useAuth();

  // allGyms: every gym this session has loaded via the tiles endpoint,
  // keyed by id and merged in as tiles resolve (API.md 2.2) - the map
  // renders from this, not from any single tile's own response, so
  // panning across tile boundaries just adds to what's already shown
  // instead of replacing it.
  const [allGyms, setAllGyms] = useState<Gym[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGym, setSelectedGym] = useState<Gym | null>(null);
  // Tile-level Gym data (week/month pass, trial details, full
  // description) only arrives once a specific gym's panel opens - the
  // map's tile shape is deliberately lightweight. The panel renders
  // progressively: selectedGym's own fields immediately, then upgrades
  // once selectedGymDetails resolves.
  const [selectedGymDetails, setSelectedGymDetails] = useState<GymDetails | null>(null);
  useEffect(() => {
    setSelectedGymDetails(null);
    if (!selectedGym) return;
    fetch(`${API_BASE_URL}/v1/gyms/${selectedGym.id}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`Gym details failed: ${r.status}`);
        return r.json();
      })
      .then(setSelectedGymDetails)
      .catch((e) => console.error('Failed to load gym details', e));
    // Keyed on the id only, same reasoning as the suggestingEdit-reset
    // effect below - re-fetch when the SELECTED GYM changes, not
    // whenever the tile-level `selectedGym` object gets a new reference
    // from a later mergeFreshGyms call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGym?.id]);
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

  const center: [number, number] = [parseFloat(params.lat), parseFloat(params.lng)];

  const mergeFreshGyms = (fresh: Gym[]) => {
    setAllGyms((prev) => {
      const byId = new Map((prev ?? []).map((g) => [g.id, g]));
      fresh.forEach((g) => byId.set(g.id, g));
      return Array.from(byId.values());
    });
  };

  // A counter, not a boolean - several tiles load in parallel, and a
  // boolean would flicker false the instant any one of them resolves
  // even with others still in flight.
  const [tilesLoadingCount, setTilesLoadingCount] = useState(0);
  const bumpTilesLoading = (delta: number) => setTilesLoadingCount((c) => Math.max(0, c + delta));
  // Tiles already fetched this session, by geohash4 - avoids re-fetching
  // the same tile on every minor pan jitter; "find more gyms" below
  // clears the relevant entries so a fresh sweep's results actually show
  // up on the next load rather than being skipped as "already have
  // this."
  const fetchedTilesRef = useRef(new Set<string>());
  const [showScanNudge, setShowScanNudge] = useState(false);
  // Mirrors allGyms for loadTiles's own closure below, which is called
  // from a useEffect keyed on [mapBounds, zoom] only (deliberately not
  // on every allGyms change, which would re-run this effect on every
  // single merge) - a ref keeps that intentional omission from also
  // meaning a stale read inside the one check that needs the latest
  // value.
  const allGymsRef = useRef<Gym[] | null>(null);
  allGymsRef.current = allGyms;

  const loadTiles = () => {
    if (!mapBounds || zoom < FILTERS_VISIBLE_AT_ZOOM) return;
    const tiles = geohash4TilesCoveringBbox({
      minLat: mapBounds.getSouth(),
      maxLat: mapBounds.getNorth(),
      minLng: mapBounds.getWest(),
      maxLng: mapBounds.getEast(),
    });
    const newTiles = tiles.filter((t) => !fetchedTilesRef.current.has(t));
    if (newTiles.length === 0) return;
    newTiles.forEach((t) => fetchedTilesRef.current.add(t));
    bumpTilesLoading(newTiles.length);
    setError(null);
    Promise.all(
      newTiles.map((tile) =>
        fetch(`${API_BASE_URL}/v1/tiles/${tile}`)
          .then((r) => {
            if (!r.ok) throw new Error(`Tile fetch failed: ${r.status}`);
            return r.json();
          })
          .then((data) => {
            mergeFreshGyms(data.gyms);
            // "No one has scanned this area for gyms yet" - a tile
            // that's never been fetched at all (fetchedAt === null),
            // not merely stale, is the same signal the old demo's
            // separate /api/gyms/area-scanned check was for. No extra
            // request needed now - it's already in this same response.
            if (data.fetchedAt === null) setShowScanNudge(true);
            return true;
          })
          .catch((e) => {
            console.error('Failed to load tile', tile, e);
            fetchedTilesRef.current.delete(tile); // let a retry actually retry
            return false;
          })
          .finally(() => bumpTilesLoading(-1))
      )
    ).then((results) => {
      if (allGymsRef.current === null && results.every((ok) => !ok)) {
        setError("Couldn't load gyms for this area. Try again?");
      }
    });
  };

  useEffect(loadTiles, [mapBounds, zoom]);

  const [findingMore, setFindingMore] = useState(false);
  const [findMoreMessage, setFindMoreMessage] = useState<string | null>(null);

  // One POST /v1/sweeps per geohash5 cell covering the viewport (API.md
  // 2.4's sweep scope cut - a single request only covers one cell), not
  // the old demo's one-call-covers-the-whole-bbox /api/gyms/find-more.
  // Each sweep is async (202 + poll), unlike the old synchronous scrape.
  const findMoreGyms = async () => {
    if (!mapBounds || findingMore) return;
    if (!user) {
      setFindMoreMessage('Sign in to search for more gyms.');
      return;
    }
    // Clicking IS the thing the nudge was asking for - dismiss
    // immediately rather than waiting on the request to resolve.
    setShowScanNudge(false);
    setFindingMore(true);
    setFindMoreMessage(null);
    try {
      const cells = geohash5TilesCoveringBbox({
        minLat: mapBounds.getSouth(),
        maxLat: mapBounds.getNorth(),
        minLng: mapBounds.getWest(),
        maxLng: mapBounds.getEast(),
      });
      const settled = await Promise.all(
        cells.map(async (geohash) =>
          fetch(`${API_BASE_URL}/v1/sweeps`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
            credentials: 'include',
            body: JSON.stringify({ geohash }),
          })
            .then((r) => {
              if (!r.ok) throw new Error(`Sweep failed: ${r.status}`);
              return r.json();
            })
            .then((created: GymRequest) => pollRequest(created.id, authHeaders))
            .catch((e) => {
              console.error('Sweep failed for a cell', e);
              return null;
            })
        )
      );
      const completed = settled.filter((r): r is GymRequest => r != null);
      const totalNew = completed.reduce((sum, r) => sum + ((r.result as { gymsNew?: number } | null)?.gymsNew ?? 0), 0);
      if (completed.length === 0) {
        setFindMoreMessage('Something went wrong - try again?');
      } else {
        setFindMoreMessage(totalNew > 0 ? `Found ${totalNew} new gym(s).` : 'No new gyms found here.');
        cells.forEach((cell) => fetchedTilesRef.current.delete(cell.slice(0, 4)));
        loadTiles();
      }
    } finally {
      setFindingMore(false);
    }
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

  const mapGyms = allGyms ?? [];

  const hasUnknownCategoryGyms = mapGyms.some((g) => g.categories.length === 0);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleGyms = mapGyms
    .filter((g) => gymMatchesSearch(g, normalizedSearch))
    .filter((g) => !dropInOnly || acceptsDropIn(g))
    .filter((g) => !trialOnly || g.hasTrial === true)
    .filter(
      (g) =>
        selectedCategories.size === 0 ||
        g.categories.some((c) => selectedCategories.has(c)) ||
        (g.categories.length === 0 && selectedCategories.has(UNKNOWN_CATEGORY))
    );

  // The drop-in price list is meant to reflect what's on screen, not every
  // gym this session has loaded - restrict it to the current viewport.
  const inViewGyms = mapBounds ? visibleGyms.filter((g) => mapBounds.contains([g.lat, g.lng])) : visibleGyms;

  const confirmedPriceGyms = [...inViewGyms]
    .filter((g) => g.dayPass != null && g.dayPass.verified)
    .sort((a, b) => a.dayPass!.usdCents - b.dayPass!.usdCents);

  const suggestedPriceGyms = [...inViewGyms]
    .filter((g) => g.dayPass != null && !g.dayPass.verified)
    .sort((a, b) => a.dayPass!.usdCents - b.dayPass!.usdCents);

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

        {tilesLoadingCount > 0 && (
          <View style={styles.osmLoadingNote} pointerEvents="none">
            <Text style={styles.osmLoadingNoteText}>Loading gyms…</Text>
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
              {findingMore ? 'Searching Google Maps for gyms in this area - this might take a minute.' : findMoreMessage}
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

        {allGyms === null && !error && (
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
                fetchedTilesRef.current.clear();
                loadTiles();
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
              {!suggestingEdit && selectedGymDetails && (
                <Pressable onPress={() => setSuggestingEdit(true)}>
                  <Text style={styles.suggestEditLink}>Suggest an edit</Text>
                </Pressable>
              )}
              <Pressable style={styles.panelCloseHit} onPress={() => setSelectedGym(null)}>
                <Text style={styles.panelClose}>✕</Text>
              </Pressable>
            </View>
          </View>
          {suggestingEdit && selectedGymDetails ? (
            <SuggestEditForm
              gym={selectedGymDetails}
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
                <Text style={panelStyles.panelValue}>⭐ {selectedGym.rating.toFixed(1)}</Text>
              </View>
            )}
            {selectedGym.categories.length > 0 && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Category</Text>
                <Text style={panelStyles.panelValue}>{selectedGym.categories.join(', ')}</Text>
              </View>
            )}
            {(selectedGymDetails?.description ?? selectedGym.description) && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Description</Text>
                <Text style={panelStyles.panelValue}>{selectedGymDetails?.description ?? selectedGym.description}</Text>
              </View>
            )}
            {selectedGym.address && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Address</Text>
                <Text style={panelStyles.panelValue}>{selectedGym.address}</Text>
              </View>
            )}
            {acceptsDropIn(selectedGymDetails ?? selectedGym) && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Drop-ins</Text>
                <Text style={panelStyles.panelValue}>Yes</Text>
              </View>
            )}
            {selectedGymDetails ? (
              <TrialSection key={`trial-${selectedGymDetails.id}`} gym={selectedGymDetails} />
            ) : (
              <ActivityIndicator size="small" color="#146C5F" />
            )}
            {(() => {
              const dayPass = selectedGymDetails?.prices.find((p) => p.kind === 'day_pass') ?? selectedGym.dayPass;
              const weekPass = selectedGymDetails?.prices.find((p) => p.kind === 'week_pass');
              const monthPass = selectedGymDetails?.prices.find((p) => p.kind === 'month_pass');
              if (!dayPass && !weekPass && !monthPass) return null;
              return (
                <View style={panelStyles.panelRow}>
                  <Text style={panelStyles.panelLabel}>Pricing</Text>
                  {dayPass && (
                    <Text style={panelStyles.panelValue}>
                      Day pass: {formatPrice(dayPass)}{!isPriceVerified(dayPass) && ' (unverified)'}
                    </Text>
                  )}
                  {weekPass && (
                    <Text style={panelStyles.panelValue}>
                      Week pass: {formatPrice(weekPass)}{!isPriceVerified(weekPass) && ' (unverified)'}
                    </Text>
                  )}
                  {monthPass && (
                    <Text style={panelStyles.panelValue}>
                      Month pass: {formatPrice(monthPass)}{!isPriceVerified(monthPass) && ' (unverified)'}
                    </Text>
                  )}
                </View>
              );
            })()}
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
            <ChatSection key={`chat-${selectedGym.id}`} gym={selectedGym} />
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
                    <Text style={styles.priceRowPrice}>{formatPrice(gym.dayPass)}</Text>
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
                      ~{formatPrice(gym.dayPass)}
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

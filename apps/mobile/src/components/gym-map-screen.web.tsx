import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

// Leaflet is DOM-only, so this file only renders on web - see
// gym-map-screen.tsx for native's WebView-wrapped version.
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
  AddressRow,
  ReviewsSection,
  ChatSection,
  SubmitGymForm,
  SuggestEditForm,
  panelStyles,
} from '@/components/gym-panels';

// Below this zoom, amenity filters stop making sense and get hidden.
const FILTERS_VISIBLE_AT_ZOOM = 11;
// How long to wait before rechecking a tile the OSM refresh just started on.
const OSM_RECHECK_DELAY_MS = 30000;

function MapResize({ panelOpen }: { panelOpen: boolean }) {
  const map = useMap();
  useEffect(() => {
    const id = requestAnimationFrame(() => map.invalidateSize());
    return () => cancelAnimationFrame(id);
  }, [panelOpen, map]);
  return null;
}

// MapContainer only reads center/zoom once, on first mount - this is the
// missing setView call for when the route's params change later.
function MapViewSync({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1]]);
  return null;
}

// "View on map" from the detail panel - a fresh object each press so
// this effect re-fires even for the same gym.
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

// Mirrors the viewport into the URL so a pan/zoom survives a refresh.
// history.replaceState, not router.setParams - never re-renders the screen.
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

const ACCENT = '#146C5F';
const TEXT = '#1C2430';
const TEXT_DIM = '#6B7680';
const BORDER = '#DDE2E6';
const PLACEHOLDER_COLOR = '#9AA3AB';
const FONT_SIZE_TINY = 11;
const FONT_SIZE_SMALL = 12;
const FONT_SIZE_BODY = 13;
const FONT_SIZE_LARGE = 14;
const FONT_WEIGHT_SEMIBOLD = '600';
const FONT_WEIGHT_BOLD = '700';

// Only coordinates go through the clustering math - the real gym is
// joined back in by id afterward.
type GymPoint = Supercluster.PointFeature<{ gymId: number }>;

// Plain Pressable can't take an Animated.Value in its style.
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function gymsToPoints(gyms: Gym[]): GymPoint[] {
  return gyms.map((g) => ({
    type: 'Feature',
    properties: { gymId: g.id },
    geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
  }));
}

// Renders gym markers once zoomed in enough; nothing below that zoom,
// rather than aggregate bubbles. Lives inside <MapContainer> to read the
// live viewport via useMap/useMapEvents.
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
    // maxZoom 20, not supercluster's default 16 - a lower tree can still
    // merge two nearby gyms even when queried at "basically unclustered."
    const sc = new Supercluster<{ gymId: number }>({ radius: 60, maxZoom: 20 });
    sc.load(gymsToPoints(gyms));
    return sc;
  }, [gyms]);

  const gymsById = useMemo(() => new Map(gyms.map((g) => [g.id, g])), [gyms]);

  // Below this zoom, nothing renders rather than growing into bubbles.
  if (viewport.zoom < FILTERS_VISIBLE_AT_ZOOM) return null;

  const bbox: [number, number, number, number] = [
    viewport.bounds.getWest(),
    viewport.bounds.getSouth(),
    viewport.bounds.getEast(),
    viewport.bounds.getNorth(),
  ];
  // Always queried at the finest granularity - only merges (near-)
  // identical coordinates, not gyms that are merely close by.
  const clusters = index.getClusters(bbox, 20);

  return (
    <>
      {clusters.map((feature) => {
        const [lng, lat] = feature.geometry.coordinates;
        const { cluster, point_count: pointCount, cluster_id: clusterId, gymId } = feature.properties as any;

        if (cluster) {
          // Rare - two (near-)identical coordinates merged by supercluster.
          const radius = 14 + Math.min(18, Math.log(pointCount) * 6);
          return (
            <CircleMarker
              key={`cluster-${clusterId}`}
              center={[lat, lng]}
              radius={radius}
              pathOptions={{ color: ACCENT, fillColor: ACCENT, fillOpacity: 0.75 }}
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
              color: ACCENT,
              fillColor: gym.id === selectedGymId ? ACCENT : '#3FA393',
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
  const { authHeaders } = useAuth();

  // Every gym loaded this session, keyed by id and merged as tiles
  // resolve - panning across tile boundaries adds to this, not replaces it.
  const [allGyms, setAllGyms] = useState<Gym[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGym, setSelectedGym] = useState<Gym | null>(null);
  // Full details only arrive once a gym's panel opens - renders
  // progressively: selectedGym's fields first, then upgrades on resolve.
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
    // Keyed on id only - re-fetch on SELECTED GYM change, not every
    // mergeFreshGyms reference change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGym?.id]);
  // "View on map" re-centers/zooms without touching selectedGym - the
  // panel doesn't need to close on web (unlike native).
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number } | null>(null);
  const [suggestingEdit, setSuggestingEdit] = useState(false);
  // Resets on any selection change rather than threading a reset into
  // every setSelectedGym call site.
  useEffect(() => setSuggestingEdit(false), [selectedGym?.id]);
  const [addingGym, setAddingGym] = useState(false);
  const [newGymLocation, setNewGymLocation] = useState<NewGymLocation | null>(null);
  const [dropInOnly, setDropInOnly] = useState(false);
  const [trialOnly, setTrialOnly] = useState(false);
  // Filters markers directly on the map, not a separate results list.
  const [searchQuery, setSearchQuery] = useState('');
  // Empty set = no filter applied, same "unchecked means unfiltered"
  // convention as dropInOnly/trialOnly.
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

  // A counter, not a boolean - several tiles load in parallel.
  const [tilesLoadingCount, setTilesLoadingCount] = useState(0);
  const bumpTilesLoading = (delta: number) => setTilesLoadingCount((c) => Math.max(0, c + delta));
  // stale means the OSM refresh runs in the background, after this
  // response - show that separately, then recheck once for its result.
  const [osmRefreshingCount, setOsmRefreshingCount] = useState(0);
  const bumpOsmRefreshing = (delta: number) => setOsmRefreshingCount((c) => Math.max(0, c + delta));
  // Tiles already fetched this session, by geohash4 - "find more gyms"
  // clears the relevant entries so a fresh sweep's results aren't skipped.
  const fetchedTilesRef = useRef(new Set<string>());
  const [showScanNudge, setShowScanNudge] = useState(false);
  // Mirrors allGyms for loadTiles's closure, which only re-runs on
  // [mapBounds, zoom] - a ref avoids a stale read without re-running on
  // every merge.
  const allGymsRef = useRef<Gym[] | null>(null);
  allGymsRef.current = allGyms;

  const loadTiles = (opts?: { suppressNudge?: boolean }) => {
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
        // no-store - the browser's HTTP cache would otherwise serve a
        // stale tile; fetchedTilesRef is a separate, app-level cache.
        fetch(`${API_BASE_URL}/v1/tiles/${tile}`, { cache: 'no-store' })
          .then((r) => {
            if (!r.ok) throw new Error(`Tile fetch failed: ${r.status}`);
            return r.json();
          })
          .then((data) => {
            mergeFreshGyms(data.gyms);
            // A sweep can't cover a whole tile in one click (capped
            // cell count) - don't re-nag right after one just ran.
            if (data.fetchedAt === null && !opts?.suppressNudge) setShowScanNudge(true);
            if (data.stale) {
              bumpOsmRefreshing(1);
              setTimeout(() => {
                fetch(`${API_BASE_URL}/v1/tiles/${tile}`, { cache: 'no-store' })
                  .then((r) => (r.ok ? r.json() : null))
                  .then((refreshed) => refreshed && mergeFreshGyms(refreshed.gyms))
                  .catch(() => {})
                  .finally(() => bumpOsmRefreshing(-1));
              }, OSM_RECHECK_DELAY_MS);
            }
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

  // One POST /v1/sweeps per geohash5 cell covering the viewport, each
  // async (202 + poll).
  const findMoreGyms = async () => {
    if (!mapBounds || findingMore) return;
    // Clicking is what the nudge was asking for - dismiss immediately.
    setShowScanNudge(false);
    setFindingMore(true);
    setFindMoreMessage(null);
    try {
      const bbox = { minLat: mapBounds.getSouth(), maxLat: mapBounds.getNorth(), minLng: mapBounds.getWest(), maxLng: mapBounds.getEast() };
      // One bbox call, not one per cell - the server fans out and caps it.
      const res = await fetch(`${API_BASE_URL}/v1/sweeps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        credentials: 'include',
        body: JSON.stringify({ bbox }),
      });
      if (!res.ok) throw new Error(`Sweep failed: ${res.status}`);
      const { items } = await res.json();
      const settled = await Promise.all(
        items.map((item: { id: string | null; status: string }) =>
          item.id && item.status === 'pending' ? pollRequest(item.id, authHeaders).catch(() => null) : Promise.resolve(item)
        )
      );
      const completed = settled.filter((r): r is GymRequest => r != null);
      if (completed.length === 0) {
        setFindMoreMessage('Something went wrong - try again?');
      } else {
        // Still 'pending' means pollRequest's 60s timeout hit, not "found nothing".
        const stillPending = completed.filter((r) => r.status === 'pending').length;
        const totalNew = completed.reduce((sum, r) => sum + ((r.result as { gymsNew?: number } | null)?.gymsNew ?? 0), 0);
        if (stillPending > 0) {
          setFindMoreMessage(
            totalNew > 0
              ? `Found ${totalNew} new gym(s) so far - ${stillPending} area(s) still scanning. Check My Requests shortly.`
              : `${stillPending} area(s) are still scanning - check My Requests shortly.`
          );
        } else {
          setFindMoreMessage(totalNew > 0 ? `Found ${totalNew} new gym(s).` : 'No new gyms found here.');
        }
        geohash5TilesCoveringBbox(bbox).forEach((cell) => fetchedTilesRef.current.delete(cell.slice(0, 4)));
        loadTiles({ suppressNudge: true });
      }
    } finally {
      setFindingMore(false);
    }
  };

  // Blinking "Find more gyms" while the nudge is showing - no native
  // driver, since this runs on RN Web where it doesn't exist.
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

  // Measured against mapAreaRef, not guessed as a percentage - a percent
  // position drifted off the real button on a real device.
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

  // The drop-in price list reflects what's on screen, not every gym loaded.
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

        {tilesLoadingCount > 0 ? (
          <View style={styles.osmLoadingNote} pointerEvents="none">
            <Text style={styles.osmLoadingNoteText}>Loading gyms…</Text>
          </View>
        ) : (
          osmRefreshingCount > 0 && (
            <View style={styles.osmLoadingNote} pointerEvents="none">
              <Text style={styles.osmLoadingNoteText}>Finding gyms on OpenStreetMap…</Text>
            </View>
          )
        )}

        {zoom >= FILTERS_VISIBLE_AT_ZOOM && (
          <View style={styles.searchFilterWrap}>
            <TextInput
              style={styles.searchFilterInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search gyms on screen…"
              placeholderTextColor={PLACEHOLDER_COLOR}
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
                  // showPriceList requires both cleared, or the panel
                  // keeps occupying the slot the price list wants.
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
            <ActivityIndicator size="large" color={ACCENT} />
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
            <AddressRow address={selectedGymDetails?.address ?? selectedGym.address} place={selectedGymDetails?.place} />
            {acceptsDropIn(selectedGymDetails ?? selectedGym) && (
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Drop-ins</Text>
                <Text style={panelStyles.panelValue}>Yes</Text>
              </View>
            )}
            {selectedGymDetails ? (
              <TrialSection key={`trial-${selectedGymDetails.id}`} gym={selectedGymDetails} />
            ) : (
              <ActivityIndicator size="small" color={ACCENT} />
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
  backButtonText: { fontSize: FONT_SIZE_BODY, fontWeight: FONT_WEIGHT_SEMIBOLD, color: TEXT },
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
    color: TEXT,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
  },
  searchFilterClear: {
    position: 'absolute',
    right: 10,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  searchFilterClearText: { fontSize: FONT_SIZE_BODY, color: TEXT_DIM },
  categoryFilterWrap: {
    position: 'absolute',
    top: 96,
    left: 16,
    // Higher than dropInFilter/trialFilter's 1000, or their later-in-DOM
    // buttons win hit-testing over the open dropdown that overlaps them.
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
  categoryFilterChevron: { fontSize: FONT_SIZE_TINY, color: TEXT_DIM },
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
  categoryDropdownRowText: { fontSize: FONT_SIZE_BODY, color: TEXT, flex: 1 },
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
  dropInFilterText: { fontSize: FONT_SIZE_BODY, color: TEXT, fontWeight: FONT_WEIGHT_SEMIBOLD },
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
  priceRowName: { fontSize: FONT_SIZE_LARGE, color: TEXT, flex: 1, paddingRight: 8 },
  priceRowPrice: { fontSize: FONT_SIZE_LARGE, fontWeight: FONT_WEIGHT_BOLD, color: ACCENT },
  priceRowPriceSuggested: { fontSize: FONT_SIZE_LARGE, fontWeight: FONT_WEIGHT_BOLD, color: '#B8860B' },
  priceDivider: {
    paddingTop: 14,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: BORDER,
  },
  priceDividerText: {
    fontSize: FONT_SIZE_TINY,
    fontWeight: FONT_WEIGHT_SEMIBOLD,
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
    backgroundColor: ACCENT,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  findMoreButton: {
    backgroundColor: TEXT,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)' as unknown as undefined,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  addGymButtonText: { color: 'white', fontWeight: FONT_WEIGHT_SEMIBOLD, fontSize: FONT_SIZE_BODY },
  // Small ambient note, not attention-grabbing - fires a lot while panning.
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
  osmLoadingNoteText: { color: 'white', fontSize: FONT_SIZE_TINY },
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
  findMoreMessageText: { fontSize: FONT_SIZE_SMALL, color: TEXT },
  // zIndex below topRightButtons so the button pops against this dim.
  // A real Pressable so clicking the map also dismisses the nudge.
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
  scanNudgeMessageText: { fontSize: FONT_SIZE_LARGE, color: TEXT, textAlign: 'center', lineHeight: 20 },
  // top/left set inline from the measured findMoreButtonLayout.
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
    backgroundColor: TEXT,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    zIndex: 1000,
  },
  placingHintText: { color: 'white', fontSize: FONT_SIZE_BODY },
  // @ts-expect-error - web-only cursor hint, fine for the demo
  placingHintCancel: { color: PLACEHOLDER_COLOR, fontSize: FONT_SIZE_BODY, fontWeight: FONT_WEIGHT_SEMIBOLD, cursor: 'pointer' },
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
  overlayTitle: { fontSize: 16, fontWeight: FONT_WEIGHT_BOLD, color: TEXT, textAlign: 'center' },
  overlaySubtitle: { fontSize: FONT_SIZE_BODY, color: '#7A6F63', textAlign: 'center' },
  retryButton: {
    backgroundColor: ACCENT,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 4,
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  retryButtonText: { color: 'white', fontWeight: FONT_WEIGHT_SEMIBOLD, fontSize: FONT_SIZE_BODY },
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
  panelTitle: { fontSize: 18, fontWeight: FONT_WEIGHT_BOLD, color: TEXT, flex: 1, paddingRight: 8 },
  panelHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  suggestEditLink: { fontSize: FONT_SIZE_SMALL, fontWeight: FONT_WEIGHT_SEMIBOLD, color: ACCENT },
  // @ts-expect-error - web-only cursor hint, fine for the demo
  panelCloseHit: { cursor: 'pointer', padding: 8 },
  panelClose: { fontSize: 16, color: TEXT_DIM },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: ACCENT, borderColor: ACCENT },
  checkboxMark: { color: 'white', fontSize: FONT_SIZE_SMALL, fontWeight: FONT_WEIGHT_BOLD },
});

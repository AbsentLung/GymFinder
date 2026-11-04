import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
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
import { LEAFLET_WEBVIEW_HTML } from '@/components/leaflet-webview-html';

// Native's version of gym-map-screen.web.tsx - the map is a WebView
// running real Leaflet (react-leaflet crashes on native).
const FILTERS_VISIBLE_AT_ZOOM = 11;

// Plain Pressable can't take an Animated.Value in its style.
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

function boundsContains(bounds: Bounds | null, lat: number, lng: number) {
  if (!bounds) return true;
  return lat <= bounds.north && lat >= bounds.south && lng <= bounds.east && lng >= bounds.west;
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

type GymPoint = Supercluster.PointFeature<{ gymId: number }>;

function gymsToPoints(gyms: Gym[]): GymPoint[] {
  return gyms.map((g) => ({
    type: 'Feature',
    properties: { gymId: g.id },
    geometry: { type: 'Point', coordinates: [g.lng, g.lat] },
  }));
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
  // Applied directly to the panel's own top padding - an absolutely
  // positioned child doesn't inherit ancestor safe-area padding in RN.
  const insets = useSafeAreaInsets();
  const webviewRef = useRef<WebView>(null);
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
  const [webviewReady, setWebviewReady] = useState(false);

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
  const [suggestingEdit, setSuggestingEdit] = useState(false);
  useEffect(() => setSuggestingEdit(false), [selectedGym?.id]);
  // "View on map" hides the panel without clearing selectedGym - the pin
  // highlight needs to survive.
  const [panelHidden, setPanelHidden] = useState(false);
  useEffect(() => setPanelHidden(false), [selectedGym?.id]);
  const [addingGym, setAddingGym] = useState(false);
  const [newGymLocation, setNewGymLocation] = useState<NewGymLocation | null>(null);
  const [dropInOnly, setDropInOnly] = useState(false);
  const [trialOnly, setTrialOnly] = useState(false);
  // Filters markers directly on the map, not a separate results list.
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const initialZoom = params.zoom ? parseFloat(params.zoom) : 12;
  const [zoom, setZoom] = useState(initialZoom);
  // Seeded from the search result's bbox so the first tile fetch doesn't
  // wait on the WebView's first viewportChanged roundtrip.
  const [mapBounds, setMapBounds] = useState<Bounds | null>({
    north: parseFloat(params.maxLat),
    south: parseFloat(params.minLat),
    east: parseFloat(params.maxLng),
    west: parseFloat(params.minLng),
  });

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
  // Tiles already fetched this session, by geohash4 - sweeps clear the
  // relevant entries so a fresh sweep's results aren't skipped as cached.
  const fetchedTilesRef = useRef(new Set<string>());
  const [showScanNudge, setShowScanNudge] = useState(false);
  // Mirrors allGyms for loadTiles's closure, which only re-runs on
  // [mapBounds, zoom] - a ref avoids a stale read without re-running on
  // every merge.
  const allGymsRef = useRef<Gym[] | null>(null);
  allGymsRef.current = allGyms;

  const loadTiles = () => {
    if (!mapBounds || zoom < FILTERS_VISIBLE_AT_ZOOM) return;
    const tiles = geohash4TilesCoveringBbox({ minLat: mapBounds.south, maxLat: mapBounds.north, minLng: mapBounds.west, maxLng: mapBounds.east });
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
            // fetchedAt === null means this tile's never been scanned.
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

  const findMoreGyms = async () => {
    if (!mapBounds || findingMore) return;
    if (!user) {
      setFindMoreMessage('Sign in to search for more gyms.');
      return;
    }
    // Clicking is what the nudge was asking for - dismiss immediately.
    setShowScanNudge(false);
    setFindingMore(true);
    setFindMoreMessage(null);
    try {
      const cells = geohash5TilesCoveringBbox({ minLat: mapBounds.south, maxLat: mapBounds.north, minLng: mapBounds.west, maxLng: mapBounds.east });
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
        // Only clear the swept cells' own tile4s, not every tile on screen.
        cells.forEach((cell) => fetchedTilesRef.current.delete(cell.slice(0, 4)));
        loadTiles();
      }
    } finally {
      setFindingMore(false);
    }
  };

  // Blinking "Find more gyms" while the nudge is showing.
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

  const inViewGyms = mapBounds ? visibleGyms.filter((g) => boundsContains(mapBounds, g.lat, g.lng)) : visibleGyms;
  const confirmedPriceGyms = [...inViewGyms]
    .filter((g) => g.dayPass != null && g.dayPass.verified)
    .sort((a, b) => a.dayPass!.usdCents - b.dayPass!.usdCents);
  const suggestedPriceGyms = [...inViewGyms]
    .filter((g) => g.dayPass != null && !g.dayPass.verified)
    .sort((a, b) => a.dayPass!.usdCents - b.dayPass!.usdCents);

  // Below FILTERS_VISIBLE_AT_ZOOM, pins disappear rather than clustering.
  const clusterIndex = useMemo(() => {
    const sc = new Supercluster<{ gymId: number }>({ radius: 60, maxZoom: 20 });
    sc.load(gymsToPoints(visibleGyms));
    return sc;
  }, [visibleGyms]);
  const gymsById = useMemo(() => new Map(visibleGyms.map((g) => [g.id, g])), [visibleGyms]);

  const markers = useMemo(() => {
    if (!mapBounds || zoom < FILTERS_VISIBLE_AT_ZOOM) return [];
    const bbox: [number, number, number, number] = [mapBounds.west, mapBounds.south, mapBounds.east, mapBounds.north];
    const clusters = clusterIndex.getClusters(bbox, 20);
    return clusters.map((feature) => {
      const [lng, lat] = feature.geometry.coordinates;
      const { cluster, point_count: pointCount, cluster_id: clusterId, gymId } = feature.properties as any;
      if (cluster) {
        const radius = 14 + Math.min(18, Math.log(pointCount) * 6);
        return { id: `cluster-${clusterId}`, clusterId, lat, lng, radius, color: ACCENT, isCluster: true, tooltip: `${pointCount} gyms` };
      }
      const gym = gymsById.get(gymId);
      if (!gym) return null;
      return {
        id: gym.id,
        lat: gym.lat,
        lng: gym.lng,
        radius: 8,
        color: gym.id === selectedGym?.id ? ACCENT : '#3FA393',
        isCluster: false,
        tooltip: `${gym.name}${gym.rating ? ` · ⭐ ${gym.rating.toFixed(1)}` : ''}`,
      };
    }).filter((m): m is NonNullable<typeof m> => m != null);
  }, [clusterIndex, gymsById, mapBounds, zoom, selectedGym?.id]);

  const postToMap = (message: object) => {
    webviewRef.current?.postMessage(JSON.stringify(message));
  };

  useEffect(() => {
    if (webviewReady) postToMap({ type: 'setView', lat: center[0], lng: center[1], zoom: initialZoom });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webviewReady, params.lat, params.lng]);

  useEffect(() => {
    if (webviewReady) postToMap({ type: 'setMarkers', markers });
  }, [webviewReady, markers]);

  useEffect(() => {
    if (webviewReady) postToMap({ type: 'setClickMode', active: addingGym && !newGymLocation });
  }, [webviewReady, addingGym, newGymLocation]);

  useEffect(() => {
    if (webviewReady) postToMap({ type: 'setPendingPin', lat: newGymLocation?.lat ?? null, lng: newGymLocation?.lng ?? null });
  }, [webviewReady, newGymLocation]);

  const handleWebviewMessage = (raw: string) => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      setWebviewReady(true);
    } else if (msg.type === 'markerTap') {
      const gym = gymsById.get(msg.id);
      if (gym) {
        setAddingGym(false);
        setNewGymLocation(null);
        setSelectedGym(gym);
        // Explicit, not left to the selectedGym?.id-keyed reset effect -
        // that effect only fires when the id actually CHANGES, so
        // re-tapping the same (already selected, currently hidden-via-
        // "View on map") pin needs this to actually reopen the panel.
        setPanelHidden(false);
      }
    } else if (msg.type === 'clusterTap') {
      const expansionZoom = Math.min(clusterIndex.getClusterExpansionZoom(msg.clusterId), 18);
      postToMap({ type: 'setView', lat: msg.lat, lng: msg.lng, zoom: expansionZoom });
    } else if (msg.type === 'mapClick') {
      setNewGymLocation({ lat: msg.lat, lng: msg.lng });
      setAddingGym(false);
    } else if (msg.type === 'viewportChanged') {
      setZoom(msg.zoom);
      setMapBounds(msg.bounds);
    }
    // dragPrefetchPoint is still sent by the WebView but no longer
    // handled - the tiles endpoint answers from cache now, no prefetch
    // needed.
  };

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

  // Android back button closes whatever's open (same as the "✕") before
  // falling through to real navigation, one layer at a time.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (suggestingEdit) {
        setSuggestingEdit(false);
        return true;
      }
      if (selectedGym) {
        setSelectedGym(null);
        return true;
      }
      if (newGymLocation) {
        cancelAddingGym();
        return true;
      }
      if (showPriceList) {
        setDropInOnly(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [suggestingEdit, selectedGym, newGymLocation, showPriceList]);

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.mapArea} ref={mapAreaRef}>
        {/* Pre-existing unsuppressable TS2769 - library type-defs gap
            under React 19, not a real error; renders and works fine. */}
        <WebView
          ref={webviewRef}
          originWhitelist={['*']}
          source={{ html: LEAFLET_WEBVIEW_HTML }}
          onMessage={(e: { nativeEvent: { data: string } }) => handleWebviewMessage(e.nativeEvent.data)}
          style={styles.map}
        />

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
              <Text style={styles.dropInFilterText}>Category{selectedCategories.size > 0 ? ` (${selectedCategories.size})` : ''}</Text>
              <Text style={styles.categoryFilterChevron}>{categoryDropdownOpen ? '▾' : '▸'}</Text>
            </Pressable>
            {categoryDropdownOpen && (
              // No ScrollView - nesting one over the WebView is an
              // unreliable touch combo on Android, so this shows unscrolled.
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
                No one has scanned this area for gyms yet. Tap &quot;Find more gyms&quot; for better results.
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
            <Text style={styles.placingHintText}>Tap the map to place your gym</Text>
            <Pressable onPress={cancelAddingGym}>
              <Text style={styles.placingHintCancel}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {allGyms === null && !error && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color={ACCENT} />
            <Text style={styles.overlayTitle}>Finding gyms in {params.name}…</Text>
            <Text style={styles.overlaySubtitle}>First look at a new area can take up to 30 seconds while it pulls from OpenStreetMap.</Text>
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

      {selectedGym && !panelHidden && (
        <KeyboardAvoidingView style={styles.panel} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={[styles.panelHeader, { paddingTop: insets.top + 16 }]}>
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
                    {dayPass && <Text style={panelStyles.panelValue}>Day pass: {formatPrice(dayPass)}{!isPriceVerified(dayPass) && ' (unverified)'}</Text>}
                    {weekPass && <Text style={panelStyles.panelValue}>Week pass: {formatPrice(weekPass)}{!isPriceVerified(weekPass) && ' (unverified)'}</Text>}
                    {monthPass && <Text style={panelStyles.panelValue}>Month pass: {formatPrice(monthPass)}{!isPriceVerified(monthPass) && ' (unverified)'}</Text>}
                  </View>
                );
              })()}
              <View style={panelStyles.panelRow}>
                <Text style={panelStyles.panelLabel}>Coordinates</Text>
                <Text style={panelStyles.panelValue}>
                  {selectedGym.lat.toFixed(5)}, {selectedGym.lng.toFixed(5)}
                </Text>
                <Pressable
                  onPress={() => {
                    postToMap({ type: 'setView', lat: selectedGym.lat, lng: selectedGym.lng, zoom: 16 });
                    // Hides the panel so the map is actually visible to
                    // show the zoom/highlight on - selectedGym itself
                    // stays set, so the pin keeps its highlighted color.
                    setPanelHidden(true);
                  }}
                >
                  <Text style={styles.suggestEditLink}>View on map</Text>
                </Pressable>
              </View>
              <ReviewsSection key={`reviews-${selectedGym.id}`} gym={selectedGym} />
              <ChatSection key={`chat-${selectedGym.id}`} gym={selectedGym} />
            </ScrollView>
          )}
        </KeyboardAvoidingView>
      )}
      {showPriceList && (
        <View style={styles.panel}>
          <View style={[styles.panelHeader, { paddingTop: insets.top + 16 }]}>
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
                    <Text style={styles.priceRowPriceSuggested}>~{formatPrice(gym.dayPass)}</Text>
                  </Pressable>
                ))}
              </>
            )}
          </ScrollView>
        </View>
      )}
      {newGymLocation && (
        <KeyboardAvoidingView style={styles.panel} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={[styles.panelHeader, { paddingTop: insets.top + 16 }]}>
            <Text style={styles.panelTitle}>Add a gym</Text>
            <Pressable style={styles.panelCloseHit} onPress={cancelAddingGym}>
              <Text style={styles.panelClose}>✕</Text>
            </Pressable>
          </View>
          <SubmitGymForm location={newGymLocation} onSubmitted={mergeNewGym} onClose={cancelAddingGym} />
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

// elevation alone is Android-only - covers iOS's shadow* props too.
function shadow(elevation: number) {
  return {
    elevation,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: Math.ceil(elevation / 2) },
    shadowOpacity: 0.15,
    shadowRadius: elevation,
  };
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  mapArea: { flex: 1, position: 'relative' },
  map: { flex: 1 },
  backButton: {
    position: 'absolute',
    top: 16,
    left: 16,
    backgroundColor: 'white',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    ...shadow(3),
    zIndex: 1000,
  },
  backButtonText: { fontSize: FONT_SIZE_BODY, fontWeight: FONT_WEIGHT_SEMIBOLD, color: TEXT },
  searchFilterWrap: { position: 'absolute', top: 56, left: 16, zIndex: 1000, flexDirection: 'row', alignItems: 'center' },
  searchFilterInput: {
    width: 180,
    backgroundColor: 'white',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    fontSize: FONT_SIZE_BODY,
    color: TEXT,
    ...shadow(3),
  },
  searchFilterClear: { position: 'absolute', right: 10 },
  searchFilterClearText: { fontSize: FONT_SIZE_BODY, color: TEXT_DIM },
  categoryFilterWrap: { position: 'absolute', top: 96, left: 16, zIndex: 1100 },
  categoryFilterButton: {
    backgroundColor: 'white',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    ...shadow(3),
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  categoryFilterChevron: { fontSize: FONT_SIZE_TINY, color: TEXT_DIM },
  categoryDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: 4,
    minWidth: 220,
    // Rounded corners still need overflow:hidden to clip row content.
    overflow: 'hidden',
    backgroundColor: 'white',
    borderRadius: 8,
    paddingVertical: 4,
    ...shadow(4),
  },
  categoryDropdownRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 7 },
  categoryDropdownRowText: { fontSize: FONT_SIZE_BODY, color: TEXT, flex: 1 },
  dropInFilter: {
    position: 'absolute',
    top: 136,
    left: 16,
    backgroundColor: 'white',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    ...shadow(3),
    zIndex: 1000,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
    ...shadow(3),
    zIndex: 1000,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#EFEFEF' },
  priceRowName: { fontSize: FONT_SIZE_LARGE, color: TEXT, flex: 1, paddingRight: 8 },
  priceRowPrice: { fontSize: FONT_SIZE_LARGE, fontWeight: FONT_WEIGHT_BOLD, color: ACCENT },
  priceRowPriceSuggested: { fontSize: FONT_SIZE_LARGE, fontWeight: FONT_WEIGHT_BOLD, color: '#B8860B' },
  priceDivider: { paddingTop: 14, marginTop: 4, borderTopWidth: 1, borderTopColor: BORDER },
  priceDividerText: { fontSize: FONT_SIZE_TINY, fontWeight: FONT_WEIGHT_SEMIBOLD, color: '#8A94A0', textTransform: 'uppercase', letterSpacing: 0.5 },
  topRightButtons: { position: 'absolute', top: 16, right: 16, zIndex: 1000, flexDirection: 'row', gap: 8 },
  addGymButton: { backgroundColor: ACCENT, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, ...shadow(3) },
  findMoreButton: { backgroundColor: TEXT, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, ...shadow(3) },
  addGymButtonText: { color: 'white', fontWeight: FONT_WEIGHT_SEMIBOLD, fontSize: FONT_SIZE_BODY },
  findMoreMessage: { position: 'absolute', top: 56, right: 16, maxWidth: 220, backgroundColor: 'white', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, ...shadow(3), zIndex: 999 },
  findMoreMessageText: { fontSize: FONT_SIZE_SMALL, color: TEXT },
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
  // zIndex below topRightButtons so the button pops against this dim.
  // A real Pressable so tapping the map also dismisses the nudge.
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
    ...shadow(6),
    zIndex: 960,
  },
  scanNudgeMessageText: { fontSize: FONT_SIZE_LARGE, color: TEXT, textAlign: 'center', lineHeight: 20 },
  // top/left set inline from the measured findMoreButtonLayout.
  scanNudgeArrow: {
    position: 'absolute',
    fontSize: 40,
    color: 'white',
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
  placingHintCancel: { color: PLACEHOLDER_COLOR, fontSize: FONT_SIZE_BODY, fontWeight: FONT_WEIGHT_SEMIBOLD },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(253,251,247,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    zIndex: 1500,
    paddingHorizontal: 40,
  },
  overlayTitle: { fontSize: 16, fontWeight: FONT_WEIGHT_BOLD, color: TEXT, textAlign: 'center' },
  overlaySubtitle: { fontSize: FONT_SIZE_BODY, color: '#7A6F63', textAlign: 'center' },
  retryButton: { backgroundColor: ACCENT, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10, marginTop: 4 },
  retryButtonText: { color: 'white', fontWeight: FONT_WEIGHT_SEMIBOLD, fontSize: FONT_SIZE_BODY },
  // Full-screen overlay, not a fixed-320px sidebar like the web layout -
  // a phone-width sidebar squeezes the map into an unusable sliver.
  panel: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'white', zIndex: 2000 },
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
  panelCloseHit: { padding: 8 },
  panelClose: { fontSize: 16, color: TEXT_DIM },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: BORDER, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: ACCENT, borderColor: ACCENT },
  checkboxMark: { color: 'white', fontSize: FONT_SIZE_SMALL, fontWeight: FONT_WEIGHT_BOLD },
});

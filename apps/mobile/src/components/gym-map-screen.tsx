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
import { LEAFLET_WEBVIEW_HTML } from '@/components/leaflet-webview-html';

// Native's version of gym-map-screen.web.tsx - same screen, same data and
// filtering logic (copied close to verbatim, none of it was ever Leaflet-
// specific), but the map surface itself is a WebView running the real
// Leaflet map in its own DOM-having context (see leaflet-webview-html.ts)
// instead of react-leaflet directly, which crashes immediately on native
// just from being imported. Clustering runs here in plain TypeScript via
// supercluster directly (it's a pure data-structure library, no DOM
// dependency - safe on native) and the resulting circles get sent to the
// WebView to draw, rather than react-leaflet rendering them as React
// components the way the web version does.
const FILTERS_VISIBLE_AT_ZOOM = 11;

// So the "Find more gyms" button can animate its own opacity for the
// unscanned-area nudge below - plain Pressable can't take an
// Animated.Value in its style.
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
  // Applied directly to the panel's own top padding below, not relied on
  // via the outer SafeAreaView - confirmed live that an absolutely
  // positioned child (the panel) does NOT automatically inherit an
  // ancestor's safe-area padding in React Native the way a normal flex
  // child would; it positions relative to the parent's full bounds,
  // ignoring padding entirely. The outer SafeAreaView still correctly
  // covers the map/button layer underneath, just not this overlay.
  const insets = useSafeAreaInsets();
  const webviewRef = useRef<WebView>(null);
  // Measured, not guessed - a percentage-based arrow position drifts off
  // the real button on different screen sizes (confirmed live: it missed
  // "Find more gyms" entirely on a real device). mapAreaRef is the same
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
  const [webviewReady, setWebviewReady] = useState(false);

  const [areaGyms, setAreaGyms] = useState<Gym[] | null>(null);
  const [allGyms, setAllGyms] = useState<Gym[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGym, setSelectedGym] = useState<Gym | null>(null);
  const [suggestingEdit, setSuggestingEdit] = useState(false);
  useEffect(() => setSuggestingEdit(false), [selectedGym?.id]);
  // "View on map" hides the panel without clearing selectedGym - the pin
  // highlight (driven by selectedGym?.id) needs to survive so there's
  // something to actually see once the map is unobstructed, which
  // setSelectedGym(null) would have erased along with the panel.
  const [panelHidden, setPanelHidden] = useState(false);
  useEffect(() => setPanelHidden(false), [selectedGym?.id]);
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
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const initialZoom = params.zoom ? parseFloat(params.zoom) : 12;
  const [zoom, setZoom] = useState(initialZoom);
  const [mapBounds, setMapBounds] = useState<Bounds | null>(null);
  const [fx, setFx] = useState<FxRate>({ currency: 'USD', rate: 1 });

  const fetchFx = (lat: number, lng: number) => {
    fetch(`${API_BASE_URL}/api/fx?lat=${lat}&lng=${lng}`)
      .then((r) => r.json())
      .then(setFx)
      .catch((e) => console.error('Failed to load FX rate', e));
  };

  useEffect(() => {
    fetchFx(parseFloat(params.lat), parseFloat(params.lng));
  }, [params.lat, params.lng]);

  useEffect(() => {
    if (!mapBounds) return;
    const centerLat = (mapBounds.north + mapBounds.south) / 2;
    const centerLng = (mapBounds.east + mapBounds.west) / 2;
    const id = setTimeout(() => fetchFx(centerLat, centerLng), 500);
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

  // A counter, not a boolean - drag-prefetch and the committed pan-load
  // can overlap (prefetching one spot while actually loading another),
  // and a boolean would flicker false the instant either one resolves
  // even with the other still in flight.
  const [osmLoadingCount, setOsmLoadingCount] = useState(0);
  const bumpOsmLoading = (delta: number) => setOsmLoadingCount((c) => Math.max(0, c + delta));
  // Mobile's answer to the web map's mouse-hover prefetch - there's no
  // hover on a touchscreen, so this fires off dragPrefetchPoint messages
  // the WebView sends continuously while a drag is in progress (see
  // leaflet-webview-html.ts's 'move' listener), using the same grid-cell
  // dedup+fetch helper the web version uses.
  const dragPrefetchedCells = useRef(new Set<string>());

  const [findingMore, setFindingMore] = useState(false);
  const [findMoreMessage, setFindMoreMessage] = useState<string | null>(null);

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
      body: JSON.stringify({ minLat: mapBounds.south, minLng: mapBounds.west, maxLat: mapBounds.north, maxLng: mapBounds.east }),
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
        setFindMoreMessage(data.newGyms.length > 0 ? `Found ${data.newGyms.length} new gym(s)${researchNote}.` : 'No new gyms found here.');
      })
      .catch((e) => {
        console.error('Find more gyms failed', e);
        setFindMoreMessage('Something went wrong - try again?');
      })
      .finally(() => setFindingMore(false));
  };

  // Blinking "Find more gyms" while the nudge is showing - looped
  // opacity pulse via Animated, same mechanism the web file uses.
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

  const loadGyms = () => {
    const url = `${API_BASE_URL}/api/gyms/by-area?minLat=${params.minLat}&minLng=${params.minLng}&maxLat=${params.maxLat}&maxLng=${params.maxLng}`;
    bumpOsmLoading(1);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
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

  const inViewGyms = mapBounds ? visibleGyms.filter((g) => boundsContains(mapBounds, g.lat, g.lng)) : visibleGyms;
  const confirmedPriceGyms = [...inViewGyms].filter((g) => g.day_pass_price_cents != null).sort((a, b) => a.day_pass_price_cents! - b.day_pass_price_cents!);
  const suggestedPriceGyms = [...inViewGyms]
    .filter((g) => g.day_pass_price_cents == null && g.suggested_day_pass_price_cents != null)
    .sort((a, b) => a.suggested_day_pass_price_cents! - b.suggested_day_pass_price_cents!);

  // Below the same zoom the filter chips use as their own cutoff, pins
  // disappear entirely rather than growing into aggregate bubbles - same
  // rule as the web version.
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
        return { id: `cluster-${clusterId}`, clusterId, lat, lng, radius, color: '#146C5F', isCluster: true, tooltip: `${pointCount} gyms` };
      }
      const gym = gymsById.get(gymId);
      if (!gym) return null;
      return {
        id: gym.id,
        lat: gym.lat,
        lng: gym.lng,
        radius: 8,
        color: gym.id === selectedGym?.id ? '#146C5F' : '#3FA393',
        isCluster: false,
        tooltip: `${gym.name}${gym.rating ? ` · ⭐ ${gym.rating}` : ''}`,
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
    } else if (msg.type === 'dragPrefetchPoint') {
      prefetchAreaCell(msg.lat, msg.lng, dragPrefetchedCells.current, bumpOsmLoading);
    }
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

  // Android's hardware/gesture back button defaults to the screen's own
  // back navigation (e.g. back to search) even while a panel is open
  // over the map - per explicit request, it should close whatever's open
  // instead, the same way the on-screen "✕" does, and only fall through
  // to real navigation once nothing's open. Layered one step at a time:
  // cancel an in-progress edit suggestion first, then the panel itself.
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
        {/* react-native-webview's class-component typings don't resolve
            correctly under React 19's stricter ref/JSX typing (same root
            cause, same pre-existing/unsuppressable TS2769 as app-tabs.web.tsx
            elsewhere in this project) - a library type-defs gap, not a
            real type error; this renders and functions correctly. */}
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
              <Text style={styles.dropInFilterText}>Category{selectedCategories.size > 0 ? ` (${selectedCategories.size})` : ''}</Text>
              <Text style={styles.categoryFilterChevron}>{categoryDropdownOpen ? '▾' : '▸'}</Text>
            </Pressable>
            {categoryDropdownOpen && (
              // No ScrollView - a ScrollView nested inside this absolute
              // overlay, which itself sits on top of the WebView's own
              // surface, turned out to be an unreliable touch-handling
              // combination on Android (the two surfaces fighting over
              // the scroll gesture). Showing the full list unscrolled
              // sidesteps the problem entirely rather than chasing a
              // platform quirk further.
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
              {findingMore
                ? 'Our bot has to pretend to be human while it scrapes the internet - this might take a while.'
                : findMoreMessage}
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

        {areaGyms === null && !error && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color="#146C5F" />
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
                setAreaGyms(null);
                loadGyms();
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
                    <Text style={panelStyles.panelValue}>Month pass: {formatCents(selectedGym.month_pass_price_cents, fx)}</Text>
                  )}
                </View>
              )}
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
                    <Text style={styles.priceRowPriceSuggested}>~{formatCents(gym.suggested_day_pass_price_cents, fx)}</Text>
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

// elevation alone is Android-only - silently does nothing on iOS, no
// crash, just a missing shadow. Cheap to cover both from day one rather
// than leave a per-platform gap to notice and patch once iOS actually
// gets built, per explicit request not to need a refactor for that later.
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
  backButtonText: { fontSize: 13, fontWeight: '600', color: '#1C2430' },
  searchFilterWrap: { position: 'absolute', top: 56, left: 16, zIndex: 1000, flexDirection: 'row', alignItems: 'center' },
  searchFilterInput: {
    width: 180,
    backgroundColor: 'white',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    fontSize: 13,
    color: '#1C2430',
    ...shadow(3),
  },
  searchFilterClear: { position: 'absolute', right: 10 },
  searchFilterClearText: { fontSize: 13, color: '#6B7680' },
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
  categoryFilterChevron: { fontSize: 11, color: '#6B7680' },
  categoryDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: 4,
    minWidth: 220,
    // No maxHeight/scroll - see the comment at this dropdown's JSX for
    // why; rounded corners still need overflow:hidden to actually clip
    // square row content to them.
    overflow: 'hidden',
    backgroundColor: 'white',
    borderRadius: 8,
    paddingVertical: 4,
    ...shadow(4),
  },
  categoryDropdownRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 7 },
  categoryDropdownRowText: { fontSize: 13, color: '#1C2430', flex: 1 },
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
  dropInFilterText: { fontSize: 13, color: '#1C2430', fontWeight: '600' },
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
  priceRowName: { fontSize: 14, color: '#1C2430', flex: 1, paddingRight: 8 },
  priceRowPrice: { fontSize: 14, fontWeight: '700', color: '#146C5F' },
  priceRowPriceSuggested: { fontSize: 14, fontWeight: '700', color: '#B8860B' },
  priceDivider: { paddingTop: 14, marginTop: 4, borderTopWidth: 1, borderTopColor: '#DDE2E6' },
  priceDividerText: { fontSize: 11, fontWeight: '600', color: '#8A94A0', textTransform: 'uppercase', letterSpacing: 0.5 },
  topRightButtons: { position: 'absolute', top: 16, right: 16, zIndex: 1000, flexDirection: 'row', gap: 8 },
  addGymButton: { backgroundColor: '#146C5F', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, ...shadow(3) },
  findMoreButton: { backgroundColor: '#1C2430', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, ...shadow(3) },
  addGymButtonText: { color: 'white', fontWeight: '600', fontSize: 13 },
  findMoreMessage: { position: 'absolute', top: 56, right: 16, maxWidth: 220, backgroundColor: 'white', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, ...shadow(3), zIndex: 999 },
  findMoreMessageText: { fontSize: 12, color: '#1C2430' },
  // Bottom-left, deliberately quiet - this can fire a lot while dragging
  // the map around, so it's a small ambient note, not an attention-
  // grabbing one like the scan nudge above.
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
  // zIndex sits below topRightButtons (1000) on purpose - the button
  // itself needs to pop out brighter against this dimmed backdrop, not
  // get dimmed along with everything else. A real Pressable (not a
  // decorative View) so tapping anywhere on the map also dismisses the
  // nudge, not just tapping the button itself.
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
  scanNudgeMessageText: { fontSize: 14, color: '#1C2430', textAlign: 'center', lineHeight: 20 },
  // top/left are set inline, measured from the real "Find more gyms"
  // button (findMoreButtonLayout) rather than guessed as a percentage -
  // a percentage drifted off the actual button on a real device.
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
  placingHintCancel: { color: '#9AA3AB', fontSize: 13, fontWeight: '600' },
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
  overlayTitle: { fontSize: 16, fontWeight: '700', color: '#1C2430', textAlign: 'center' },
  overlaySubtitle: { fontSize: 13, color: '#7A6F63', textAlign: 'center' },
  retryButton: { backgroundColor: '#146C5F', borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10, marginTop: 4 },
  retryButtonText: { color: 'white', fontWeight: '600', fontSize: 13 },
  // Full-screen overlay, not a fixed-320px flex sibling like the web
  // version's side-by-side layout - on a phone-width screen, a fixed
  // 320px sidebar squeezed the map (and everything absolutely positioned
  // over it: filters, back button) into a sliver too narrow to use,
  // overlapping the panel instead of sitting beside it. The panel
  // covering the whole screen when open is the right native pattern
  // here, not a port of the desktop layout.
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
  panelTitle: { fontSize: 18, fontWeight: '700', color: '#1C2430', flex: 1, paddingRight: 8 },
  panelHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  suggestEditLink: { fontSize: 12, fontWeight: '600', color: '#146C5F' },
  panelCloseHit: { padding: 8 },
  panelClose: { fontSize: 16, color: '#6B7680' },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: '#DDE2E6', alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: '#146C5F', borderColor: '#146C5F' },
  checkboxMark: { color: 'white', fontSize: 12, fontWeight: '700' },
});

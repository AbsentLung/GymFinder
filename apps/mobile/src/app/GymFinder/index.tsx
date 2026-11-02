import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';

import { LocationSearch, type LocationResult } from '@/components/location-search';
import { useAuth } from '@/auth-context';

// Wider than LocationSearch's own FALLBACK_RADIUS_DEG (0.05, sized for a
// single landmark/point result) - "near me" is a device GPS fix, closer
// in spirit to a neighborhood-level search than a pinpoint, so it gets a
// bit more room to find gyms around you.
const NEAR_ME_RADIUS_DEG = 0.1;

// Rounded, not raw - a device GPS fix jitters by tens/hundreds of meters
// between calls even standing still, so two "Near me" clicks a minute
// apart produce two slightly different bboxes. The server's
// area-freshness check is an exact containment test (by design - it's
// meant to recognize "this place was already fetched"), so unrounded
// coordinates meant every single click looked like a brand-new area and
// re-triggered a full ~30s+ Overpass fetch even for the same physical
// spot a minute earlier. Caught live: 5 separate fetched_areas rows for
// essentially the same Brooklyn block within 40 minutes. 2 decimal
// places is a ~1.1km grid, small relative to the 0.1° (~11km) search
// radius itself, so this doesn't change what counts as "nearby."
function nearMeResult(rawLat: number, rawLng: number): LocationResult {
  const lat = Math.round(rawLat * 100) / 100;
  const lng = Math.round(rawLng * 100) / 100;
  return {
    name: 'Near me',
    context: '',
    lat,
    lng,
    bbox: {
      minLat: lat - NEAR_ME_RADIUS_DEG,
      maxLat: lat + NEAR_ME_RADIUS_DEG,
      minLng: lng - NEAR_ME_RADIUS_DEG,
      maxLng: lng + NEAR_ME_RADIUS_DEG,
    },
  };
}

// navigator.geolocation doesn't exist on native at all - it's a browser
// API. That's why this used to go straight to the "error" state on
// Android/iOS without ever actually prompting for permission: the
// Platform.OS !== 'web' check short-circuited before anything resembling
// a real permission request happened. expo-location is the real native
// path, and requestForegroundPermissionsAsync is what actually triggers
// the OS's own permission dialog.
function useNearMe(onFound: (result: LocationResult) => void) {
  const [status, setStatus] = useState<'idle' | 'locating' | 'error'>('idle');

  const findNearMe = async () => {
    setStatus('locating');

    if (Platform.OS === 'web') {
      if (!navigator.geolocation) {
        setStatus('error');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setStatus('idle');
          onFound(nearMeResult(pos.coords.latitude, pos.coords.longitude));
        },
        () => setStatus('error'),
        { timeout: 10000 }
      );
      return;
    }

    try {
      const { status: permissionStatus } = await Location.requestForegroundPermissionsAsync();
      if (permissionStatus !== 'granted') {
        setStatus('error');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      setStatus('idle');
      onFound(nearMeResult(pos.coords.latitude, pos.coords.longitude));
    } catch (e) {
      console.error('expo-location failed', e);
      setStatus('error');
    }
  };

  return { status, findNearMe };
}

// "Pulse" - the dark, kinetic direction chosen from the homepage-concepts
// design artifact. Archivo for the headline, IBM Plex Mono for the
// kicker/stats - loaded as Google Fonts, web-only (this app's only real
// target so far; native just falls back to the system font).
const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;900&family=IBM+Plex+Mono:wght@400;500&display=swap';

function useWebFonts() {
  useEffect(() => {
    if (Platform.OS !== 'web' || document.getElementById('pulse-fonts')) return;
    const link = document.createElement('link');
    link.id = 'pulse-fonts';
    link.rel = 'stylesheet';
    link.href = FONTS_HREF;
    document.head.appendChild(link);
  }, []);
}

// A soft radial ping around the "LIVE" dot - Animated rather than a CSS
// keyframe so it's the same code path on web and native, not a web-only
// hack like the dot-grid background below.
function LiveDot() {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale, { toValue: 2.2, duration: 1100, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0, duration: 1100, useNativeDriver: true }),
        ]),
        Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.7, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [scale, opacity]);

  return (
    <View style={styles.liveDotWrap}>
      <Animated.View style={[styles.liveDotRing, { transform: [{ scale }], opacity }]} />
      <View style={styles.liveDotCore} />
    </View>
  );
}

function AccountCorner() {
  const router = useRouter();
  const { user } = useAuth();
  return (
    <View style={styles.accountCorner}>
      {user ? (
        <>
          <Pressable onPress={() => router.push('/profile')}>
            <Text style={styles.accountLink}>{user.name}</Text>
          </Pressable>
          {user.isAdmin && (
            <Pressable onPress={() => router.push('/admin')}>
              <Text style={styles.accountLink}>Admin</Text>
            </Pressable>
          )}
        </>
      ) : (
        <>
          <Pressable onPress={() => router.push('/auth')}>
            <Text style={styles.accountLink}>Log in</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/auth?mode=signup')}>
            <Text style={styles.accountLink}>Sign up</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  useWebFonts();

  const goToMap = (result: LocationResult) => {
    const { bbox } = result;
    router.push(
      `/GymFinder/map?name=${encodeURIComponent(result.name)}&lat=${result.lat}&lng=${result.lng}` +
        `&minLat=${bbox.minLat}&minLng=${bbox.minLng}&maxLat=${bbox.maxLat}&maxLng=${bbox.maxLng}`
    );
  };

  const { status: nearMeStatus, findNearMe } = useNearMe(goToMap);

  return (
    <View style={styles.container}>
      <View style={styles.dotGrid} />
      <AccountCorner />

      <View style={styles.content}>
        <View style={styles.kickerRow}>
          <LiveDot />
          <Text style={styles.kicker}>LIVE · POWERED BY OPENSTREETMAP</Text>
        </View>

        <Text style={styles.title} numberOfLines={1}>
          Train <Text style={styles.titleAccent}>anywhere.</Text>
        </Text>
        {/* eslint-disable-next-line react/jsx-no-comment-textnodes -- this
            renders as literal visible text today ("// Stay fit..."); not
            changing it since that's a visible-behavior call, not a lint
            fix - see chat. */}
        <Text style={styles.subtitle} numberOfLines={1}>
          // Stay fit while you travel - search a city, find a gym drop-in or trial membership.
        </Text>

        <View style={styles.searchWrap}>
          <LocationSearch onSelect={goToMap} variant="dark" />
        </View>

        <Pressable onPress={findNearMe} disabled={nearMeStatus === 'locating'}>
          <Text style={[styles.nearMe, nearMeStatus === 'error' && styles.nearMeError]}>
            {nearMeStatus === 'locating'
              ? 'Locating…'
              : nearMeStatus === 'error'
                ? "Couldn't get your location — search above instead"
                : '📍 Use my current location'}
          </Text>
        </Pressable>

        <View style={styles.stats}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>100K+</Text>
            <Text style={styles.statLabel}>Gyms Tracked</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>190+</Text>
            <Text style={styles.statLabel}>Countries</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>24/7</Text>
            <Text style={styles.statLabel}>Fresh Data</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const ACCENT = '#CEFF45';
const BG = '#111315';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  accountCorner: { position: 'absolute', top: 20, right: 24, flexDirection: 'row', gap: 18, zIndex: 20 },
  accountLink: {
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: 12,
    color: '#A9ADB3',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  // Faint dot-grid texture, fading toward the edges - web-only CSS the RN
  // style resolver passes through verbatim; native just renders a plain
  // dark background instead; see styles.resultDark pattern in
  // location-search.tsx for the equivalent "built for web first" choice
  // already established elsewhere in this screen's flow.
  dotGrid: {
    position: 'absolute',
    inset: 0,
    opacity: Platform.OS === 'web' ? 0.18 : 0,
    // @ts-expect-error - web-only background properties
    backgroundImage: 'radial-gradient(rgba(206,255,69,0.5) 1.4px, transparent 1.4px)',
    // @ts-expect-error - web-only background properties
    backgroundSize: '26px 26px',
    // @ts-expect-error - web-only mask property
    maskImage: 'radial-gradient(ellipse 70% 55% at 50% 45%, black 40%, transparent 85%)',
  },
  content: { width: '100%', maxWidth: 740, paddingHorizontal: 24, gap: 22, alignItems: 'flex-start' },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  liveDotWrap: { width: 8, height: 8, alignItems: 'center', justifyContent: 'center' },
  liveDotRing: { position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: ACCENT },
  liveDotCore: { width: 8, height: 8, borderRadius: 4, backgroundColor: ACCENT },
  kicker: {
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 2,
    color: ACCENT,
    textTransform: 'uppercase',
  },
  title: {
    fontFamily: 'Archivo, sans-serif',
    fontWeight: '900',
    fontSize: 44,
    lineHeight: 46,
    color: '#F4F4F2',
    letterSpacing: -0.5,
  },
  titleAccent: { color: ACCENT },
  subtitle: {
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 20,
    color: '#A9ADB3',
  },
  // zIndex here, not just on LocationSearch's own internal wrap - that one
  // only out-ranks its own siblings. This is the sibling that actually
  // competes with `stats` for stacking order in `content`, and without an
  // explicit zIndex it loses to `stats` on DOM order alone (later wins
  // ties), so the dropdown rendered under the stat numbers.
  searchWrap: { width: '100%', marginTop: 4, zIndex: 10 },
  nearMe: {
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: 13,
    color: '#A9ADB3',
    marginTop: -8,
  },
  nearMeError: { color: '#E9643A' },
  stats: { flexDirection: 'row', gap: 28, marginTop: 8 },
  stat: { alignItems: 'flex-start' },
  statValue: {
    fontFamily: 'Archivo, sans-serif',
    fontWeight: '900',
    fontSize: 22,
    color: ACCENT,
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: 11,
    color: '#777D84',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 2,
  },
});

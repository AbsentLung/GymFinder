import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

// docs/gym-data-design.md: Photon for search-as-you-type. Not Nominatim's
// public server as the PRIMARY search - it's 1 req/sec with no
// autocomplete, disqualifying for that role. It's used below as a
// fallback instead, which is a different bar to clear: it only needs to
// work when Photon doesn't, not feel snappy on every keystroke.
const PHOTON_URL = 'https://photon.komoot.io/api/';
// Confirmed live (verbose curl): DNS resolves fine, TCP connection to
// Photon is refused in ~150ms, while a neighboring service on similar
// hosting connects normally - looks like this app's IP tripped Photon's
// own rate-limiting/abuse prevention after a long session of heavy use,
// not a real Photon outage (their own status page shows it up).
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const DEBOUNCE_MS = 300;

export interface LocationResult {
  name: string;
  context: string;
  lat: number;
  lng: number;
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number };
}

// Not every Photon result has an `extent` (small places often don't) - fall
// back to a fixed box around the point rather than failing to search at all.
const FALLBACK_RADIUS_DEG = 0.05;

function toLocationResult(feature: any): LocationResult {
  const [lng, lat] = feature.geometry.coordinates;
  const p = feature.properties;
  const context = [p.city, p.state, p.country].filter(Boolean).join(', ');

  let bbox;
  if (p.extent) {
    const [minLng, maxLat, maxLng, minLat] = p.extent;
    bbox = { minLat, minLng, maxLat, maxLng };
  } else {
    bbox = {
      minLat: lat - FALLBACK_RADIUS_DEG,
      maxLat: lat + FALLBACK_RADIUS_DEG,
      minLng: lng - FALLBACK_RADIUS_DEG,
      maxLng: lng + FALLBACK_RADIUS_DEG,
    };
  }

  return { name: p.name, context, lat, lng, bbox };
}

async function searchPhoton(query: string): Promise<LocationResult[]> {
  // lang=en - this app's audience is English-speaking travelers; without
  // it Photon returns names in the local script (e.g. "เชียงใหม่" instead
  // of "Chiang Mai").
  const res = await fetch(`${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=5&lang=en`);
  if (!res.ok) throw new Error(`Photon request failed: ${res.status}`);
  const data = await res.json();
  return (data.features || []).map(toLocationResult);
}

// Nominatim's own display_name is "Place, District, Region, Country" -
// first segment is the name, the rest is the same kind of context string
// Photon's city/state/country fields give us. boundingbox comes back as
// [minLat, maxLat, minLng, maxLng] (Nominatim's own order, different from
// Photon's extent order above - easy to get backwards, so named clearly
// here rather than destructured positionally like toLocationResult does).
function toLocationResultFromNominatim(item: any): LocationResult {
  const [nameLabel, ...contextParts] = (item.display_name || '').split(',').map((s: string) => s.trim());
  const [minLat, maxLat, minLng, maxLng] = item.boundingbox.map(Number);
  return {
    name: nameLabel,
    context: contextParts.join(', '),
    lat: Number(item.lat),
    lng: Number(item.lon),
    bbox: { minLat, minLng, maxLat, maxLng },
  };
}

async function searchNominatim(query: string): Promise<LocationResult[]> {
  const res = await fetch(
    `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=jsonv2&limit=5&accept-language=en`,
    // Nominatim's usage policy requires a real User-Agent identifying the
    // app - same one already used for Overpass elsewhere in this project.
    { headers: { 'User-Agent': 'TravelApp-GymFinder-Demo/1.0 (hackathon demo)' } }
  );
  if (!res.ok) throw new Error(`Nominatim request failed: ${res.status}`);
  const data = await res.json();
  return (data || []).map(toLocationResultFromNominatim);
}

export function LocationSearch({
  onSelect,
  variant = 'light',
}: {
  onSelect: (result: LocationResult) => void;
  variant?: 'light' | 'dark';
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LocationResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Measured, not a CSS-style percentage - dropdown's `top: '100%'` was
  // real CSS that React Native Web happily turns into actual CSS, but
  // React Native's native layout engine (Yoga) doesn't reliably resolve
  // percentage position offsets the same way, especially with no
  // explicit height on the parent (`wrap` here is just however tall its
  // children make it). That's why this worked on web and not on Android.
  const [inputRowHeight, setInputRowHeight] = useState(48);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        setResults(await searchPhoton(query));
      } catch (photonError) {
        console.error('Photon search failed, falling back to Nominatim', photonError);
        try {
          setResults(await searchNominatim(query));
        } catch (nominatimError) {
          console.error('Nominatim fallback also failed', nominatimError);
          setResults([]);
        }
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const dark = variant === 'dark';

  return (
    <View style={styles.wrap}>
      <View
        style={[styles.inputRow, dark && styles.inputRowDark]}
        onLayout={(e) => setInputRowHeight(e.nativeEvent.layout.height)}
      >
        <TextInput
          style={[styles.input, dark && styles.inputDark]}
          value={query}
          onChangeText={setQuery}
          placeholder="Search any city or area…"
          placeholderTextColor={dark ? '#6C7177' : '#9AA3AB'}
        />
        {loading && <ActivityIndicator size="small" color={dark ? '#CEFF45' : '#146C5F'} style={styles.spinner} />}
      </View>
      {results.length > 0 && (
        <View style={[styles.dropdown, { top: inputRowHeight + 4 }, dark && styles.dropdownDark]}>
          {results.map((r, i) => (
            <Pressable
              key={i}
              style={[styles.resultRow, dark && styles.resultRowDark]}
              onPress={() => {
                onSelect(r);
                setQuery('');
                setResults([]);
              }}
            >
              <Text style={[styles.resultName, dark && styles.resultNameDark]}>{r.name}</Text>
              {r.context && <Text style={[styles.resultContext, dark && styles.resultContextDark]}>{r.context}</Text>}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', zIndex: 1000 },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#DDE2E6',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: 'white',
  },
  spinner: { position: 'absolute', right: 14 },
  dropdown: {
    // top set inline via the measured inputRowHeight instead - see the
    // comment by its state declaration above.
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: 'white',
    borderRadius: 10,
    marginTop: 4,
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)' as unknown as undefined,
    overflow: 'hidden',
  },
  resultRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  resultName: { fontSize: 14, fontWeight: '600', color: '#1C2430' },
  resultContext: { fontSize: 12, color: '#7A6F63', marginTop: 2 },
  // "Pulse" homepage theme - dark shell, lime focus accent, matches the
  // chosen design in the homepage-concepts artifact.
  inputRowDark: {},
  inputDark: {
    backgroundColor: '#1B1E21',
    borderColor: '#2C3034',
    color: '#F4F4F2',
  },
  dropdownDark: {
    backgroundColor: '#1B1E21',
    boxShadow: '0 4px 20px rgba(0,0,0,0.5)' as unknown as undefined,
  },
  resultRowDark: {
    borderBottomColor: '#2C3034',
  },
  resultNameDark: { color: '#F4F4F2' },
  resultContextDark: { color: '#9AA3AB' },
});

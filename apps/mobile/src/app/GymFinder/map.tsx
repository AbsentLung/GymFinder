// Dynamic import, not a top-level re-export - Expo's route table builder
// requires() every route eagerly, which would pull in Leaflet (crashes
// on `window` outside a browser). useEffect defers it past that.
import { useEffect, useState, type ComponentType } from 'react';
import { View } from 'react-native';

export default function MapRoute() {
  const [Screen, setScreen] = useState<ComponentType | null>(null);
  useEffect(() => {
    import('@/components/gym-map-screen').then((mod) => setScreen(() => mod.default));
  }, []);
  if (!Screen) return <View style={{ flex: 1 }} />;
  return <Screen />;
}

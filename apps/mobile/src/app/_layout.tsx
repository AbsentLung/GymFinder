import { DarkTheme, DefaultTheme, Slot, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider } from '@/auth-context';

SplashScreen.preventAutoHideAsync();

// Hackathon demo: every screen so far is full-bleed custom UI (world map,
// Bali gym map) with nowhere for the starter template's tab bar to live, so
// we route straight through instead of wrapping in AppTabs.
export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    // SafeAreaProvider has to wrap the app somewhere above any
    // SafeAreaView/useSafeAreaInsets usage - without it those have no
    // real inset data to read, so they apply zero padding rather than
    // erroring, which is why gym-map-screen.tsx's earlier SafeAreaView
    // fix had no visible effect at all on a real device.
    <SafeAreaProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AuthProvider>
          <AnimatedSplashOverlay />
          <Slot />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

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
    // Must wrap the app above any SafeAreaView/useSafeAreaInsets usage.
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

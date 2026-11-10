// localhost only works on web/iOS Simulator - Android needs the real
// host Metro served from. Override with EXPO_PUBLIC_API_URL if needed.
import Constants from 'expo-constants';

const devHost = Constants.expoConfig?.hostUri?.split(':')[0];

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || (devHost ? `http://${devHost}:3001` : 'http://localhost:3001');

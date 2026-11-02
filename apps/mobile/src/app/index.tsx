import { Redirect } from 'expo-router';

// The actual home page content (the interactive world map) lives under
// /GymFinder now - it's the first real feature, not the whole app, so it
// gets its own namespace rather than squatting on the root route. Nothing
// else is built yet, so redirect straight there for now.
export default function Index() {
  return <Redirect href="/GymFinder" />;
}

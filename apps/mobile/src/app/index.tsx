import { Redirect } from 'expo-router';

// GymFinder is the first real feature, not the whole app, so it gets
// its own route rather than squatting on root.
export default function Index() {
  return <Redirect href="/GymFinder" />;
}

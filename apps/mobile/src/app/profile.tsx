import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth-context';

// No "apply to be admin" here anymore (API.md decision #8) - admins
// promote users directly (PATCH /v1/admin/users/{id}); the first admin
// is set from the command line.
export default function ProfileScreen() {
  const router = useRouter();
  const { user, loading, signOut } = useAuth();

  if (loading) return <View style={styles.container} />;

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={styles.subtitle}>Sign in to view your profile.</Text>
        <Pressable style={styles.submitButton} onPress={() => router.push('/auth')}>
          <Text style={styles.submitButtonText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{user.name}</Text>
        <Text style={styles.subtitle}>{user.email}</Text>
        {user.isAdmin && <Text style={styles.adminBadge}>Admin</Text>}

        <Pressable style={styles.linkButton} onPress={() => router.push('/my-requests')}>
          <Text style={styles.linkButtonText}>My requests →</Text>
        </Pressable>

        {user.isAdmin && (
          <Pressable style={styles.linkButton} onPress={() => router.push('/admin')}>
            <Text style={styles.linkButtonText}>Go to admin requests →</Text>
          </Pressable>
        )}

        <Pressable style={styles.signOutButton} onPress={signOut}>
          <Text style={styles.signOutButtonText}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const ACCENT = '#CEFF45';
const BG = '#111315';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  card: { width: '100%', maxWidth: 420, gap: 14 },
  title: { fontFamily: 'Archivo, sans-serif', fontWeight: '900', fontSize: 26, color: '#F4F4F2' },
  subtitle: { fontFamily: 'IBM Plex Mono, ui-monospace, monospace', fontSize: 13, color: '#A9ADB3' },
  adminBadge: {
    alignSelf: 'flex-start',
    color: '#111315',
    backgroundColor: ACCENT,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  submitButton: { backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  submitButtonText: { color: '#111315', fontWeight: '700', fontSize: 14 },
  linkButton: { marginTop: 8 },
  linkButtonText: { color: ACCENT, fontSize: 14, fontWeight: '600' },
  signOutButton: { marginTop: 16, alignItems: 'center' },
  signOutButtonText: { color: '#777D84', fontSize: 13 },
});

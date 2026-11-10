import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/auth-context';

export default function ProfileScreen() {
  const router = useRouter();
  const { user, loading, signOut, applyForAdmin } = useAuth();
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const submitAdminApplication = async () => {
    if (submitting || !description.trim()) return;
    setSubmitting(true);
    setError(null);
    const result = await applyForAdmin(description);
    setSubmitting(false);
    if (result.error) setError(result.error);
    else {
      setMessage('Your admin application is pending review.');
      setDescription('');
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{user.name}</Text>
        <Text style={styles.subtitle}>{user.email}</Text>
        {user.isAdmin && <Text style={styles.adminBadge}>Admin</Text>}

        {!user.isAdmin && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Apply to be an admin</Text>
            <Text style={styles.subtitle}>
              Admin applications go to the existing admin team for approval - there&apos;s no automated check, so tell
              them why.
            </Text>
            <TextInput
              style={styles.textarea}
              value={description}
              onChangeText={setDescription}
              placeholder="Why should you be an admin?"
              placeholderTextColor="#6C7177"
              multiline
              numberOfLines={3}
            />
            {message && <Text style={styles.success}>{message}</Text>}
            {error && <Text style={styles.error}>{error}</Text>}
            <Pressable
              style={[styles.submitButton, (submitting || !description.trim()) && styles.submitButtonDisabled]}
              onPress={submitAdminApplication}
            >
              <Text style={styles.submitButtonText}>{submitting ? 'Submitting…' : 'Apply'}</Text>
            </Pressable>
          </View>
        )}

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
  section: { gap: 10, marginTop: 10, borderTopWidth: 1, borderTopColor: '#2C3034', paddingTop: 16 },
  sectionTitle: { color: '#F4F4F2', fontSize: 15, fontWeight: '700' },
  textarea: {
    borderWidth: 1,
    borderColor: '#2C3034',
    backgroundColor: '#1B1E21',
    color: '#F4F4F2',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  success: { color: ACCENT, fontSize: 13 },
  error: { color: '#E9643A', fontSize: 13 },
  submitButton: { backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  submitButtonDisabled: { opacity: 0.5 },
  submitButtonText: { color: '#111315', fontWeight: '700', fontSize: 14 },
  linkButton: { marginTop: 8 },
  linkButtonText: { color: ACCENT, fontSize: 14, fontWeight: '600' },
  signOutButton: { marginTop: 16, alignItems: 'center' },
  signOutButtonText: { color: '#777D84', fontSize: 13 },
});

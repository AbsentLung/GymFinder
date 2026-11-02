import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/auth-context';

// Only email+password works right now - Google/Facebook need real OAuth
// app credentials (client id/secret) registered with each provider plus
// a callback URL pointing at wherever this server runs, neither of which
// exists yet for this demo, so there's no sign-in button for them to wire
// up to yet.
export default function AuthScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const { signUp, signIn } = useAuth();
  // Homepage's separate "Log in"/"Sign up" links land here directly in
  // the right mode via ?mode=signup, rather than always opening to sign-in
  // and making a signup-intending visitor toggle it themselves.
  const [mode, setMode] = useState<'signin' | 'signup'>(params.mode === 'signup' ? 'signup' : 'signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // router.back() doesn't throw when there's nowhere to go back to (e.g.
  // /auth was the very first page loaded in this tab) - it just silently
  // no-ops, leaving the user stranded on the auth screen after a
  // successful sign-in. canGoBack() is the real check.
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result = mode === 'signup' ? await signUp(email, password, name) : await signIn(email, password);
    setSubmitting(false);
    if (result.error) setError(result.error);
    else goBack();
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{mode === 'signup' ? 'Create an account' : 'Sign in'}</Text>
        <Text style={styles.subtitle}>
          {mode === 'signup'
            ? 'Needed to add a gym or suggest an edit.'
            : 'Welcome back.'}
        </Text>

        {mode === 'signup' && (
          <View style={styles.field}>
            <Text style={styles.label}>Name</Text>
            <TextInput style={styles.input} value={name} onChangeText={setName} autoCapitalize="words" />
          </View>
        )}
        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Password</Text>
          <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry />
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={[styles.submitButton, submitting && styles.submitButtonDisabled]} onPress={submit}>
          <Text style={styles.submitButtonText}>
            {submitting ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </Text>
        </Pressable>

        <Pressable onPress={() => setMode(mode === 'signup' ? 'signin' : 'signup')}>
          <Text style={styles.toggle}>
            {mode === 'signup' ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const ACCENT = '#CEFF45';
const BG = '#111315';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, gap: 14 },
  title: { fontFamily: 'Archivo, sans-serif', fontWeight: '900', fontSize: 28, color: '#F4F4F2' },
  subtitle: { fontFamily: 'IBM Plex Mono, ui-monospace, monospace', fontSize: 13, color: '#A9ADB3', marginBottom: 6 },
  field: { gap: 6 },
  label: {
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: 11,
    color: '#777D84',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  input: {
    borderWidth: 1,
    borderColor: '#2C3034',
    backgroundColor: '#1B1E21',
    color: '#F4F4F2',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  error: { color: '#E9643A', fontSize: 13 },
  submitButton: { backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  submitButtonDisabled: { opacity: 0.6 },
  submitButtonText: { color: '#111315', fontWeight: '700', fontSize: 14 },
  toggle: { color: '#A9ADB3', fontSize: 13, textAlign: 'center', marginTop: 4 },
});

import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/auth-context';
import { API_BASE_URL } from '@/config';

// The admin review queue. Typed loosely - a few legacy rows predate
// bot-review.ts's ProposedChange union's `kind` field entirely.
interface ProposedLoose {
  kind?: string;
  [key: string]: unknown;
}

interface AdminChange {
  id: string;
  requestId: string | null;
  gymId: string | null;
  proposed: ProposedLoose;
  currentGym: {
    id: number;
    name: string;
    location: { lat: number; lng: number };
    address: string | null;
    description: string | null;
    categories: string[];
    acceptsDropIn: boolean | null;
    hasTrial: boolean | null;
    status: string;
  } | null;
  locationLabel: string | null;
  evidence: { reason?: string; sourceUrl?: string; foundAmount?: number; foundCurrency?: string } | null;
  reviewStatus: 'pending_bot' | 'awaiting_admin' | 'approved' | 'rejected';
  decidedBy: 'bot' | 'admin' | null;
  createdAt: string;
}

const REVIEW_STATUS_FILTERS: { value: '' | AdminChange['reviewStatus']; label: string }[] = [
  { value: 'awaiting_admin', label: 'Awaiting admin' },
  { value: '', label: 'All' },
  { value: 'pending_bot', label: 'Pending bot' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

// Legacy rows have no `kind` - approving would just surface a raw 500
// server-side, so Approve is disabled for them; Reject still works fine.
function isLegacyProposal(p: ProposedLoose): boolean {
  return p.kind == null;
}

function summarizeProposed(p: ProposedLoose): string {
  if (isLegacyProposal(p)) {
    return `${p.field}: ${p.previousValue ?? '(none)'} → ${p.newValue} (legacy format)`;
  }
  if (p.kind === 'add_gym') return `New gym: "${p.name}"`;
  if (p.kind === 'status') return `Status → ${p.newValue}`;
  if (p.kind === 'price') {
    return `${p.priceKind}: ${p.amountMinor} ${p.currency} (source: ${p.sourceKind}${p.sourceUrl ? `, ${p.sourceUrl}` : ''})`;
  }
  if (p.kind === 'field') {
    const value = Array.isArray(p.newValue) ? p.newValue.join(', ') : String(p.newValue);
    return `${p.field} → ${value}`;
  }
  return JSON.stringify(p);
}

// add_gym proposals have no gymId yet, so their own lat/lng is the only
// location info available; every other kind edits an existing gym.
function changeCoordinates(c: AdminChange): { lat: number; lng: number } | null {
  if (c.currentGym) return c.currentGym.location;
  if (typeof c.proposed.lat === 'number' && typeof c.proposed.lng === 'number') {
    return { lat: c.proposed.lat, lng: c.proposed.lng };
  }
  return null;
}

export default function AdminScreen() {
  const router = useRouter();
  const { user, loading, authHeaders } = useAuth();
  const [reviewStatusFilter, setReviewStatusFilter] = useState<'' | AdminChange['reviewStatus']>('awaiting_admin');
  const [changes, setChanges] = useState<AdminChange[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [promoteId, setPromoteId] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [promoteMessage, setPromoteMessage] = useState<string | null>(null);

  const load = async (cursor?: string) => {
    const params = new URLSearchParams();
    if (reviewStatusFilter) params.set('reviewStatus', reviewStatusFilter);
    if (cursor) params.set('cursor', cursor);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/admin/changes?${params}`, { headers: await authHeaders(), credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to load changes.');
        return;
      }
      setChanges((prev) => (cursor ? [...(prev ?? []), ...data.items] : data.items));
      setNextCursor(data.nextCursor ? String(data.nextCursor) : null);
      setError(null);
    } catch {
      setError('Failed to load changes.');
    }
  };

  useEffect(() => {
    if (user?.isAdmin) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.isAdmin, reviewStatusFilter]);

  const approve = async (id: string) => {
    setActingOn(id);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/admin/changes/${id}/approve`, {
        method: 'POST',
        headers: await authHeaders(),
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Failed to approve.');
      } else {
        await load();
      }
    } finally {
      setActingOn(null);
    }
  };

  const reject = async (id: string) => {
    if (!rejectReason.trim()) return;
    setActingOn(id);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/admin/changes/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        credentials: 'include',
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Failed to reject.');
      } else {
        setRejectingId(null);
        setRejectReason('');
        await load();
      }
    } finally {
      setActingOn(null);
    }
  };

  const promote = async () => {
    const id = parseInt(promoteId, 10);
    if (!Number.isFinite(id) || promoting) return;
    setPromoting(true);
    setPromoteMessage(null);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        credentials: 'include',
        body: JSON.stringify({ role: 'admin' }),
      });
      const data = await res.json();
      setPromoteMessage(res.ok ? `User #${data.id} is now an admin.` : data.error ?? 'Failed to promote.');
      if (res.ok) setPromoteId('');
    } catch {
      setPromoteMessage('Failed to promote.');
    } finally {
      setPromoting(false);
    }
  };

  if (loading) return <View style={styles.container} />;

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={styles.subtitle}>Sign in as an admin to view requests.</Text>
        <Pressable style={styles.submitButton} onPress={() => router.push('/auth')}>
          <Text style={styles.submitButtonText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  if (!user.isAdmin) {
    return (
      <View style={styles.container}>
        <Text style={styles.subtitle}>Admins only.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Admin</Text>

      <View style={styles.promoteRow}>
        <Text style={styles.promoteLabel}>Promote a user to admin (by id):</Text>
        <View style={styles.promoteInputRow}>
          <TextInput
            style={styles.promoteInput}
            value={promoteId}
            onChangeText={setPromoteId}
            placeholder="User id"
            placeholderTextColor={PLACEHOLDER_COLOR}
            keyboardType="numeric"
          />
          <Pressable style={styles.promoteButton} disabled={promoting || !promoteId} onPress={promote}>
            <Text style={styles.promoteButtonText}>{promoting ? 'Promoting…' : 'Promote'}</Text>
          </Pressable>
        </View>
        {promoteMessage && <Text style={styles.subtitle}>{promoteMessage}</Text>}
      </View>

      <Text style={styles.sectionTitle}>Review queue</Text>
      <View style={styles.filterRow}>
        {REVIEW_STATUS_FILTERS.map((f) => (
          <Pressable
            key={f.value}
            style={[styles.chip, reviewStatusFilter === f.value && styles.chipActive]}
            onPress={() => setReviewStatusFilter(f.value)}
          >
            <Text style={[styles.chipText, reviewStatusFilter === f.value && styles.chipTextActive]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {changes?.length === 0 && <Text style={styles.subtitle}>No changes match these filters.</Text>}
        {changes?.map((c) => {
          const coords = changeCoordinates(c);
          return (
          <View key={c.id} style={styles.row}>
            <View style={styles.rowHeader}>
              <Text style={styles.rowType}>{c.gymId ? `Gym #${c.gymId}` : 'New gym'}</Text>
              <Text style={styles.rowStatus}>
                {c.reviewStatus}
                {c.decidedBy ? ` · ${c.decidedBy}` : ''}
              </Text>
            </View>
            <Text style={styles.rowSummary}>{summarizeProposed(c.proposed)}</Text>
            {c.currentGym && (
              <Text style={styles.rowCurrent}>
                Current: {c.currentGym.name} — {c.currentGym.address ?? 'no address on file'}
              </Text>
            )}
            {coords && (
              <Text style={styles.rowCurrent}>
                Coordinates: {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
                {c.locationLabel ? ` — ${c.locationLabel}` : ''}
              </Text>
            )}
            {c.evidence?.reason && <Text style={styles.rowDescription}>Bot/admin note: “{c.evidence.reason}”</Text>}
            <Text style={styles.rowMeta}>{new Date(c.createdAt).toLocaleString()}</Text>

            {c.reviewStatus === 'awaiting_admin' && (
              <>
                {rejectingId === c.id ? (
                  <View style={styles.rejectForm}>
                    <TextInput
                      style={styles.rejectInput}
                      value={rejectReason}
                      onChangeText={setRejectReason}
                      placeholder="Why are you rejecting this?"
                      placeholderTextColor={PLACEHOLDER_COLOR}
                      multiline
                    />
                    <View style={styles.actions}>
                      <Pressable
                        style={[styles.actionButton, styles.denyButton]}
                        disabled={actingOn === c.id || !rejectReason.trim()}
                        onPress={() => reject(c.id)}
                      >
                        <Text style={styles.denyButtonText}>Confirm reject</Text>
                      </Pressable>
                      <Pressable
                        style={styles.cancelButton}
                        onPress={() => {
                          setRejectingId(null);
                          setRejectReason('');
                        }}
                      >
                        <Text style={styles.cancelButtonText}>Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View style={styles.actions}>
                    <Pressable
                      style={[styles.actionButton, styles.approveButton, isLegacyProposal(c.proposed) && styles.actionButtonDisabled]}
                      disabled={actingOn === c.id || isLegacyProposal(c.proposed)}
                      onPress={() => approve(c.id)}
                    >
                      <Text style={styles.approveButtonText}>Approve</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.actionButton, styles.denyButton]}
                      disabled={actingOn === c.id}
                      onPress={() => setRejectingId(c.id)}
                    >
                      <Text style={styles.denyButtonText}>Reject</Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}
          </View>
          );
        })}
        {nextCursor && (
          <Pressable style={styles.loadMoreButton} onPress={() => load(nextCursor)}>
            <Text style={styles.loadMoreButtonText}>Load more</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const ACCENT = '#CEFF45';
const BG = '#111315';
const TEXT = '#F4F4F2';
const TEXT_MUTED = '#A9ADB3';
const TEXT_DIM = '#777D84';
const ERROR = '#E9643A';
const BORDER = '#2C3034';
const PLACEHOLDER_COLOR = '#6C7177';
const FONT_SIZE_TINY = 11;
const FONT_SIZE_SMALL = 12;
const FONT_SIZE_BODY = 13;
const FONT_SIZE_LARGE = 14;
const FONT_WEIGHT_SEMIBOLD = '600';
const FONT_WEIGHT_BOLD = '700';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, padding: 24, gap: 14, alignItems: 'center' },
  title: { fontFamily: 'Archivo, sans-serif', fontWeight: '900', fontSize: 26, color: TEXT, width: '100%', maxWidth: 640 },
  sectionTitle: { color: TEXT, fontSize: 16, fontWeight: FONT_WEIGHT_BOLD, width: '100%', maxWidth: 640, marginTop: 6 },
  subtitle: { fontFamily: 'IBM Plex Mono, ui-monospace, monospace', fontSize: FONT_SIZE_BODY, color: TEXT_MUTED },
  submitButton: { backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20 },
  submitButtonText: { color: BG, fontWeight: FONT_WEIGHT_BOLD, fontSize: FONT_SIZE_LARGE },
  promoteRow: { width: '100%', maxWidth: 640, gap: 8, borderWidth: 1, borderColor: BORDER, borderRadius: 12, padding: 14 },
  promoteLabel: { color: TEXT_MUTED, fontSize: FONT_SIZE_SMALL },
  promoteInputRow: { flexDirection: 'row', gap: 8 },
  promoteInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: '#1B1E21',
    color: TEXT,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: FONT_SIZE_LARGE,
  },
  promoteButton: { backgroundColor: ACCENT, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  promoteButtonText: { color: BG, fontWeight: FONT_WEIGHT_BOLD, fontSize: FONT_SIZE_BODY },
  filterRow: { flexDirection: 'row', gap: 8, width: '100%', maxWidth: 640, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: BORDER, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7 },
  chipActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipText: { color: TEXT_MUTED, fontSize: FONT_SIZE_SMALL, fontWeight: FONT_WEIGHT_SEMIBOLD },
  chipTextActive: { color: BG },
  error: { color: ERROR, fontSize: FONT_SIZE_BODY },
  list: { width: '100%', maxWidth: 640, flex: 1 },
  listContent: { gap: 12, paddingBottom: 24 },
  row: { borderWidth: 1, borderColor: BORDER, borderRadius: 12, padding: 14, gap: 6, backgroundColor: '#1B1E21' },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  rowType: {
    fontFamily: 'IBM Plex Mono, ui-monospace, monospace',
    fontSize: FONT_SIZE_TINY,
    color: ACCENT,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  rowStatus: { fontSize: FONT_SIZE_TINY, color: TEXT_DIM, fontWeight: FONT_WEIGHT_SEMIBOLD },
  rowSummary: { color: TEXT, fontSize: FONT_SIZE_LARGE, fontWeight: FONT_WEIGHT_SEMIBOLD },
  rowCurrent: { color: TEXT_MUTED, fontSize: FONT_SIZE_SMALL },
  rowDescription: { color: TEXT_MUTED, fontSize: FONT_SIZE_BODY, fontStyle: 'italic' },
  rowMeta: { color: PLACEHOLDER_COLOR, fontSize: FONT_SIZE_TINY },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  actionButton: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
  actionButtonDisabled: { opacity: 0.4 },
  approveButton: { backgroundColor: ACCENT },
  approveButtonText: { color: BG, fontWeight: FONT_WEIGHT_BOLD, fontSize: FONT_SIZE_BODY },
  denyButton: { borderWidth: 1, borderColor: ERROR },
  denyButtonText: { color: ERROR, fontWeight: FONT_WEIGHT_BOLD, fontSize: FONT_SIZE_BODY },
  cancelButton: { paddingVertical: 8, paddingHorizontal: 12 },
  cancelButtonText: { color: TEXT_DIM, fontSize: FONT_SIZE_BODY },
  rejectForm: { gap: 8, marginTop: 6 },
  rejectInput: {
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: BG,
    color: TEXT,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: FONT_SIZE_BODY,
    minHeight: 50,
  },
  loadMoreButton: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 20 },
  loadMoreButtonText: { color: ACCENT, fontSize: FONT_SIZE_BODY, fontWeight: FONT_WEIGHT_SEMIBOLD },
});

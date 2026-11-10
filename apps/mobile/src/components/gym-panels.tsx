import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, TextInput, View, ScrollView } from 'react-native';

import { API_BASE_URL } from '@/config';
import { useAuth } from '@/auth-context';

// Shared between gym-map-screen.web.tsx (Leaflet) and gym-map-screen.tsx
// (a WebView wrapping the same Leaflet map, for native) - everything here
// is plain React Native primitives (View/Text/Pressable/TextInput/
// ScrollView) with no DOM/window dependency, so it was always safe to run
// on native; it just used to live inside the web-only file by accident of
// where the map screen was first built. Splitting it out means the chat/
// reviews/edit/add-gym features don't need a second, parallel
// implementation for native - one real bug fix here fixes both platforms.

export interface Gym {
  id: number;
  osm_id: number | null;
  name: string;
  lat: number;
  lng: number;
  rating: string | null;
  description: string | null;
  address: string | null;
  categories: string[];
  accepts_drop_in: boolean | null;
  day_pass_price_cents: number | null;
  week_pass_price_cents: number | null;
  month_pass_price_cents: number | null;
  suggested_day_pass_price_cents: number | null;
  trial_days: number | null;
  trial_details: string | null;
}

export interface FxRate {
  currency: string;
  rate: number;
}

export interface NewGymLocation {
  lat: number;
  lng: number;
}

// Shared by both platforms' "prefetch OSM data ahead of arrival" features
// - web triggers this off mouse hover, native off a map drag in progress
// (there's no hover on a touchscreen, but Leaflet's 'move' event fires
// continuously during a drag too - see leaflet-webview-html.ts). Same
// grid-cell dedup and fire-and-forget fetch either way, so the logic
// only needs writing once. onLoadingChange(+1)/(-1) drives a shared
// "Finding gyms on OSM…" note - a plain counter rather than a boolean so
// overlapping prefetches (hover/drag firing faster than one fetch
// resolves) don't flicker the note on and off.
export const PREFETCH_CELL_DEG = 0.05; // ~5.5km - a loose "neighborhood", not pixel-precise

export function prefetchAreaCell(lat: number, lng: number, prefetchedCells: Set<string>, onLoadingChange: (delta: number) => void) {
  const cellLat = Math.floor(lat / PREFETCH_CELL_DEG);
  const cellLng = Math.floor(lng / PREFETCH_CELL_DEG);
  const cellKey = `${cellLat}:${cellLng}`;
  if (prefetchedCells.has(cellKey)) return;
  prefetchedCells.add(cellKey);
  const minLat = cellLat * PREFETCH_CELL_DEG;
  const minLng = cellLng * PREFETCH_CELL_DEG;
  onLoadingChange(1);
  fetch(
    `${API_BASE_URL}/api/gyms/by-area?minLat=${minLat}&minLng=${minLng}` +
      `&maxLat=${minLat + PREFETCH_CELL_DEG}&maxLng=${minLng + PREFETCH_CELL_DEG}`
  )
    .catch(() => {
      // Fire-and-forget - a failed prefetch just means the real pan's
      // own loadGyms call tries again for real later, same as always.
    })
    .finally(() => onLoadingChange(-1));
}

// Live map-search filter, shared so both platforms match on the exact
// same fields - name, description, address, and categories, not just
// name, per explicit request. Plain case-insensitive substring, not a
// fuzzy/ranked search: this filters which markers are even on screen,
// so "obviously matches or doesn't" beats a relevance score here.
export function gymMatchesSearch(gym: Gym, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const haystack = [gym.name, gym.description, gym.address, ...gym.categories].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(normalizedQuery);
}

// Mirrors GYM_CATEGORIES in server/lib.js exactly - a fixed, generic
// list rather than whatever free-text phrase a scrape happened to
// produce, per explicit request. A gym can have several at once
// (gym_categories is a join table server-side), not just one.
export const GYM_CATEGORIES = [
  'Traditional', 'Group', 'Yoga', 'Bouldering', 'Swimming', 'Luxury', 'MMA', '24hr', 'Outdoor', 'Sports',
  'CrossFit', 'Hyrox', 'HIIT', 'Personal Trainer', 'Pilates',
];

// A gym with zero categories on file still needs to be representable as
// one of the category filter's own checkboxes - this stands in for
// `categories.length === 0` there, never a real category value.
export const UNKNOWN_CATEGORY = '__unknown__';

// Manual symbol/decimals table, not Intl.NumberFormat's style: 'currency'
// - that depends on the JS engine shipping full ICU currency data, and
// this app's web bundle runs on Hermes, which doesn't reliably support
// that for less-common codes. Confirmed live: every currency fix to the
// data flow (FX endpoint, viewport-tracking, etc.) was already correct,
// but display kept silently falling back to literal USD because
// Intl.NumberFormat was throwing every single time and the try/catch
// swallowed it. This has no engine dependency to fail.
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$', THB: '฿', IDR: 'Rp', VND: '₫', PHP: '₱', MYR: 'RM', SGD: 'S$',
  JPY: '¥', KRW: '₩', CNY: '¥', INR: '₹', EUR: '€', GBP: '£', AUD: 'A$',
  NZD: 'NZ$', KHR: '៛', LAK: '₭', MMK: 'K',
};
// Flipped from "most currencies get 2 decimals, a few exceptions get 0"
// to "most get 0, decimals only survive where a single unit is worth
// real money" - gym prices in THB/IDR/etc. are never actually quoted
// down to a fractional unit, decimals there read as fake precision, not
// accuracy. Driven off fx.rate itself (units of local currency per USD)
// rather than a hardcoded currency list, so any currency qualifies the
// same way: 1 unit has to be worth at least 20 cents USD for a decimal
// of it to mean anything for a gym day-pass price. That threshold is
// also why JPY/KRW/VND/THB/IDR etc. fall out automatically without
// needing to be named - they're all weak enough per-unit to fail it.
const MIN_UNIT_VALUE_USD_FOR_DECIMALS = 0.20;

export function formatCents(cents: number | null, fx: FxRate): string | null {
  if (cents == null) return null;
  const localAmount = (cents / 100) * fx.rate;
  const symbol = CURRENCY_SYMBOLS[fx.currency] ?? `${fx.currency} `;
  const unitValueUsd = fx.rate > 0 ? 1 / fx.rate : 0;
  const decimals = unitValueUsd >= MIN_UNIT_VALUE_USD_FOR_DECIMALS ? 2 : 0;
  return `${symbol}${localAmount.toFixed(decimals)}`;
}

// Derived, not a stored field: a day/week/month rate implies drop-ins are
// accepted. This loses the ability to say "confirmed yes, price unknown"
// as distinct from "unknown either way" - a deliberate tradeoff, not an
// oversight. No price means "not known," never "no."
// accepts_drop_in is an explicit override, not the default - most gyms
// are NULL here, meaning "use the derived assumption below." Only gets
// set away from NULL when a source actually contradicts or confirms it
// (e.g. "requires a signup fee before the day rate applies" would set it
// to false even though a price exists) - see recordDropInStatus
// server-side, the one place that writes it.
export function acceptsDropIn(
  gym: Pick<
    Gym,
    'accepts_drop_in' | 'day_pass_price_cents' | 'week_pass_price_cents' | 'month_pass_price_cents' | 'suggested_day_pass_price_cents'
  >
) {
  if (gym.accepts_drop_in != null) return gym.accepts_drop_in;
  // suggested_day_pass_price_cents counts too, not just the confirmed
  // columns - caught live: the chatbot found a day-pass price via web
  // search but (correctly, per its own recency rules) couldn't confirm
  // the source was recent, so it landed in unverified_gym_data instead
  // of the confirmed gyms columns. That's the right call for showing an
  // exact price as fact, but it meant a gym the bot had just confirmed
  // *does* sell day passes still vanished from this filter entirely -
  // too strict a bar for "day rate exists at all," which is already
  // shown elsewhere in the UI with an "unverified" caveat, not as fact.
  return (
    gym.day_pass_price_cents != null ||
    gym.week_pass_price_cents != null ||
    gym.month_pass_price_cents != null ||
    gym.suggested_day_pass_price_cents != null
  );
}

export function formatTrial(days: number | null): string {
  if (days == null) return 'Not known yet';
  if (days === 0) return 'No trial';
  return `${days}-day trial`;
}

export function TrialSection({ gym }: { gym: Gym }) {
  const [expanded, setExpanded] = useState(false);
  if (gym.trial_days == null) return null;
  return (
    <View style={panelStyles.panelRow}>
      <Pressable style={panelStyles.sectionHeader} onPress={() => setExpanded((v) => !v)}>
        <Text style={panelStyles.panelLabel}>Trial</Text>
        <View style={panelStyles.sectionHeaderRight}>
          <Text style={panelStyles.panelValue}>{formatTrial(gym.trial_days)}</Text>
          <Text style={panelStyles.sectionChevron}>{expanded ? '▾' : '▸'}</Text>
        </View>
      </Pressable>
      {expanded && <Text style={panelStyles.panelValue}>{gym.trial_details || 'No details provided'}</Text>}
    </View>
  );
}

interface Review {
  id: number;
  author: string;
  rating: number;
  body: string;
  created_at: string;
}

const RATINGS = [1, 2, 3, 4, 5];

export function ReviewsSection({ gym }: { gym: Gym }) {
  const [expanded, setExpanded] = useState(false);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [author, setAuthor] = useState('');
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadReviews = () => {
    fetch(`${API_BASE_URL}/api/gyms/${gym.id}/reviews`, { cache: 'no-store' })
      .then((r) => r.json())
      .then(setReviews)
      .catch((e) => console.error('Failed to load reviews', e));
  };

  useEffect(loadReviews, [gym.id]);

  const submit = async () => {
    if (!author.trim() || !body.trim() || rating === 0 || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/gyms/${gym.id}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, rating, body }),
      });
      if (!res.ok) throw new Error(`Post review failed: ${res.status}`);
      const created: Review = await res.json();
      setReviews((prev) => [created, ...prev]);
      setAuthor('');
      setBody('');
      setRating(0);
    } catch (e) {
      console.error('Failed to submit review', e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={panelStyles.panelRow}>
      <Pressable style={panelStyles.sectionHeader} onPress={() => setExpanded((v) => !v)}>
        <Text style={panelStyles.panelLabel}>Reviews ({reviews.length})</Text>
        <Text style={panelStyles.sectionChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded && (
        <>
          <View style={panelStyles.reviewForm}>
            <TextInput
              style={panelStyles.input}
              placeholder="Your name"
              placeholderTextColor="#9AA3AB"
              value={author}
              onChangeText={setAuthor}
            />
            <View style={panelStyles.ratingPicker}>
              {RATINGS.map((n) => (
                <Pressable key={n} style={panelStyles.starHit} onPress={() => setRating(n)}>
                  <Text style={[panelStyles.star, n <= rating && panelStyles.starFilled]}>★</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={[panelStyles.input, panelStyles.textarea]}
              placeholder="How was it?"
              placeholderTextColor="#9AA3AB"
              value={body}
              onChangeText={setBody}
              multiline
            />
            <Pressable style={[panelStyles.submitButton, submitting && panelStyles.submitButtonDisabled]} onPress={submit}>
              <Text style={panelStyles.submitButtonText}>{submitting ? 'Posting…' : 'Post review'}</Text>
            </Pressable>
          </View>

          {reviews.length === 0 ? (
            <Text style={panelStyles.panelValue}>No reviews yet — be the first.</Text>
          ) : (
            reviews.map((review) => (
              <View key={review.id} style={panelStyles.reviewCard}>
                <View style={panelStyles.reviewCardHeader}>
                  <Text style={panelStyles.reviewAuthor}>{review.author}</Text>
                  <Text style={panelStyles.reviewStars}>{'★'.repeat(review.rating)}</Text>
                </View>
                <Text style={panelStyles.panelValue}>{review.body}</Text>
              </View>
            ))
          )}
        </>
      )}
    </View>
  );
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Per-gym chat history, kept only for this JS session - module-level, not
// component state, specifically so it survives the panel closing and
// reopening (ChatSection remounts fresh each time via its `key` prop) but
// vanishes the moment the app itself closes, per explicit request: "keep
// it in memory until they close the app, no hard database storing."
const chatHistoryCache = new Map<number, ChatMessage[]>();

// Answers are grounded server-side in whatever's actually on file for this
// gym (description, pricing, trial, reviews), plus live web research the
// server triggers when something's still missing - the model's told to
// say it doesn't know rather than guess at anything not covered otherwise.
// Expanded by default, unlike Trial/Reviews above - this is the thing
// most worth a traveler's immediate attention.
export function ChatSection({ gym, onGymUpdated }: { gym: Gym; onGymUpdated: (updatedGym: Gym) => void }) {
  const [expanded, setExpanded] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatHistoryCache.get(gym.id) ?? []);
  useEffect(() => {
    chatHistoryCache.set(gym.id, messages);
  }, [gym.id, messages]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!input.trim() || sending) return;
    const userMessage: ChatMessage = { role: 'user', content: input.trim() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setSending(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/gyms/${gym.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage.content, history: messages }),
      });
      if (!res.ok) throw new Error(`Chat request failed: ${res.status}`);
      const data = await res.json();
      setMessages([...nextMessages, { role: 'assistant', content: data.reply }]);
      // The chat endpoint re-fetches the gym after any tool call and
      // sends it back for exactly this reason - a price/description/
      // address/category the bot just found is a real write already
      // committed to Postgres, and without merging it in here it
      // wouldn't show up in the sidebar until the panel was closed and
      // reopened.
      if (data.gym) onGymUpdated(data.gym);
    } catch (e) {
      console.error('Chat failed', e);
      setMessages([...nextMessages, { role: 'assistant', content: "Sorry, I couldn't answer that just now — try again?" }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={panelStyles.panelRow}>
      <Pressable style={panelStyles.sectionHeader} onPress={() => setExpanded((v) => !v)}>
        <Text style={panelStyles.panelLabel}>Ask me questions about this gym</Text>
        <Text style={panelStyles.sectionChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded && (
        <View style={panelStyles.chatBox}>
          {messages.map((m, i) => (
            <View key={i} style={[panelStyles.chatBubble, m.role === 'user' ? panelStyles.chatBubbleUser : panelStyles.chatBubbleAssistant]}>
              <Text style={m.role === 'user' ? panelStyles.chatBubbleUserText : panelStyles.chatBubbleAssistantText}>{m.content}</Text>
            </View>
          ))}
          {sending && <Text style={panelStyles.panelValue}>Thinking…</Text>}
          <View style={panelStyles.chatInputRow}>
            <TextInput
              style={[panelStyles.input, panelStyles.chatInput, panelStyles.chatInputLarge]}
              value={input}
              onChangeText={setInput}
              placeholder="Ask about pricing, trials, hours, or anything else that isn't display here. Our bot will do the research for you."
              placeholderTextColor="#9AA3AB"
              multiline
              onSubmitEditing={send}
              // onSubmitEditing above never actually fires on web - RN
              // Web's multiline TextInput renders a real <textarea>, where
              // Enter just inserts a newline like any textarea. Shift+Enter
              // still does that; plain Enter submits instead. Native
              // TextInput does fire onSubmitEditing normally, so this
              // listener is harmless there (web-only nativeEvent shape).
              onKeyPress={(e) => {
                const { key, shiftKey } = e.nativeEvent as unknown as { key?: string; shiftKey?: boolean };
                if (key === 'Enter' && !shiftKey) {
                  (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                  send();
                }
              }}
            />
            <Pressable
              style={[panelStyles.submitButton, panelStyles.chatSendButton, (sending || !input.trim()) && panelStyles.submitButtonDisabled]}
              onPress={send}
            >
              <Text style={panelStyles.submitButtonText}>Send</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

// Deliberately minimal: only the name is ever collected here. Address and
// description get filled in by the bot from Google's own listing once it
// confirms a match. Everything else - pricing, trial, drop-in - only
// arrives later through an edit request, not at creation.
export function SubmitGymForm({
  location,
  onSubmitted,
  onClose,
}: {
  location: NewGymLocation;
  onSubmitted: (newGym: Gym | null) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const { user, authHeaders } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    statusId: number;
    statusLabel: string;
    botReason: string | null;
    gymId: number | null;
  } | null>(null);

  if (!user) {
    return (
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelValue}>Sign in to add a gym.</Text>
        <Pressable style={panelStyles.submitButton} onPress={() => router.push('/auth')}>
          <Text style={panelStyles.submitButtonText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  const submit = async () => {
    if (!name.trim() || !description.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/gyms/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name, lat: location.lat, lng: location.lng, description }),
      });
      if (!res.ok) throw new Error(`Submit gym failed: ${res.status}`);
      const data = await res.json();
      setResult(data);
      // Merge the new pin into live state the moment we know about it -
      // not deferred until the user clicks a specific "Done" button. The
      // panel also has its own "✕" close button; closing via that instead
      // of Done used to silently drop an already-created gym from view
      // until a full page refresh, since only Done used to carry this
      // merge. Decoupling it from any particular button closes that gap
      // regardless of how the panel gets dismissed.
      onSubmitted(
        data.statusId === 3 && data.gymId != null
          ? {
              id: data.gymId,
              osm_id: null,
              // Bot-corrected, not the raw form input - caught live:
              // submitted "Dang Muay Thai", the scrape found the real
              // listing's name, but this used to just echo back what was
              // typed, so the correction didn't show until a refresh
              // re-fetched the real row from Postgres.
              name: data.gymName ?? name,
              lat: location.lat,
              lng: location.lng,
              rating: null,
              description: null,
              address: data.gymAddress ?? null,
              categories: data.categories ?? [],
              accepts_drop_in: null,
              day_pass_price_cents: null,
              week_pass_price_cents: null,
              month_pass_price_cents: null,
              suggested_day_pass_price_cents: null,
              trial_days: null,
              trial_details: null,
            }
          : null
      );
    } catch (e) {
      console.error('Failed to submit gym', e);
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Submitted</Text>
        {result.statusId === 3 ? (
          <Text style={panelStyles.panelValue}>
            Your gym is <Text style={{ fontWeight: '700' }}>live now</Text> — it checked out automatically.
          </Text>
        ) : (
          <Text style={panelStyles.panelValue}>
            This gym is now <Text style={{ fontWeight: '700' }}>{result.statusLabel}</Text>
            {result.botReason ? ` (${result.botReason})` : ''}. An admin will take a look — that can take a few days.
          </Text>
        )}
        <Pressable style={panelStyles.submitButton} onPress={onClose}>
          <Text style={panelStyles.submitButtonText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={panelStyles.panelScroll} contentContainerStyle={panelStyles.panelScrollContent}>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Location</Text>
        <Text style={panelStyles.panelValue}>
          {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
        </Text>
      </View>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Gym name</Text>
        <TextInput style={panelStyles.input} value={name} onChangeText={setName} />
      </View>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Description</Text>
        <TextInput
          style={[panelStyles.input, panelStyles.textarea]}
          value={description}
          onChangeText={setDescription}
          placeholder="Why are you adding this gym?"
          multiline
          numberOfLines={3}
        />
      </View>
      <Pressable
        style={[panelStyles.submitButton, (submitting || !name.trim() || !description.trim()) && panelStyles.submitButtonDisabled]}
        onPress={submit}
      >
        <Text style={panelStyles.submitButtonText}>{submitting ? 'Submitting…' : 'Submit gym'}</Text>
      </Pressable>
    </ScrollView>
  );
}

// Mirrors server/index.js's EDITABLE_FIELDS whitelist - 'kind' just picks
// which input this form shows, the field keys and what they mean live
// there, this is the client-side rendering of the same list.
export const EDITABLE_FIELDS: { key: string; label: string; kind: 'price' | 'number' | 'text' | 'category' }[] = [
  { key: 'day_pass_price_cents', label: 'Day pass price (USD)', kind: 'price' },
  { key: 'week_pass_price_cents', label: 'Week pass price (USD)', kind: 'price' },
  { key: 'month_pass_price_cents', label: 'Month pass price (USD)', kind: 'price' },
  { key: 'description', label: 'Description', kind: 'text' },
  { key: 'address', label: 'Address', kind: 'text' },
  { key: 'category', label: 'Category', kind: 'category' },
  { key: 'trial_days', label: 'Trial days (0 for none)', kind: 'number' },
  { key: 'trial_details', label: 'Trial details', kind: 'text' },
];

export function SuggestEditForm({
  gym,
  onDone,
  onCancel,
}: {
  gym: Gym;
  onDone: (updatedGym: Gym | null) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const { user, authHeaders } = useAuth();
  const [fieldKey, setFieldKey] = useState(EDITABLE_FIELDS[0].key);
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ statusId: number; statusLabel: string; botReason: string | null } | null>(null);

  if (!user) {
    return (
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelValue}>Sign in to suggest an edit.</Text>
        <Pressable style={panelStyles.submitButton} onPress={() => router.push('/auth')}>
          <Text style={panelStyles.submitButtonText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }

  const field = EDITABLE_FIELDS.find((f) => f.key === fieldKey)!;

  const submit = async () => {
    if (!value.trim() || !description.trim() || submitting) return;
    const newValue = field.kind === 'price' ? Math.round(parseFloat(value) * 100) : field.kind === 'number' ? parseInt(value, 10) : value;
    if ((field.kind === 'price' || field.kind === 'number') && !Number.isFinite(newValue)) return;

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/gyms/${gym.id}/edit-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ field: field.key, newValue, description }),
      });
      if (!res.ok) throw new Error(`Edit request failed: ${res.status}`);
      const data = await res.json();
      setResult(data);
      onDone(data.statusId === 3 && data.gym ? data.gym : null);
    } catch (e) {
      console.error('Failed to submit edit request', e);
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Submitted</Text>
        {result.statusId === 3 ? (
          <Text style={panelStyles.panelValue}>
            Confirmed — <Text style={{ fontWeight: '700' }}>{field.label}</Text> updated right away.
          </Text>
        ) : (
          <Text style={panelStyles.panelValue}>
            This edit is now <Text style={{ fontWeight: '700' }}>{result.statusLabel}</Text>
            {result.botReason ? ` (${result.botReason})` : ''}. An admin will take a look.
          </Text>
        )}
        <Pressable style={panelStyles.submitButton} onPress={onCancel}>
          <Text style={panelStyles.submitButtonText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={panelStyles.panelScroll} contentContainerStyle={panelStyles.panelScrollContent}>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Field</Text>
        <View style={panelStyles.editFieldPicker}>
          {EDITABLE_FIELDS.map((f) => (
            <Pressable
              key={f.key}
              style={[panelStyles.editFieldChip, fieldKey === f.key && panelStyles.editFieldChipActive]}
              onPress={() => {
                setFieldKey(f.key);
                setValue('');
              }}
            >
              <Text style={[panelStyles.editFieldChipText, fieldKey === f.key && panelStyles.editFieldChipTextActive]}>{f.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>New value</Text>
        {field.kind === 'category' ? (
          <View style={panelStyles.editFieldPicker}>
            {GYM_CATEGORIES.map((cat) => (
              <Pressable key={cat} style={[panelStyles.editFieldChip, value === cat && panelStyles.editFieldChipActive]} onPress={() => setValue(cat)}>
                <Text style={[panelStyles.editFieldChipText, value === cat && panelStyles.editFieldChipTextActive]}>{cat}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <TextInput
            style={panelStyles.input}
            value={value}
            onChangeText={setValue}
            keyboardType={field.kind === 'text' ? 'default' : 'numeric'}
            placeholder={field.kind === 'price' ? 'e.g. 12.00' : undefined}
          />
        )}
      </View>
      <View style={panelStyles.panelRow}>
        <Text style={panelStyles.panelLabel}>Description</Text>
        <TextInput
          style={[panelStyles.input, panelStyles.textarea]}
          value={description}
          onChangeText={setDescription}
          placeholder="How do you know this?"
          multiline
          numberOfLines={3}
        />
      </View>
      <Pressable
        style={[panelStyles.submitButton, (submitting || !value.trim() || !description.trim()) && panelStyles.submitButtonDisabled]}
        onPress={submit}
      >
        <Text style={panelStyles.submitButtonText}>{submitting ? 'Submitting…' : 'Submit edit'}</Text>
      </Pressable>
    </ScrollView>
  );
}

// Shared visual language for the detail panel - used both by the
// components above and directly by each platform's own MapScreen (for
// the rows it renders itself: rating/category/description/address/
// pricing/coordinates). cursor/boxShadow are harmless on native (React
// Native silently ignores style keys it doesn't recognize).
export const panelStyles = StyleSheet.create({
  panelScroll: { flex: 1 },
  panelScrollContent: { padding: 20, gap: 20 },
  panelRow: { gap: 8 },
  panelLabel: { fontSize: 11, fontWeight: '600', color: '#8A94A0', textTransform: 'uppercase', letterSpacing: 0.5 },
  panelValue: { fontSize: 14, color: '#1C2430', lineHeight: 20 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    // @ts-expect-error - web-only cursor hint, fine for the demo
    cursor: 'pointer',
  },
  sectionChevron: { fontSize: 12, color: '#8A94A0' },
  sectionHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reviewForm: {
    gap: 8,
    backgroundColor: '#F7F8F9',
    borderRadius: 10,
    padding: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#DDE2E6',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    backgroundColor: 'white',
  },
  textarea: { minHeight: 60, textAlignVertical: 'top' },
  ratingPicker: { flexDirection: 'row', gap: 2 },
  // @ts-expect-error - web-only cursor hint, fine for the demo
  starHit: { cursor: 'pointer', padding: 2 },
  star: { fontSize: 18, color: '#D7DBDF' },
  starFilled: { color: '#E0A500' },
  submitButton: {
    backgroundColor: '#146C5F',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  submitButtonDisabled: { opacity: 0.6 },
  submitButtonText: { color: 'white', fontWeight: '600', fontSize: 13 },
  reviewCard: {
    gap: 4,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#EFEFEF',
  },
  reviewCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reviewAuthor: { fontSize: 13, fontWeight: '700', color: '#1C2430' },
  reviewStars: { fontSize: 12, color: '#E0A500' },
  chatBox: { gap: 8 },
  chatBubble: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '85%' },
  chatBubbleUser: { backgroundColor: '#146C5F', alignSelf: 'flex-end' },
  chatBubbleAssistant: { backgroundColor: '#F7F8F9', alignSelf: 'flex-start' },
  chatBubbleUserText: { color: 'white', fontSize: 13, lineHeight: 18 },
  chatBubbleAssistantText: { color: '#1C2430', fontSize: 13, lineHeight: 18 },
  chatInputRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  chatInput: { flex: 1 },
  chatInputLarge: { minHeight: 72, textAlignVertical: 'top' },
  chatSendButton: { paddingHorizontal: 16 },
  editFieldPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  editFieldChip: { borderWidth: 1, borderColor: '#DDE2E6', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
  editFieldChipActive: { backgroundColor: '#146C5F', borderColor: '#146C5F' },
  editFieldChipText: { fontSize: 12, color: '#5B6470', fontWeight: '600' },
  editFieldChipTextActive: { color: 'white' },
});

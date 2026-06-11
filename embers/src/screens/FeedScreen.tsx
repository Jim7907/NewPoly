import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { fmtDuration } from '../engine/lifetime';
import { inSurge, useEmbers } from '../state/store';
import { colors, radius } from '../theme';
import { PostCard } from '../components/PostCard';

export function FeedScreen() {
  const posts = useEmbers((s) => s.posts);
  const events = useEmbers((s) => s.events);
  const simNow = useEmbers((s) => s.simNow);
  const surgeStart = useEmbers((s) => s.surgeStart);

  const alive = posts
    .filter((p) => p.status === 'alive')
    .sort((a, b) => a.expiresAt - b.expiresAt); // most urgent first

  const surge = inSurge(simNow, surgeStart);
  const surgeSoon = !surge && surgeStart > simNow && surgeStart - simNow < 2 * 60 * 60 * 1000;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {surge && (
        <View style={[styles.banner, { backgroundColor: colors.surge }]}>
          <Text style={styles.bannerText}>
            ⚡⚡ SURGE HOUR — sparks count DOUBLE for {fmtDuration(surgeStart + 60 * 60 * 1000 - simNow)}!
          </Text>
        </View>
      )}
      {surgeSoon && (
        <View style={[styles.banner, { backgroundColor: '#2a2347' }]}>
          <Text style={styles.bannerText}>⚡ Surge Hour starts in {fmtDuration(surgeStart - simNow)} — save your sparks…</Text>
        </View>
      )}
      {events.slice(0, 3).map((e) => (
        <View key={e.id} style={styles.event}>
          <Text style={styles.eventText}>{e.text}</Text>
        </View>
      ))}
      {alive.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyBig}>🪦</Text>
          <Text style={styles.emptyText}>Everything is dead. Post something.</Text>
        </View>
      ) : (
        alive.map((p) => <PostCard key={p.id} post={p} />)
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: 120 },
  banner: {
    borderRadius: radius.card,
    padding: 12,
    marginBottom: 12,
  },
  bannerText: { color: colors.text, fontWeight: '800', textAlign: 'center' },
  event: {
    backgroundColor: '#1d1825',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
    borderLeftWidth: 3,
    borderLeftColor: colors.ember,
  },
  eventText: { color: colors.textDim, fontSize: 13 },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyBig: { fontSize: 64 },
  emptyText: { color: colors.textDim, marginTop: 10 },
});

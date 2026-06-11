import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fmtDuration } from '../engine/lifetime';
import { ME } from '../engine/seed';
import { useEmbers } from '../state/store';
import { colors, radius } from '../theme';

export function GraveyardScreen() {
  const posts = useEmbers((s) => s.posts);
  const friends = useEmbers((s) => s.friends);
  const phoenixAvailable = useEmbers((s) => s.phoenixAvailable);
  const phoenixPost = useEmbers((s) => s.phoenixPost);
  const selectPost = useEmbers((s) => s.selectPost);

  const dead = posts
    .filter((p) => p.status === 'dead')
    .sort((a, b) => (b.diedAt ?? 0) - (a.diedAt ?? 0));

  const nameOf = (id: string) => {
    if (id === ME) return 'you';
    return friends.find((f) => f.id === id)?.name ?? id;
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>🪦 Graveyard</Text>
      <Text style={styles.sub}>
        Every ember dies in public. {phoenixAvailable ? 'Your weekly 🕊 Phoenix is ready.' : 'Phoenix used — refills weekly.'}
      </Text>

      {dead.length === 0 && <Text style={styles.sub}>No graves yet. Give it time.</Text>}

      {dead.map((p) => {
        const lived = (p.diedAt ?? p.expiresAt) - p.bornAt;
        const mine = p.authorId === ME;
        return (
          <Pressable key={p.id} style={styles.grave} onPress={() => selectPost(p.id)}>
            <Text style={styles.graveTitle}>
              🪦 "{p.caption}" <Text style={styles.graveWho}>— {nameOf(p.authorId)}</Text>
            </Text>
            <Text style={styles.epitaph}>
              lived {fmtDuration(lived)} · {p.epitaph}
            </Text>
            {mine && phoenixAvailable && !p.phoenixed && (
              <Pressable style={styles.phoenix} onPress={() => phoenixPost(p.id)}>
                <Text style={styles.phoenixText}>🕊 PHOENIX — give it a second life</Text>
              </Pressable>
            )}
          </Pressable>
        );
      })}

      <Text style={styles.respects}>⚰️ Tap a grave to pay respects</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 120, gap: 12 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  sub: { color: colors.textDim, fontSize: 13 },
  grave: {
    backgroundColor: '#141218',
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.grave,
    padding: 14,
    gap: 6,
  },
  graveTitle: { color: colors.text, fontWeight: '700' },
  graveWho: { color: colors.textDim, fontWeight: '400' },
  epitaph: { color: colors.grave, fontStyle: 'italic', fontSize: 13 },
  phoenix: {
    backgroundColor: '#2a2347',
    borderRadius: radius.pill,
    paddingVertical: 8,
    alignItems: 'center',
    marginTop: 6,
  },
  phoenixText: { color: colors.surge, fontWeight: '800', fontSize: 13 },
  respects: { color: colors.grave, textAlign: 'center', marginTop: 12, fontSize: 12 },
});

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HARD_CAP_MS, fmtDuration, isCritical } from '../engine/lifetime';
import { ME } from '../engine/seed';
import type { Post } from '../engine/types';
import { useEmbers } from '../state/store';
import { colors, radius } from '../theme';
import { PostMedia } from '../components/PostCard';

function fmtAt(t: number): string {
  const d = new Date(t);
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function PostDetailScreen({ post }: { post: Post }) {
  const simNow = useEmbers((s) => s.simNow);
  const friends = useEmbers((s) => s.friends);
  const selectPost = useEmbers((s) => s.selectPost);
  const sparkPost = useEmbers((s) => s.sparkPost);
  const sparksLeft = useEmbers((s) => s.sparksLeft);
  const setPaywallOpen = useEmbers((s) => s.setPaywallOpen);

  const critical = isCritical(post.expiresAt, simNow);
  const left = post.expiresAt - simNow;

  const nameOf = (id: string) => {
    if (id === ME) return '🧑 you';
    const f = friends.find((x) => x.id === id);
    return f ? `${f.avatar} ${f.name}` : id;
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Pressable onPress={() => selectPost(null)}>
        <Text style={styles.back}>← back</Text>
      </Pressable>

      <Text style={styles.title}>
        {nameOf(post.authorId)}'s ember{post.phoenixed ? ' 🕊' : ''}
      </Text>
      <PostMedia post={post} height={240} />
      <Text style={styles.caption}>{post.caption}</Text>

      <View style={styles.facts}>
        <Text style={styles.fact}>Born: {fmtAt(post.bornAt)}</Text>
        {post.status === 'alive' && (
          <>
            <Text style={[styles.fact, critical && { color: colors.danger, fontWeight: '800' }]}>
              Dies: {fmtAt(post.expiresAt)} — in {fmtDuration(left)} (unless…)
            </Text>
            <Text style={styles.factDim}>Max possible: {fmtAt(post.bornAt + HARD_CAP_MS)} (72h cap)</Text>
          </>
        )}
        {post.status === 'dead' && <Text style={[styles.fact, { color: colors.grave }]}>🪦 {post.epitaph}</Text>}
        {post.status === 'famous' && (
          <Text style={[styles.fact, { color: colors.gold }]}>🏆 IMMORTAL — survived the full 72 hours</Text>
        )}
      </View>

      <Text style={styles.section}>⚡ Spark history</Text>
      {post.sparks.length === 0 && <Text style={styles.factDim}>No sparks yet. It is on its own.</Text>}
      {post.sparks.map((s) => (
        <View key={s.id} style={styles.sparkRow}>
          {s.anonymous ? (
            <Pressable onPress={() => setPaywallOpen(true)}>
              <Text style={styles.anon}>❓ anonymous — reveal with Embers+</Text>
            </Pressable>
          ) : (
            <Text style={styles.sparkWho}>{nameOf(s.userId)}</Text>
          )}
          <Text style={[styles.sparkVal, s.golden && { color: colors.gold, fontWeight: '900' }]}>
            +{s.minutesAdded} min{s.golden ? ' 🌟' : ''}
            {s.surge ? ' ⚡×2' : ''}
            {s.rescue ? ' 🚑' : ''}
          </Text>
        </View>
      ))}

      <Text style={styles.section}>🏅 Milestones</Text>
      <Text style={styles.fact}>
        {post.milestones.h24 ? '✅' : '◻'} 24h{'   '}
        {post.milestones.h48 ? '✅' : '◻'} 48h{'   '}
        {post.milestones.h72 ? '✅' : '◻'} 72h → Hall of Fame
      </Text>

      {post.status === 'alive' && (
        <Pressable
          onPress={() => sparkPost(post.id)}
          disabled={sparksLeft <= 0}
          style={({ pressed }) => [styles.sparkBtn, (pressed || sparksLeft <= 0) && { opacity: 0.5 }]}
        >
          <Text style={styles.sparkBtnText}>⚡ SPARK IT ({sparksLeft} left today)</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 120, gap: 10 },
  back: { color: colors.ember, fontWeight: '700', marginBottom: 6 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  caption: { color: colors.text, fontSize: 16 },
  facts: { backgroundColor: colors.card, borderRadius: radius.card, padding: 14, gap: 6 },
  fact: { color: colors.text },
  factDim: { color: colors.textDim, fontSize: 13 },
  section: { color: colors.textDim, fontWeight: '800', marginTop: 10, textTransform: 'uppercase', fontSize: 12 },
  sparkRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 10,
  },
  sparkWho: { color: colors.text },
  anon: { color: colors.surge, fontStyle: 'italic' },
  sparkVal: { color: colors.ok, fontVariant: ['tabular-nums'] },
  sparkBtn: {
    backgroundColor: colors.ember,
    borderRadius: radius.pill,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  sparkBtnText: { color: '#1a0d06', fontWeight: '900' },
});

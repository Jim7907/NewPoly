import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fmtDuration } from '../engine/lifetime';
import { ME } from '../engine/seed';
import { levelFromXp, useEmbers } from '../state/store';
import { colors, radius } from '../theme';
import { PostMedia } from '../components/PostCard';

export function ProfileScreen() {
  const posts = useEmbers((s) => s.posts);
  const friends = useEmbers((s) => s.friends);
  const xp = useEmbers((s) => s.xp);
  const streak = useEmbers((s) => s.streak);
  const badges = useEmbers((s) => s.badges);
  const lifesaves = useEmbers((s) => s.lifesaves);
  const selectPost = useEmbers((s) => s.selectPost);
  const setPaywallOpen = useEmbers((s) => s.setPaywallOpen);

  const { level, title, into, needed } = levelFromXp(xp);

  const mine = posts.filter((p) => p.authorId === ME);
  const famous = mine.filter((p) => p.status === 'famous');
  const longest = mine.reduce((best, p) => {
    const end = p.status === 'alive' ? p.expiresAt : (p.diedAt ?? p.expiresAt);
    return Math.max(best, Math.min(end, end) - p.bornAt);
  }, 0);

  const board = [...friends.map((f) => ({ name: f.name, avatar: f.avatar, xp: f.xp })), { name: 'you', avatar: '🧑', xp }]
    .sort((a, b) => b.xp - a.xp);
  const myRank = board.findIndex((b) => b.name === 'you') + 1;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>🧑 you · Level {level} {title}</Text>
      <View style={styles.xpTrack}>
        <View style={[styles.xpFill, { width: `${Math.min(100, Math.round((into / needed) * 100))}%` }]} />
      </View>
      <Text style={styles.xpText}>
        XP {xp.toLocaleString()} · {into}/{needed} to next level · 🔥 {streak}-day flame
      </Text>

      <Text style={styles.section}>🏆 Hall of Fame (immortal)</Text>
      {famous.length === 0 ? (
        <Text style={styles.dim}>Nothing immortal yet. Keep an ember alive for 72h.</Text>
      ) : (
        <View style={styles.fameRow}>
          {famous.map((p) => (
            <Pressable key={p.id} style={styles.fameCard} onPress={() => selectPost(p.id)}>
              <PostMedia post={p} height={80} />
              <Text style={styles.fameCaption} numberOfLines={1}>{p.caption}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <Text style={styles.section}>🎖 Badges</Text>
      <View style={styles.badgeRow}>
        {badges.map((b) => (
          <View key={b.id} style={styles.badge}>
            <Text style={styles.badgeText}>{b.emoji} {b.label}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.section}>📊 Stats</Text>
      <Text style={styles.stat}>Longest survivor: {fmtDuration(longest)}</Text>
      <Text style={styles.stat}>Lives saved: {lifesaves} 🚑</Text>

      <Text style={styles.section}>🥇 Friend leaderboard — you are #{myRank} of {board.length}</Text>
      {board.map((b, i) => (
        <View key={b.name} style={[styles.boardRow, b.name === 'you' && styles.boardMe]}>
          <Text style={styles.boardName}>
            {i + 1}. {b.avatar} {b.name}
          </Text>
          <Text style={styles.boardXp}>{b.xp.toLocaleString()} XP</Text>
        </View>
      ))}

      <Pressable style={styles.premium} onPress={() => setPaywallOpen(true)}>
        <Text style={styles.premiumText}>✨ Embers+ — see who sparked you anonymously</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 120, gap: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  xpTrack: { height: 10, borderRadius: 5, backgroundColor: '#2a2433', overflow: 'hidden', marginTop: 6 },
  xpFill: { height: 10, backgroundColor: colors.ember, borderRadius: 5 },
  xpText: { color: colors.textDim, fontSize: 13 },
  section: { color: colors.textDim, fontWeight: '800', marginTop: 16, textTransform: 'uppercase', fontSize: 12 },
  dim: { color: colors.textDim, fontSize: 13 },
  fameRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  fameCard: {
    width: 110,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gold,
    padding: 6,
    gap: 4,
  },
  fameCaption: { color: colors.gold, fontSize: 11, textAlign: 'center' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badge: {
    backgroundColor: colors.card,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  badgeText: { color: colors.text, fontSize: 13 },
  stat: { color: colors.text },
  boardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 10,
  },
  boardMe: { borderWidth: 1, borderColor: colors.ember },
  boardName: { color: colors.text },
  boardXp: { color: colors.textDim, fontVariant: ['tabular-nums'] },
  premium: {
    backgroundColor: '#2a2347',
    borderRadius: radius.card,
    padding: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  premiumText: { color: colors.surge, fontWeight: '800' },
});

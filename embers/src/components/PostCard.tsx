import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { fmtDuration, isCritical, lifeFraction, sparkMinutes } from '../engine/lifetime';
import { ME } from '../engine/seed';
import type { Post } from '../engine/types';
import { inSurge, useEmbers } from '../state/store';
import { colors, radius } from '../theme';
import { LifeBar } from './LifeBar';

interface Props {
  post: Post;
}

function authorOf(post: Post, friends: { id: string; name: string; avatar: string }[]) {
  if (post.authorId === ME) return { name: 'you', avatar: '🧑' };
  const f = friends.find((x) => x.id === post.authorId);
  return f ?? { name: post.authorId, avatar: '👤' };
}

export function PostMedia({ post, height = 180 }: { post: Post; height?: number }) {
  if (post.imageUri) {
    return <Image source={{ uri: post.imageUri }} style={[styles.media, { height }]} resizeMode="cover" />;
  }
  return (
    <View style={[styles.media, { height, backgroundColor: post.placeholder.bg }]}>
      <Text style={{ fontSize: 56 }}>{post.placeholder.emoji}</Text>
    </View>
  );
}

export function PostCard({ post }: Props) {
  const simNow = useEmbers((s) => s.simNow);
  const surgeStart = useEmbers((s) => s.surgeStart);
  const sparksLeft = useEmbers((s) => s.sparksLeft);
  const friends = useEmbers((s) => s.friends);
  const sparkPost = useEmbers((s) => s.sparkPost);
  const selectPost = useEmbers((s) => s.selectPost);

  const critical = isCritical(post.expiresAt, simNow);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!critical) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 600, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [critical, pulse]);

  const author = authorOf(post, friends);
  const left = post.expiresAt - simNow;
  const surge = inSurge(simNow, surgeStart);
  const wouldAdd = sparkMinutes(post.sparks.length + 1, { golden: false, surge, rescue: critical });

  const borderColor = critical
    ? pulse.interpolate({ inputRange: [0, 1], outputRange: [colors.cardBorder, colors.danger] })
    : colors.cardBorder;

  return (
    <Animated.View style={[styles.card, { borderColor }]}>
      <Pressable onPress={() => selectPost(post.id)}>
        <View style={styles.head}>
          <Text style={styles.author}>
            {author.avatar} {author.name}
            {post.phoenixed ? ' 🕊' : ''}
          </Text>
          <Text style={[styles.timer, critical && { color: colors.danger }]}>
            {critical ? '🚨 ' : '⏳ '}
            {fmtDuration(left)}
          </Text>
        </View>
        <PostMedia post={post} />
        <Text style={styles.caption}>{post.caption}</Text>
        <LifeBar fraction={lifeFraction(post.bornAt, post.expiresAt, simNow)} critical={critical} />
      </Pressable>
      {critical && <Text style={styles.dying}>🆘 DYING — SAVE IT?</Text>}
      <View style={styles.actions}>
        <Pressable
          onPress={() => sparkPost(post.id)}
          disabled={sparksLeft <= 0}
          style={({ pressed }) => [
            styles.sparkBtn,
            surge && styles.sparkBtnSurge,
            critical && styles.sparkBtnCritical,
            (pressed || sparksLeft <= 0) && { opacity: 0.5 },
          ]}
        >
          <Text style={styles.sparkText}>
            ⚡ SPARK (+{wouldAdd} min{surge ? ' ×2 SURGE' : ''})
          </Text>
        </Pressable>
        <Text style={styles.views}>👁 {post.views}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: 2,
    padding: 12,
    marginBottom: 14,
    gap: 8,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  author: { color: colors.text, fontWeight: '700' },
  timer: { color: colors.textDim, fontVariant: ['tabular-nums'] },
  media: {
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    width: '100%',
  },
  caption: { color: colors.text, marginBottom: 8 },
  dying: { color: colors.danger, fontWeight: '800', textAlign: 'center', marginTop: 6 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  sparkBtn: {
    backgroundColor: colors.emberDim,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sparkBtnSurge: { backgroundColor: colors.surge },
  sparkBtnCritical: { backgroundColor: colors.danger },
  sparkText: { color: colors.text, fontWeight: '800' },
  views: { color: colors.textDim },
});

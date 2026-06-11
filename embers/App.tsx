import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { fmtClock } from './src/engine/lifetime';
import { useEmbers, type Tab } from './src/state/store';
import { colors, radius } from './src/theme';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { FeedScreen } from './src/screens/FeedScreen';
import { GraveyardScreen } from './src/screens/GraveyardScreen';
import { PostDetailScreen } from './src/screens/PostDetailScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';

const TABS: { key: Tab; label: string }[] = [
  { key: 'feed', label: '🏠 Feed' },
  { key: 'capture', label: '📸 Post' },
  { key: 'graveyard', label: '🪦 Graves' },
  { key: 'profile', label: '🧑 You' },
];

export default function App() {
  const tab = useEmbers((s) => s.tab);
  const setTab = useEmbers((s) => s.setTab);
  const tick = useEmbers((s) => s.tick);
  const warp = useEmbers((s) => s.warp);
  const simNow = useEmbers((s) => s.simNow);
  const sparksLeft = useEmbers((s) => s.sparksLeft);
  const streak = useEmbers((s) => s.streak);
  const selectedPostId = useEmbers((s) => s.selectedPostId);
  const posts = useEmbers((s) => s.posts);
  const paywallOpen = useEmbers((s) => s.paywallOpen);
  const setPaywallOpen = useEmbers((s) => s.setPaywallOpen);
  const celebration = useEmbers((s) => s.celebration);
  const dismissCelebration = useEmbers((s) => s.dismissCelebration);

  // 1 real second = 1 sim second; the warp buttons fast-forward the world.
  useEffect(() => {
    const id = setInterval(() => tick(1000), 1000);
    return () => clearInterval(id);
  }, [tick]);

  useEffect(() => {
    if (!celebration) return;
    const id = setTimeout(dismissCelebration, 4000);
    return () => clearTimeout(id);
  }, [celebration, dismissCelebration]);

  const selected = posts.find((p) => p.id === selectedPostId) ?? null;

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.phone}>
        <View style={styles.header}>
          <Text style={styles.logo}>🔥 Embers</Text>
          <View style={styles.headerRight}>
            <Text style={styles.streak}>🔥 {streak}</Text>
            <Text style={styles.sparks}>⚡ {sparksLeft}</Text>
          </View>
        </View>

        <View style={styles.body}>
          {selected ? (
            <PostDetailScreen post={selected} />
          ) : tab === 'feed' ? (
            <FeedScreen />
          ) : tab === 'capture' ? (
            <CaptureScreen />
          ) : tab === 'graveyard' ? (
            <GraveyardScreen />
          ) : (
            <ProfileScreen />
          )}
        </View>

        {celebration && (
          <Pressable style={styles.toast} onPress={dismissCelebration}>
            <Text style={styles.toastText}>{celebration}</Text>
          </Pressable>
        )}

        <View style={styles.devBar}>
          <Text style={styles.devClock}>🕐 {fmtClock(simNow)}</Text>
          <Pressable style={styles.devBtn} onPress={() => warp(1)}>
            <Text style={styles.devBtnText}>⏩ +1h</Text>
          </Pressable>
          <Pressable style={styles.devBtn} onPress={() => warp(6)}>
            <Text style={styles.devBtnText}>⏩ +6h</Text>
          </Pressable>
          <Pressable style={styles.devBtn} onPress={() => warp(24)}>
            <Text style={styles.devBtnText}>⏩ +1d</Text>
          </Pressable>
          <Text style={styles.devHint}>demo time-warp</Text>
        </View>

        <View style={styles.tabBar}>
          {TABS.map((t) => (
            <Pressable key={t.key} style={styles.tabBtn} onPress={() => setTab(t.key)}>
              <Text style={[styles.tabText, tab === t.key && !selected && styles.tabActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Modal visible={paywallOpen} transparent animationType="fade" onRequestClose={() => setPaywallOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>✨ Embers+</Text>
            <Text style={styles.modalBody}>
              See who sparked you anonymously, double daily sparks, and a custom flame color.
            </Text>
            <Text style={styles.modalPrice}>$6.99/month — (prototype stub, nothing is charged)</Text>
            <Pressable style={styles.modalBtn} onPress={() => setPaywallOpen(false)}>
              <Text style={styles.modalBtnText}>maybe later</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#070609', alignItems: 'center' },
  phone: {
    flex: 1,
    width: '100%',
    maxWidth: Platform.OS === 'web' ? 420 : undefined,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  logo: { color: colors.text, fontSize: 20, fontWeight: '900' },
  headerRight: { flexDirection: 'row', gap: 14 },
  streak: { color: colors.ember, fontWeight: '800' },
  sparks: { color: colors.gold, fontWeight: '800' },
  body: { flex: 1 },
  toast: {
    position: 'absolute',
    top: 70,
    left: 16,
    right: 16,
    backgroundColor: colors.gold,
    borderRadius: radius.card,
    padding: 14,
    zIndex: 10,
  },
  toastText: { color: '#3a2a00', fontWeight: '900', textAlign: 'center' },
  devBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    backgroundColor: '#100d14',
  },
  devClock: { color: colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] },
  devBtn: {
    backgroundColor: '#241f2e',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  devBtnText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  devHint: { color: '#4d4658', fontSize: 10, marginLeft: 'auto' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    backgroundColor: '#100d14',
    paddingBottom: Platform.OS === 'ios' ? 18 : 8,
  },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  tabText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  tabActive: { color: colors.ember },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: 24,
    maxWidth: 360,
    gap: 12,
    borderWidth: 1,
    borderColor: colors.surge,
  },
  modalTitle: { color: colors.text, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  modalBody: { color: colors.textDim, textAlign: 'center', lineHeight: 20 },
  modalPrice: { color: colors.surge, textAlign: 'center', fontWeight: '700', fontSize: 13 },
  modalBtn: {
    backgroundColor: colors.surge,
    borderRadius: radius.pill,
    padding: 12,
    alignItems: 'center',
  },
  modalBtnText: { color: '#fff', fontWeight: '800' },
});

import * as ImagePicker from 'expo-image-picker';
import React, { useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useEmbers } from '../state/store';
import { colors, radius } from '../theme';

export function CaptureScreen() {
  const createPost = useEmbers((s) => s.createPost);
  const [caption, setCaption] = useState('');
  const [imageUri, setImageUri] = useState<string | undefined>(undefined);

  const pickPhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
    });
    const uri = res.assets?.[0]?.uri;
    if (!res.canceled && uri) setImageUri(uri);
  };

  const release = () => {
    createPost(caption, imageUri);
    setCaption('');
    setImageUri(undefined);
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>New Ember</Text>

      <Pressable style={styles.pickArea} onPress={pickPhoto}>
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" />
        ) : (
          <>
            <Text style={{ fontSize: 48 }}>📸</Text>
            <Text style={styles.pickText}>tap to pick a photo</Text>
            <Text style={styles.pickHint}>(or release without one — a placeholder ember is fine for the demo)</Text>
          </>
        )}
      </Pressable>

      <TextInput
        style={styles.input}
        placeholder="caption…"
        placeholderTextColor={colors.textDim}
        value={caption}
        onChangeText={setCaption}
        maxLength={60}
      />

      <View style={styles.warning}>
        <Text style={styles.warningText}>
          ⚠️ This ember is born with <Text style={styles.warningStrong}>6 hours to live</Text>.{'\n'}
          Only sparks keep it alive. At 72h it becomes immortal.
        </Text>
      </View>

      <Pressable style={({ pressed }) => [styles.release, pressed && { opacity: 0.7 }]} onPress={release}>
        <Text style={styles.releaseText}>🔥 RELEASE IT</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 120, gap: 16 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  pickArea: {
    height: 260,
    borderRadius: radius.card,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  preview: { width: '100%', height: '100%' },
  pickText: { color: colors.text, marginTop: 8, fontWeight: '600' },
  pickHint: { color: colors.textDim, fontSize: 12, marginTop: 4, textAlign: 'center', paddingHorizontal: 24 },
  input: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  warning: {
    backgroundColor: '#241a14',
    borderRadius: 12,
    padding: 14,
    borderLeftWidth: 3,
    borderLeftColor: colors.ember,
  },
  warningText: { color: colors.textDim, lineHeight: 20 },
  warningStrong: { color: colors.ember, fontWeight: '800' },
  release: {
    backgroundColor: colors.ember,
    borderRadius: radius.pill,
    padding: 16,
    alignItems: 'center',
  },
  releaseText: { color: '#1a0d06', fontWeight: '900', fontSize: 16 },
});

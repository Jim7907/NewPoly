import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';

interface Props {
  fraction: number; // 0..1
  critical: boolean;
}

export function LifeBar({ fraction, critical }: Props) {
  const pct = Math.round(fraction * 100);
  const fill = critical ? colors.danger : fraction > 0.5 ? colors.ok : colors.ember;
  return (
    <View style={styles.row}>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.max(2, pct)}%`, backgroundColor: fill }]} />
      </View>
      <Text style={[styles.pct, critical && { color: colors.danger }]}>{pct}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  track: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#2a2433',
    overflow: 'hidden',
  },
  fill: { height: 8, borderRadius: 4 },
  pct: { color: colors.textDim, fontSize: 12, width: 38, textAlign: 'right' },
});

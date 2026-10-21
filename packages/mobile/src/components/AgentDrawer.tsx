'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  Animated,
  Dimensions,
  Easing,
  FlatList,
  PanResponder,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'

export interface ActivityItem {
  ts: number
  text: string
}

export interface AgentDrawerProps {
  items: ActivityItem[]
  prompt: string
  onPromptChange: (text: string) => void
  autoExecute: boolean
  onAutoExecuteChange: (value: boolean) => void
  hostInference: boolean
  onHostInferenceChange: (value: boolean) => void
  onSubmitPrompt: () => void
}

const DRAWER_W = 320

/** Right-swipe side drawer: prompt bar, live activity stream, inference/exec toggles. */
export function AgentDrawer(props: AgentDrawerProps): React.ReactElement {
  const screenW = Dimensions.get('window').width
  const [open, setOpen] = useState(false)
  const anim = useRef(new Animated.Value(-DRAWER_W)).current

  const toggle = (to: boolean) => {
    setOpen(to)
    Animated.timing(anim, { toValue: to ? 0 : -DRAWER_W, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start()
  }

  // ponytail: PanResponder edge-swipe (react-native-gesture-handler only if flings/velocity are ever needed)
  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (e) => e.nativeEvent.pageX > screenW - 48,
        onMoveShouldSetPanResponder: (e, g) => e.nativeEvent.pageX > screenW - 48 && Math.abs(g.dx) > 12,
        onPanResponderRelease: (_e, g) => {
          if (g.dx < -42) toggle(true)
          else if (g.dx > 42) toggle(false)
        },
      }),
    [screenW],
  )

  useEffect(() => {
    toggle(open) // animate on first mount too (no-op at -DRAWER_W when closed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <View {...pan.panHandlers} style={{ ...styles.host }}>
      <Animated.View style={[styles.drawer, { transform: [{ translateX: anim }], width: DRAWER_W, height: '100%' }]}>
        <Text style={styles.title}>⚡ OpenInstinct</Text>

        <View style={styles.row}>
          <TextInput
            style={styles.input}
            placeholder="What should the agent do?"
            placeholderTextColor="#888"
            value={props.prompt}
            onChangeText={props.onPromptChange}
            multiline
          />
          <TouchableOpacity style={styles.go} onPress={props.onSubmitPrompt}>
            <Text style={styles.goText}>Run</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.toggleRow}>
          <Text style={styles.label}>Auto-execute model actions</Text>
          <Switch value={props.autoExecute} onValueChange={props.onAutoExecuteChange} />
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.label}>Prefer host inference</Text>
          <Switch value={props.hostInference} onValueChange={props.onHostInferenceChange} />
        </View>

        <Text style={styles.feedTitle}>Live activity</Text>
        <FlatList
          data={props.items.slice(0, 50)}
          keyExtractor={(item) => `${item.ts}-${item.text}`}
          renderItem={({ item }) => (
            <Text style={styles.feedItem}>{`▸ ${item.text}`}</Text>
          )}
        />
      </Animated.View>
      {open && <TouchableOpacity style={styles.scrim} activeOpacity={1} onPress={() => toggle(false)} />}
    </View>
  )
}

const styles = {
  host: { flex: 1 } as const,
  drawer: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: '#111318',
    paddingHorizontal: 16,
    paddingVertical: 18,
    borderTopLeftRadius: 16,
    borderBottomLeftRadius: 16,
    elevation: 8,
    zIndex: 30,
  } as const,
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
    zIndex: 20,
  } as const,
  title: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 14 } as const,
  row: { flexDirection: 'row', gap: 8, marginBottom: 14 } as const,
  input: {
    flex: 1,
    borderColor: '#333',
    borderWidth: 1,
    borderRadius: 10,
    color: '#fff',
    paddingHorizontal: 10,
    minHeight: 42,
  } as const,
  go: { backgroundColor: '#e11d48', borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' } as const,
  goText: { color: '#fff', fontWeight: '700' } as const,
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } as const,
  label: { color: '#ccc', fontSize: 13 } as const,
  feedTitle: { color: '#fff', fontSize: 14, fontWeight: '600', marginTop: 8, marginBottom: 6 } as const,
  feedItem: { color: '#9ca3af', fontSize: 12, paddingVertical: 3 },
}
/**
 * Spot Me — Phase 1 chat screen.
 *
 * Deliberately plain. The job of this build is to answer one question on real
 * hardware: do two phones find each other over the DHT and converge? Every
 * designed screen comes after that answer, because a beautiful UI over a
 * transport that does not work is the most expensive kind of progress.
 *
 * It does surface what is needed to DEBUG that question on a device with no
 * console attached: peer count, writable state, and the room key.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable,
  SafeAreaView, StatusBar, StyleSheet, Text, TextInput, View
} from 'react-native'
import { Paths } from 'expo-file-system'
import * as Clipboard from 'expo-clipboard'
import p2p from './lib/p2p'

/** Matches the locked design system: light, greyscale, one accent. */
const C = {
  bg: '#F5F5F5',
  surface: '#FFFFFF',
  ink: '#111111',
  muted: '#8A8A8A',
  line: '#E4E4E4',
  accent: '#E8734A'
}

/**
 * Corestore wants a filesystem path. SDK 57's Paths API hands back a file://
 * URI and Bare's fs does not understand the scheme — strip it, or every core
 * open fails with a confusing ENOENT.
 */
const STORAGE = Paths.document.uri.replace(/^file:\/\//, '') + 'spotme-room'
const MY_LANG = 'en'
const ROOM_KEY_LENGTH = 64

export default function App () {
  const [booting, setBooting] = useState(true)
  const [error, setError] = useState(null)
  const [room, setRoom] = useState(null)      // {key, writerKey, writable}
  const [messages, setMessages] = useState([])
  const [peers, setPeers] = useState(0)
  const [draft, setDraft] = useState('')
  const [joinKey, setJoinKey] = useState('')
  const [notice, setNotice] = useState(null)
  const listRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    const offUpdate = p2p.on('update', ({ transcript, writable }) => {
      if (cancelled) return
      setMessages(transcript)
      setRoom((r) => (r ? { ...r, writable } : r))
    })
    const offPeer = p2p.on('peer', ({ count }) => !cancelled && setPeers(count))
    const offError = p2p.on('error', ({ where, message }) =>
      !cancelled && setNotice(`${where}: ${message}`))

    p2p.start()
      .then(() => !cancelled && setBooting(false))
      .catch((err) => {
        if (cancelled) return
        setError(err.message)
        setBooting(false)
      })

    return () => {
      cancelled = true
      offUpdate(); offPeer(); offError()
    }
  }, [])

  const flash = (text) => {
    setNotice(text)
    setTimeout(() => setNotice(null), 2500)
  }

  const createRoom = async () => {
    try {
      setRoom(await p2p.create(STORAGE, 'me'))
      flash('Room created - share the key')
    } catch (err) { setError(err.message) }
  }

  const joinRoom = async () => {
    const key = joinKey.trim()
    if (key.length !== ROOM_KEY_LENGTH) return flash('Room key must be 64 hex characters')
    try {
      setRoom(await p2p.join(STORAGE, key, 'me'))
      // Read-only until an existing writer invites this device — the whole
      // point of separating the room key from write access.
      flash('Joined - read-only until you are invited')
    } catch (err) { setError(err.message) }
  }

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    try {
      await p2p.post(text, MY_LANG)
    } catch (err) {
      setDraft(text) // put it back rather than silently losing the message
      flash(err.message)
    }
  }

  const copy = async (value, label) => {
    await Clipboard.setStringAsync(value)
    flash(`${label} copied`)
  }

  const inviteFromClipboard = async () => {
    const key = (await Clipboard.getStringAsync()).trim()
    if (key.length !== ROOM_KEY_LENGTH) return flash('Clipboard has no valid writer key')
    try {
      await p2p.invite(key)
      flash('Invited - they can post now')
    } catch (err) { flash(err.message) }
  }

  if (booting) {
    return (
      <View style={[s.screen, s.centre]}>
        <ActivityIndicator color={C.ink} />
        <Text style={s.muted}>Starting P2P runtime...</Text>
      </View>
    )
  }

  if (error) {
    return (
      <View style={[s.screen, s.centre]}>
        <Text style={s.error}>{error}</Text>
      </View>
    )
  }

  if (!room) {
    return (
      <SafeAreaView style={s.screen}>
        <StatusBar barStyle="dark-content" />
        <View style={s.setup}>
          <Text style={s.title}>Spot Me</Text>
          <Text style={s.muted}>Phase 1 - two-peer encrypted chat</Text>

          <Pressable style={s.primary} onPress={createRoom}>
            <Text style={s.primaryText}>Create a room</Text>
          </Pressable>

          <Text style={[s.muted, s.or]}>or join one</Text>
          <TextInput
            style={s.input}
            value={joinKey}
            onChangeText={setJoinKey}
            placeholder="Paste a 64-character room key"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={s.secondary} onPress={joinRoom}>
            <Text style={s.secondaryText}>Join</Text>
          </Pressable>
        </View>
        {notice && <Text style={s.notice}>{notice}</Text>}
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar barStyle="dark-content" />

      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>Room</Text>
          <Text style={s.headerSub}>
            {peers} peer{peers === 1 ? '' : 's'} · {room.writable ? 'can post' : 'read-only'}
          </Text>
        </View>
        <View style={s.headerActions}>
          <Pressable onPress={() => copy(room.key, 'Room key')}>
            <Text style={s.link}>Share key</Text>
          </Pressable>
          <Pressable onPress={() => copy(room.writerKey, 'Your writer key')}>
            <Text style={s.link}>My key</Text>
          </Pressable>
          <Pressable onPress={inviteFromClipboard}>
            <Text style={s.link}>Invite</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={s.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Text style={[s.muted, s.centreText]}>
            No messages yet.{'\n'}Share the room key with another device.
          </Text>
        }
        renderItem={({ item }) => {
          const mine = item.from === 'me'
          return (
            <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleTheirs]}>
              <Text style={mine ? s.textMine : s.textTheirs}>{item.text}</Text>
              <Text style={[s.meta, mine && s.metaMine]}>
                {item.lang}
                {item.reactions.length > 0 ? ` · ${item.reactions.length} reaction` : ''}
              </Text>
            </View>
          )
        }}
      />

      {notice && <Text style={s.notice}>{notice}</Text>}

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.composer}>
          <TextInput
            style={s.composerInput}
            value={draft}
            onChangeText={setDraft}
            placeholder={room.writable ? 'Message' : 'Waiting to be invited...'}
            placeholderTextColor={C.muted}
            editable={room.writable}
            onSubmitEditing={send}
            returnKeyType="send"
          />
          <Pressable
            style={[s.send, !room.writable && s.sendDisabled]}
            onPress={send}
            disabled={!room.writable}
          >
            <Text style={s.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  centre: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  centreText: { textAlign: 'center', marginTop: 48 },
  muted: { color: C.muted, fontSize: 14 },
  error: { color: '#B3261E', fontSize: 14, paddingHorizontal: 32, textAlign: 'center' },

  setup: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, gap: 12 },
  title: { color: C.ink, fontSize: 32, fontWeight: '700' },
  or: { marginTop: 24, textAlign: 'center' },

  primary: { backgroundColor: C.ink, borderRadius: 12, padding: 16, marginTop: 24 },
  primaryText: { color: '#FFF', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  secondary: { borderColor: C.line, borderWidth: 1, borderRadius: 12, padding: 16 },
  secondaryText: { color: C.ink, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  input: {
    backgroundColor: C.surface, borderColor: C.line, borderWidth: 1,
    borderRadius: 12, padding: 14, color: C.ink, fontSize: 14
  },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: C.surface, borderBottomColor: C.line, borderBottomWidth: 1
  },
  headerTitle: { color: C.ink, fontSize: 17, fontWeight: '600' },
  headerSub: { color: C.muted, fontSize: 12, marginTop: 2 },
  headerActions: { flexDirection: 'row', gap: 14 },
  link: { color: C.accent, fontSize: 13, fontWeight: '600' },

  list: { padding: 16, gap: 8 },
  bubble: { maxWidth: '78%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: C.ink },
  bubbleTheirs: { alignSelf: 'flex-start', backgroundColor: C.surface, borderColor: C.line, borderWidth: 1 },
  textMine: { color: '#FFF', fontSize: 15 },
  textTheirs: { color: C.ink, fontSize: 15 },
  meta: { color: C.muted, fontSize: 10, marginTop: 4 },
  metaMine: { color: 'rgba(255,255,255,0.6)' },

  notice: {
    color: C.ink, fontSize: 12, textAlign: 'center',
    paddingVertical: 8, backgroundColor: '#EFEFEF'
  },

  composer: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, backgroundColor: C.surface, borderTopColor: C.line, borderTopWidth: 1
  },
  composerInput: {
    flex: 1, backgroundColor: C.bg, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, color: C.ink, fontSize: 15
  },
  send: { backgroundColor: C.ink, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10 },
  sendDisabled: { backgroundColor: C.muted },
  sendText: { color: '#FFF', fontWeight: '600', fontSize: 14 }
})

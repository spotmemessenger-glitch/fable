/**
 * Spot Me — demo people.
 *
 * A P2P app tested alone is an empty room. When settings.demoMode is on, a
 * cast of clearly-flagged demo people populates Discovery and can hold a
 * conversation, so every screen works the moment the app opens. They are
 * local-only — nothing about them touches the network — and every surface
 * that shows one carries a "demo" chip so they can never be mistaken for a
 * real person. Turning demoMode off removes all of them.
 */
import { PHOTOS } from './photos.js'
import { randomHex } from './db.js'

/** Design reference map centre (the locked Discovery screen's Whitechapel). */
export const FALLBACK_CENTRE = { lat: 51.5152, lon: -0.0716 }

const CAST = [
  {
    id: 'demo-sophia', name: 'Sophia', lang: 'ja', age: 24, photo: 1,
    tags: ['photography', 'coffee'], dLat: 0.00021, dLon: 0.00034,
    replies: ['こんにちは！元気ですか？', '面白いですね！', 'このアプリすごいですね。翻訳が自然！', 'また話しましょう！']
  },
  {
    id: 'demo-marcus', name: 'Marcus', lang: 'en', age: 27, photo: 2,
    tags: ['runner', 'startups'], dLat: -0.00058, dLon: 0.00012,
    replies: ['Hey! Just saw you nearby.', 'That works — same time tomorrow?', 'Ha, exactly.', 'Send me the location?']
  },
  {
    id: 'demo-emma', name: 'Emma', lang: 'es', age: 23, photo: 3,
    tags: ['música', 'viajes'], dLat: 0.00102, dLon: -0.00071,
    replies: ['¡Hola! ¿Qué tal?', '¡Qué bueno verte por aquí!', 'Jajaja, sí, totalmente.', '¿Nos vemos en el parque?']
  },
  {
    id: 'demo-priya', name: 'Priya', lang: 'ta', age: 25, photo: 4,
    tags: ['books', 'chai'], dLat: -0.00033, dLon: -0.00095,
    replies: ['வணக்கம்! எப்படி இருக்கீங்க?', 'ரொம்ப நல்லா இருக்கு!', 'சரி, அப்புறம் பேசலாம்.', 'இந்த app சூப்பர்!']
  },
  {
    id: 'demo-arjun', name: 'Arjun', lang: 'hi', age: 28, photo: 5,
    tags: ['cricket', 'food'], dLat: 0.00186, dLon: 0.00122,
    replies: ['नमस्ते! कैसे हो?', 'बिलकुल सही कहा!', 'हाहा, मज़ा आ गया।', 'कल मिलते हैं फिर।']
  },
  {
    id: 'demo-yuki', name: 'Yuki', lang: 'ja', age: 22, photo: 6,
    tags: ['art', 'ramen'], dLat: -0.00251, dLon: 0.00201,
    replies: ['はじめまして！', 'いいですね！', 'ありがとう😊', 'また後でね！']
  },
  {
    id: 'demo-leila', name: 'Leila', lang: 'ar', age: 26, photo: 7,
    tags: ['design', 'tea'], dLat: 0.00301, dLon: -0.00244,
    replies: ['مرحبا! كيف حالك؟', 'رائع جدا!', 'ههههه صحيح', 'إلى اللقاء!']
  },
  {
    id: 'demo-diego', name: 'Diego', lang: 'pt', age: 29, photo: 8,
    tags: ['futebol', 'praia'], dLat: -0.00398, dLon: -0.00312,
    replies: ['Oi! Tudo bem?', 'Que legal!', 'Haha com certeza.', 'Até mais!']
  }
]

export const DEMO_PEOPLE = CAST.map((p) => ({ ...p, avatar: PHOTOS[p.photo] || PHOTOS[0] }))

export const isDemo = (id) => typeof id === 'string' && id.startsWith('demo-')

/** Discovery-shaped peer objects positioned around the user (or the fallback). */
export function demoPeers (myPos) {
  const centre = myPos || FALLBACK_CENTRE
  const now = Date.now()
  return DEMO_PEOPLE.map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    lang: p.lang,
    age: p.age,
    tags: p.tags,
    lat: centre.lat + p.dLat,
    lon: centre.lon + p.dLon,
    ghost: false,
    ts: now,
    demo: true
  }))
}

/**
 * A fake net with the same surface as createNet, backed by a chatty bot.
 * The bot answers in its own language after a human-feeling delay, which is
 * exactly what exercises the translation pipeline.
 */
export function demoNet (convo, store, hooks = {}) {
  const person = DEMO_PEOPLE.find((p) => p.id === convo.peer?.id) || DEMO_PEOPLE[0]
  let counter = 0
  let alive = true

  function reply () {
    if (!alive) return
    const text = person.replies[counter % person.replies.length]
    counter += 1
    hooks.onTyping?.({ on: true, name: person.name })
    setTimeout(() => {
      if (!alive) return
      hooks.onTyping?.({ on: false, name: person.name })
      const message = {
        id: randomHex(8),
        from: person.id,
        name: person.name,
        lang: person.lang,
        ts: Date.now(),
        kind: 'text',
        text
      }
      if (store.add(message)) hooks.onIncoming?.(message)
    }, 1200 + Math.random() * 1800)
  }

  return {
    sendMessage (message) {
      // React to a picture or voice note too — silence there feels broken.
      reply()
      if (message.kind !== 'text' && Math.random() < 0.5) {
        setTimeout(() => hooks.onReaction?.({ target: message.id, emoji: '❤️', from: person.id }), 900)
      }
    },
    sendReaction () { /* bots take compliments quietly */ },
    sendProfile () {},
    sendDelete () {},
    sendTyping () {},
    sendRead () {},
    sendSeen () {},
    peerCount: () => 1,
    leave () { alive = false }
  }
}

/**
 * First-run seeding: one incoming request so the Requests strip is alive.
 * Runs once per identity namespace; accepting it creates a demo conversation.
 */
export function seedDemo (db) {
  const FLAG = 'spotme:demo-seeded'
  try {
    if (localStorage.getItem(FLAG)) return
    localStorage.setItem(FLAG, '1')
  } catch { return }
  const sophia = DEMO_PEOPLE[0]
  db.addRequest({
    fromId: sophia.id,
    name: sophia.name,
    avatar: sophia.avatar,
    lang: sophia.lang,
    text: 'こんにちは！近くにいるみたいですね。',
    roomId: `demo-${randomHex(6)}`,
    secret: randomHex(8),
    mode: 'nearby'
  })
}

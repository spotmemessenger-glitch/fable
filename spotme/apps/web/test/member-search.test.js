/**
 * Proves you can actually FIND someone to add to a group.
 *
 * THE BUG THIS PINS, reproduced against production on 2026-07-31:
 * the member picker resolved strangers with an EXACT-match lookup
 * (`/api/users/lookup?username=`) and refused to query at all below three
 * characters. Real accounts existed — @yuva, @yyy, @yyy22, @arjun_live,
 * @spot44 — yet typing "yu" issued no request, and typing "yuv" 404'd and was
 * swallowed into `null`, so the picker said "Nobody is registered as @yuv"
 * while @yuva sat one character away.
 *
 * Because the creation wizard will not advance until two members are picked,
 * a picker that finds nobody does not degrade group creation — it BLOCKS it.
 * That is the reported symptom: "the name gets created but adding members
 * isn't possible".
 *
 * The server already answered prefix queries the whole time
 * (`GET /api/username?q=` — 1-16 chars, unauthenticated), and the inbox search
 * had been using them for months. Only the picker was asking the wrong way.
 *
 * Everything here runs offline against a stubbed fetch.
 */
const { searchUsers } = await import('../src/lib/api.js')

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) {
    results[name] = false
    results[`${name} (threw: ${e.message})`] = false
  }
}

/* ------------------------------------------------------------- fixtures */

/** The five handles that really existed in production when this was written. */
const REGISTRY = [
  { id: 'u_yuva', name: 'Yuva', username: 'yuva' },
  { id: 'u_yyy', name: 'Yyy', username: 'yyy' },
  { id: 'u_yyy22', name: 'Yyy22', username: 'yyy22' },
  { id: 'u_arjun', name: 'Arjun', username: 'arjun_live' },
  { id: 'u_spot44', name: 'Spot', username: 'spot44' }
]

let lastUrl = null

/** Stands in for the real `GET /api/username?q=` — prefix match, same shape. */
function stubFetch ({ ok = true, status = 200 } = {}) {
  globalThis.fetch = async (url) => {
    lastUrl = String(url)
    if (!ok) return { ok: false, status, json: async () => ({}) }
    const q = new URL(String(url), 'http://x').searchParams.get('q') || ''
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: REGISTRY.filter((u) => u.username.startsWith(q)) })
    }
  }
}

/** Nothing may reach the network; a call here means the query was not gated. */
function forbidFetch () {
  globalThis.fetch = async () => { throw new Error('fetch should not have been called') }
}

/* ---------------------------------------------------------------- tests */

await checkAsync('a two-letter query finds @yuva — the exact bug reported', async () => {
  stubFetch()
  const found = await searchUsers('yu')
  return found.length === 1 && found[0].username === 'yuva'
})

await checkAsync('a partial handle finds the real one ("yuv" must reach @yuva)', async () => {
  stubFetch()
  const found = await searchUsers('yuv')
  return found.some((u) => u.username === 'yuva')
})

await checkAsync('a single character searches, because the server allows 1-16', async () => {
  stubFetch()
  const found = await searchUsers('y')
  return found.length === 3
})

await checkAsync('it asks the PREFIX endpoint, not the exact-match one', async () => {
  stubFetch()
  await searchUsers('yu')
  return lastUrl.includes('/api/username?q=yu') && !lastUrl.includes('/users/lookup')
})

await checkAsync('a leading @ is stripped rather than searched for', async () => {
  stubFetch()
  const found = await searchUsers('@yuva')
  return found.length === 1 && found[0].username === 'yuva' && lastUrl.includes('q=yuva')
})

await checkAsync('queries are lowercased so "YU" still finds @yuva', async () => {
  stubFetch()
  const found = await searchUsers('YU')
  return found.length === 1 && found[0].username === 'yuva'
})

await checkAsync('you are never offered to yourself', async () => {
  stubFetch()
  const found = await searchUsers('y', { excludeId: 'u_yuva' })
  return found.length === 2 && !found.some((u) => u.id === 'u_yuva')
})

await checkAsync('an empty query never hits the network', async () => {
  forbidFetch()
  const found = await searchUsers('   ')
  return Array.isArray(found) && found.length === 0
})

await checkAsync('a character the handle grammar forbids never hits the network', async () => {
  forbidFetch()
  const found = await searchUsers('yu va!')
  return Array.isArray(found) && found.length === 0
})

await checkAsync('a failing registry yields no results instead of throwing mid-keystroke', async () => {
  stubFetch({ ok: false, status: 500 })
  const found = await searchUsers('yu')
  return Array.isArray(found) && found.length === 0
})

await checkAsync('a network error yields no results instead of throwing', async () => {
  globalThis.fetch = async () => { throw new Error('offline') }
  const found = await searchUsers('yu')
  return Array.isArray(found) && found.length === 0
})

await checkAsync('a malformed body cannot crash the picker', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: 'nope' }) })
  const found = await searchUsers('yu')
  return Array.isArray(found) && found.length === 0
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  member picker — finding people to add')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)

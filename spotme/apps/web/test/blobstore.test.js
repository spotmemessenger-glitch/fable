/**
 * The media store must be ABSENT-SAFE, because absence is a real device state.
 *
 * Safari private mode has refused IndexedDB, embedded WebViews disable it, and
 * this test runner has no such global at all. `store.js` leans on that: when
 * IndexedDB is unavailable it keeps the old data-URL-in-localStorage behaviour
 * and its quota-shedding ladder, and the other suites' checks are only
 * meaningful because that fallback holds.
 *
 * So this pins the contract the fallback depends on: every entry point answers
 * "no" instead of throwing, and none of them requires a browser. A single
 * unguarded `indexedDB.open()` here would take the app down on exactly the
 * devices least able to report it.
 *
 * The HAPPY path is deliberately not faked. A hand-rolled IndexedDB shim would
 * test the shim, not the browser; that half is verified against real IndexedDB
 * in a real browser and recorded in the commit message.
 */
const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* No localStorage, no indexedDB, no Blob — a deliberately bare environment. */
const blobs = await import('../src/lib/blobstore.js')

check('available() reports false rather than throwing when there is no IndexedDB', () =>
  blobs.available() === false)

check('mediaKey scopes by room, so clearing one chat cannot reach another', () => {
  const a = blobs.mediaKey('room-a', 'msg-1')
  const b = blobs.mediaKey('room-b', 'msg-1')
  return a !== b && a.includes('room-a') && a.includes('msg-1')
})

await checkAsync('put() answers false — the caller then keeps the data URL', async () =>
  (await blobs.put('room-a m1', new Uint8Array([1, 2, 3]), 'image/png')) === false)

await checkAsync('get() answers null, so a missing blob is not an exception', async () =>
  (await blobs.get('room-a m1')) === null)

await checkAsync('del() answers false', async () =>
  (await blobs.del('room-a m1')) === false)

await checkAsync('delRoom() answers false', async () =>
  (await blobs.delRoom('room-a')) === false)

await checkAsync('clearAll() answers false — wipeDevice must not throw on a bare device', async () =>
  (await blobs.clearAll()) === false)

/* Guards that hold regardless of storage. */

await checkAsync('a view-once photo is REFUSED even when storage is asked nicely', async () =>
  (await blobs.put('room-a vo', new Uint8Array([1, 2, 3]), 'image/jpeg', { viewOnce: true })) === false)

await checkAsync('empty bytes are refused rather than stored as a zero-length blob', async () =>
  (await blobs.put('room-a empty', new Uint8Array(0), 'image/png')) === false)

await checkAsync('a missing key is refused', async () =>
  (await blobs.put('', new Uint8Array([1]), 'image/png')) === false)

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  blobstore — absent-safe by contract')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)

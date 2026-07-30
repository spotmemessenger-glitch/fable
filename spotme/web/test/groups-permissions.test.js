/**
 * Proves the group permission gates match the server's rules.
 *
 * These decide whether Ban, Remove and Transfer are even offered. Getting them
 * wrong is not a cosmetic bug: too lax and the app offers destructive actions
 * the server refuses (which reads as "the app is broken"); too strict and a
 * real moderator silently cannot moderate.
 *
 * Mirrors groups.service.ts:
 *   setRole           OWNER or canAddAdmin, never at or above your own rank
 *   ban/mute/remove   OWNER or the matching grant, target must rank lower
 *   transfer/delete   OWNER only
 */
import { rank, outranks, may, ROLE_LABEL } from '../src/lib/group-perms.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch { results[name] = false }
}

const group = (myRole, myGrants = {}) => ({ myRole, myGrants })

/* 1 — the ladder is ordered, and unknown roles sit at the bottom rather than
 *     throwing or, worse, ranking above a member. */
check('roles rank OWNER > ADMIN > MODERATOR > MEMBER', () =>
  rank('OWNER') > rank('ADMIN') &&
  rank('ADMIN') > rank('MODERATOR') &&
  rank('MODERATOR') > rank('MEMBER'))

check('an unknown role ranks lowest, it does not throw', () =>
  rank(undefined) === 0 && rank('WIZARD') === 0)

/* 2 — equal rank must NOT be actionable. This is the one that stops two admins
 *     from banning each other and emptying the admin list. */
check('an admin cannot act on another admin', () => outranks('ADMIN', 'ADMIN') === false)
check('an admin can act on a moderator', () => outranks('ADMIN', 'MODERATOR') === true)
check('a member can act on nobody', () =>
  outranks('MEMBER', 'MEMBER') === false && outranks('MEMBER', 'MODERATOR') === false)
check('nobody outranks the owner', () =>
  outranks('ADMIN', 'OWNER') === false && outranks('MODERATOR', 'OWNER') === false)

/* 3 — the owner needs no explicit grants; everyone else needs the exact one. */
check('the owner holds every grant implicitly', () =>
  may(group('OWNER'), 'canBan') && may(group('OWNER'), 'canRemove') &&
  may(group('OWNER'), 'canAddAdmin'))

check('a grant is per-permission, not a blanket', () => {
  const mod = group('MODERATOR', { canBan: true, canRemove: false })
  return may(mod, 'canBan') === true && may(mod, 'canRemove') === false
})

check('an ungranted member may nothing', () =>
  may(group('MEMBER'), 'canBan') === false && may(group('MEMBER'), 'canMute') === false)

check('a missing or malformed group denies rather than throws', () =>
  may(null, 'canBan') === false && may({}, 'canBan') === false)

/* 4 — every role has a label; a blank chip in the member list is a bug. */
check('every role has a display label', () =>
  ['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER'].every((r) => Boolean(ROLE_LABEL[r])))

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  groups — permission gates')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)

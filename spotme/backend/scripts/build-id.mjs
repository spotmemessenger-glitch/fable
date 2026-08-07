/**
 * Compute a build identity FROM SOURCE, and write it into dist/.
 *
 * WHY SOURCE AND NOT THE ARTEFACT. The obvious build id is a hash of
 * `dist/main.js` — and it proves nothing, because a stale artefact hashes
 * itself and matches. The question this exists to answer is "is the process I
 * am talking to built from the source in front of me", so the id has to be a
 * function of the SOURCE, embedded into the artefact at build time. A dist/
 * left over from older source then carries an older id and the mismatch is
 * visible.
 *
 * That is exactly the failure mode that hid the incremental-build bug: a build
 * that emitted nothing still left a dist/ that looked plausible.
 *
 * SAFE TO EXPOSE. It is a hash of file paths and contents — no secret, no
 * environment value, no absolute path, no dependency inventory. Anyone can
 * recompute it from a checkout, which is the point.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname: on Windows .pathname yields '/C:/…' which
// join() turns into 'C:\C:\…' (ENOENT). Identical result on POSIX.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

function walk (dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {          // sorted: order must not vary
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const h = createHash('sha256')
for (const file of walk(SRC)) {
  // Path AND contents. Renaming a file with identical contents is a different
  // build, and a hash over contents alone would call the two the same.
  h.update(relative(ROOT, file).replace(/\\/g, '/'))
  h.update('\0')
  h.update(readFileSync(file))
  h.update('\0')
}
const id = h.digest('hex').slice(0, 16)

mkdirSync(join(ROOT, 'dist'), { recursive: true })
writeFileSync(join(ROOT, 'dist', 'BUILD_ID'), id + '\n')
process.stdout.write(id + '\n')

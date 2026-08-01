/**
 * Spot Me web — the smallest lint gate that catches real defects.
 *
 * WHY THESE RULES AND NOT A PRESET. `eslint:recommended` bundles stylistic and
 * opinion rules alongside correctness ones, and turning it on here would have
 * demanded hundreds of mechanical edits across a codebase that is otherwise
 * fine. The instruction was a gate, not a reformatting project, so this is
 * correctness only: rules whose violations are bugs, never rules about how code
 * should look. Nothing here can be satisfied by reformatting.
 *
 * Measured before it was written. A naive config reported 33 errors; 22 of
 * those were its own fault, and the two settings below are what removed them:
 *
 *   globals.browser      hand-listing globals missed getComputedStyle,
 *                        AbortController, caches, File, URLSearchParams,
 *                        SpeechSynthesisUtterance, self, prompt and
 *                        cancelAnimationFrame — every one a false positive
 *   ignoreRestSiblings   `const { seq, total: _t, ...envelope } = meta` is how
 *                        this codebase drops fields ON PURPOSE. Without this
 *                        the idiom is an error, and "fixing" it would mean
 *                        rewriting working destructures
 *
 * WHAT IS DELIBERATELY ABSENT: `tsc --checkJs`. Measured at 1,672 errors from
 * `src/main.js` alone, because this is plain ESM JavaScript with JSDoc on 6 of
 * 49 files. Adopting it would need either mass annotation or blanket
 * suppression. A tsconfig with `checkJs: false` can give editors inference
 * later without gating CI on it; that is a separate decision.
 *
 * The 14 zero-byte files tracked under src/ (audit 10-PRIORITY-0-AUDIT.md §6)
 * are not ignored here and do not need to be: none has a .js extension, so the
 * glob never sees them. They remain debris worth deleting, separately.
 */
import globals from 'globals'

export default [
  {
    files: ['src/**/*.js', 'test/**/*.js', '*.js', '*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        // Injected by the Capacitor WebView, not by either environment above.
        Capacitor: 'readonly'
      }
    },
    // A deliberate `eslint-disable-next-line no-console` in vite.config.js
    // documents an intentional warning. `no-console` is not enabled here, so
    // the default 'warn' for unused directives fires on a comment that is
    // documentation rather than a stale suppression.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // Each of these fails only on something that is wrong at runtime.
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-cond-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-constant-binary-expression': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-sparse-arrays': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error'
    }
  }
]

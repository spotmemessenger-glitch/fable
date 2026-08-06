/**
 * Hash routing — splitting `#/posts?m=<id>` into a route and its parameters.
 *
 * This lives apart from `main.js` for one reason: `main.js` reaches the DOM at
 * import time, so anything defined there can only be tested by reading its
 * source as text. Routing is the seam a share link depends on, and it deserves
 * a test that runs the actual function.
 *
 * The bug it exists to prevent: the router looked the WHOLE hash up in its
 * route table, so `#/posts?m=abc` matched nothing and fell through to the
 * default screen. Every shared post link opened the wrong view.
 */

/**
 * Split a location hash into its route path and query parameters.
 *
 * @param {string} hash e.g. `#/posts?m=abc`
 * @returns {{ path: string, params: URLSearchParams }}
 */
export function splitHash (hash) {
  const h = typeof hash === 'string' ? hash : ''
  const q = h.indexOf('?')
  return {
    path: q === -1 ? h : h.slice(0, q),
    params: new URLSearchParams(q === -1 ? '' : h.slice(q + 1))
  }
}

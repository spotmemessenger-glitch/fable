/**
 * Deterministic synthetic corpus for the search benchmark.
 *
 * Three record kinds that mirror what Spot Me actually searches: usernames,
 * places, and Exchange-style listings. Generation is seeded so every run
 * indexes the identical corpus and the numbers are comparable across engines
 * and across runs.
 */

/** The canonical corpus seed — recorded in the benchmark manifest. */
export const CORPUS_SEED = 1234;

/** Tiny seeded PRNG (mulberry32) — reproducible, no Math.random. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['alex', 'priya', 'sam', 'wei', 'omar', 'lena', 'raj', 'nina', 'tom', 'ivy', 'kofi', 'mira', 'jack', 'sara', 'dev', 'yuki'];
const LAST = ['kumar', 'smith', 'chen', 'ali', 'garcia', 'okoro', 'patel', 'novak', 'khan', 'silva', 'mori', 'dubois', 'reddy', 'brown'];
const PLACES = ['Park', 'Cafe', 'Library', 'Gym', 'Market', 'Studio', 'Rooftop', 'Garden', 'Arcade', 'Bakery', 'Coworking', 'Pier'];
const AREAS = ['Cubbon', 'Riverside', 'Old Town', 'Harbour', 'Midtown', 'Greenwood', 'Hillside', 'Lakeview', 'Central', 'Uptown'];
const CATEGORIES = ['services/plumbing', 'services/tutoring', 'goods/furniture', 'goods/electronics', 'services/moving', 'services/design', 'goods/bikes', 'services/cleaning'];
const NEED_TEMPLATES = [
  'Leaking kitchen tap, need it fixed tonight',
  'Looking for a maths tutor for my daughter',
  'Need help moving a sofa this weekend',
  'Want someone to assemble flat-pack furniture',
  'Need a logo designed for a small cafe',
  'Looking to buy a used mountain bike',
  'Need a deep clean before guests arrive',
  'Want a second-hand desk in good condition',
];
const OFFER_TEMPLATES = [
  'Offering plumbing services, available tonight',
  'Experienced maths tutor, evenings free',
  'Can help move furniture, have a van',
  'I assemble flat-pack furniture quickly',
  'Freelance designer offering logos for small businesses',
  'Selling a mountain bike, barely used',
  'Professional cleaner available this week',
  'Selling a solid oak desk, great condition',
];

/**
 * Build `n` records. Fields are shared across kinds so one schema indexes all.
 * @returns {{id:string,kind:string,title:string,text:string,category:string,tags:string[],geoCell:string}[]}
 */
export function buildCorpus(n = 20000, seed = CORPUS_SEED) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    const geoCell = `${(r() * 90).toFixed(2)}:${(r() * 180).toFixed(2)}`;
    if (roll < 0.34) {
      const name = `${pick(FIRST)}_${pick(LAST)}_${Math.floor(r() * 100)}`;
      out.push({ id: `u${i}`, kind: 'username', title: name, text: name.replace(/_/g, ' '), category: 'user', tags: ['user'], geoCell });
    } else if (roll < 0.67) {
      const name = `${pick(AREAS)} ${pick(PLACES)}`;
      out.push({ id: `p${i}`, kind: 'place', title: name, text: `${name} in the ${pick(AREAS)} area`, category: 'place', tags: ['place'], geoCell });
    } else {
      const isOffer = r() < 0.5;
      const text = pick(isOffer ? OFFER_TEMPLATES : NEED_TEMPLATES);
      const cat = pick(CATEGORIES);
      out.push({ id: `l${i}`, kind: isOffer ? 'offer' : 'need', title: text.slice(0, 40), text, category: cat, tags: cat.split('/'), geoCell });
    }
  }
  return out;
}

/**
 * Query set: exact terms, partial/prefix, and DELIBERATELY MISSPELLED variants
 * whose correct-spelling term appears in the corpus (measures typo tolerance).
 */
export const QUERIES = {
  exact: ['plumbing', 'mountain bike', 'maths tutor', 'oak desk', 'cafe', 'moving'],
  partial: ['plumb', 'bik', 'tuto', 'furnitur', 'clean'],
  typo: [
    { q: 'plumbnig', expect: 'plumb' },
    { q: 'moutain bike', expect: 'mountain' },
    { q: 'mathz tutor', expect: 'tutor' },
    { q: 'funiture', expect: 'furniture' },
    { q: 'librbary', expect: 'library' },
    { q: 'celaning', expect: 'clean' },
  ],
};

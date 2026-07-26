#!/usr/bin/env node
/**
 * store-intel — pull REAL App Store + Play Store metadata and reviews.
 *
 * The ASO/PM skills describe how to analyse competitors; none of them fetch
 * anything. This does the fetching, so the analysis runs on real numbers
 * instead of a plausible-sounding guess.
 *
 * Deterministic-numbers rule: this script computes every count and percentage.
 * The agent narrates the output; it never invents a figure the script did not
 * produce. A failed fetch is reported as a failure, never as an estimate.
 *
 *   node store-intel.mjs --apple 570060128 --google com.duolingo \
 *     --country us --pages 10 --out ../App-Reviews/duolingo
 *
 * Apple needs no key (public RSS + iTunes lookup).
 * Google uses google-play-scraper (unofficial; may break when Play changes).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const APPLE_MAX_PAGES = 10;      // Apple stops serving past page 10
const GOOGLE_DEFAULT_REVIEWS = 500;
const GOOGLE_BATCH_SIZE = 150;
const REQUEST_GAP_MS = 250;      // be a polite client

/** Complaint buckets. Keyword match is crude but deterministic and auditable. */
const BUCKETS = {
  'bugs-crashes':    /\b(crash|crashes|crashed|bug|buggy|freeze|frozen|glitch|broken|doesn'?t work|not working|error)\b/i,
  'pricing-paywall': /\b(expensive|overpriced|price|pricing|paywall|subscription|subscribe|refund|scam|rip off|ripoff|free trial|charged)\b/i,
  'ads':             /\b(ads?|advert|advertisement|commercial)\b/i,
  'ux-confusion':    /\b(confus|hard to use|difficult to|can'?t find|unintuitive|complicated|frustrat|annoying|clunky)\b/i,
  'performance':     /\b(slow|lag|laggy|battery|drain|heavy|memory|loading forever)\b/i,
  'onboarding':      /\b(sign ?up|signup|log ?in|login|register|account|verification|onboarding|tutorial)\b/i,
  'feature-request': /\b(wish|please add|would be (great|nice)|hope you|need(s)? (a|an|to)|missing|should have|feature request)\b/i,
  'praise':          /\b(love|amazing|excellent|perfect|best app|awesome|fantastic|brilliant)\b/i,
};

function parseArgs(argv) {
  const out = { country: 'us', pages: 5, googleReviews: GOOGLE_DEFAULT_REVIEWS };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const val = argv[i + 1];
    if (!key || val === undefined) continue;
    if (key === 'pages') out.pages = Math.min(Number(val), APPLE_MAX_PAGES);
    else if (key === 'googleReviews') out.googleReviews = Number(val);
    else out[key] = val;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'store-intel/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---------------------------------------------------------------- Apple

async function appleMeta(id, country) {
  const data = await getJson(
    `https://itunes.apple.com/lookup?id=${id}&country=${country}`
  );
  const app = data.results?.[0];
  if (!app) throw new Error(`no App Store result for id=${id} country=${country}`);
  return {
    store: 'apple',
    id,
    name: app.trackName,
    seller: app.sellerName,
    price: app.price,
    currency: app.currency,
    rating: app.averageUserRating,
    ratingCount: app.userRatingCount,
    ratingCountCurrentVersion: app.userRatingCountForCurrentVersion,
    version: app.version,
    lastUpdated: app.currentVersionReleaseDate,
    firstReleased: app.releaseDate,
    genres: app.genres,
    contentRating: app.contentAdvisoryRating,
    screenshotCount: (app.screenshotUrls || []).length,
    description: app.description,
    releaseNotes: app.releaseNotes,
    url: app.trackViewUrl,
  };
}

async function appleReviews(id, country, pages) {
  const reviews = [];
  const failures = [];
  for (let page = 1; page <= pages; page += 1) {
    const url = `https://itunes.apple.com/${country}/rss/customerreviews/id=${id}/sortBy=mostRecent/page=${page}/json`;
    try {
      const data = await getJson(url);
      const entries = data.feed?.entry || [];
      // Page 1 entry[0] is the app itself, not a review — the rating guard skips it.
      for (const e of entries) {
        if (!e['im:rating']) continue;
        reviews.push({
          score: Number(e['im:rating'].label),
          title: e.title?.label || '',
          text: e.content?.label || '',
          version: e['im:version']?.label || '',
          date: e.updated?.label || '',
        });
      }
      if (entries.length === 0) break;
    } catch (err) {
      failures.push({ page, error: String(err.message) });
    }
    await sleep(REQUEST_GAP_MS);
  }
  return { reviews, failures };
}

// ---------------------------------------------------------------- Google

async function googleAll(appId, country, wanted) {
  const mod = await import('google-play-scraper');
  const gplay = mod.default || mod;
  const app = await gplay.app({ appId, country });
  const meta = {
    store: 'google',
    id: appId,
    name: app.title,
    seller: app.developer,
    price: app.price,
    currency: app.currency,
    free: app.free,
    rating: app.score,
    ratingCount: app.ratings,
    reviewCount: app.reviews,
    installs: app.installs,
    version: app.version,
    lastUpdated: app.updated ? new Date(app.updated).toISOString() : null,
    genre: app.genre,
    contentRating: app.contentRating,
    adSupported: app.adSupported,
    offersIAP: app.offersIAP,
    inAppProductPrice: app.IAPRange,
    screenshotCount: (app.screenshots || []).length,
    description: app.description,
    url: app.url,
  };

  const reviews = [];
  let token = null;
  while (reviews.length < wanted) {
    const batch = await gplay.reviews({
      appId,
      country,
      sort: gplay.sort.NEWEST,
      num: Math.min(GOOGLE_BATCH_SIZE, wanted - reviews.length),
      paginate: true,
      nextPaginationToken: token,
    });
    if (!batch.data?.length) break;
    for (const r of batch.data) {
      reviews.push({
        score: r.score,
        title: '',
        text: r.text || '',
        version: r.version || '',
        date: r.date || '',
        thumbsUp: r.thumbsUp || 0,
      });
    }
    token = batch.nextPaginationToken;
    if (!token) break;
    await sleep(REQUEST_GAP_MS);
  }
  return { meta, reviews };
}

// ---------------------------------------------------------------- analysis

function analyse(reviews) {
  const total = reviews.length;
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const buckets = Object.fromEntries(Object.keys(BUCKETS).map((k) => [k, []]));

  for (const r of reviews) {
    if (dist[r.score] !== undefined) dist[r.score] += 1;
    const blob = `${r.title} ${r.text}`;
    for (const [name, re] of Object.entries(BUCKETS)) {
      if (re.test(blob)) buckets[name].push(r);
    }
  }

  const negative = reviews.filter((r) => r.score <= 2);
  const summary = Object.entries(buckets)
    .map(([name, list]) => ({
      bucket: name,
      count: list.length,
      pctOfSample: total ? +((list.length / total) * 100).toFixed(1) : 0,
      negCount: list.filter((r) => r.score <= 2).length,
      examples: list
        .filter((r) => r.score <= 2 || name === 'praise')
        .slice(0, 3)
        .map((r) => ({ score: r.score, text: r.text.slice(0, 240) })),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    sampleSize: total,
    scoreDistribution: dist,
    meanOfSample: total
      ? +(reviews.reduce((s, r) => s + r.score, 0) / total).toFixed(2)
      : null,
    negativeShareOfSample: total
      ? +((negative.length / total) * 100).toFixed(1)
      : 0,
    buckets: summary,
  };
}

function markdown(result) {
  const L = [];
  const stamp = result.pulledAt.slice(0, 10);
  L.push(`# Store intelligence — ${result.label}`, '', `Pulled ${stamp}. Every figure below is computed from the fetched sample, not estimated.`, '');

  for (const store of ['apple', 'google']) {
    const s = result[store];
    if (!s) continue;
    const heading = store === 'apple' ? 'App Store' : 'Play Store';
    if (s.error) {
      L.push(`## ${heading}`, '', `**FETCH FAILED** — ${s.error}`, '', 'No data. Do not substitute an estimate.', '');
      continue;
    }
    const m = s.meta;
    const a = s.analysis;
    L.push(`## ${heading} — ${m.name}`, '');
    L.push('| Field | Value |', '|---|---|');
    L.push(`| Rating (all-time) | ${m.rating ?? 'n/a'} |`);
    L.push(`| Rating count | ${m.ratingCount?.toLocaleString() ?? 'n/a'} |`);
    if (m.installs) L.push(`| Installs | ${m.installs} |`);
    L.push(`| Price | ${m.price} ${m.currency ?? ''} |`);
    if (m.offersIAP !== undefined) L.push(`| In-app purchases | ${m.offersIAP ? `yes (${m.inAppProductPrice ?? 'range not published'})` : 'no'} |`);
    if (m.adSupported !== undefined) L.push(`| Ad supported | ${m.adSupported ? 'yes' : 'no'} |`);
    L.push(`| Version | ${m.version} |`);
    L.push(`| Last updated | ${m.lastUpdated ?? 'n/a'} |`);
    L.push(`| Screenshots | ${m.screenshotCount} |`);
    L.push('');
    L.push(`### Review sample (n=${a.sampleSize}${s.failures?.length ? `, ${s.failures.length} page(s) failed` : ''})`, '');
    L.push(`Sample mean **${a.meanOfSample}** vs all-time **${m.rating}**. Negative (1–2★) share of sample: **${a.negativeShareOfSample}%**.`, '');
    L.push(`Distribution: ${[5, 4, 3, 2, 1].map((k) => `${k}★ ${a.scoreDistribution[k]}`).join(' · ')}`, '');
    L.push('| Theme | Mentions | % of sample | of which 1–2★ |', '|---|---:|---:|---:|');
    for (const b of a.buckets) {
      L.push(`| ${b.bucket} | ${b.count} | ${b.pctOfSample}% | ${b.negCount} |`);
    }
    L.push('');
    L.push('> Sample is the most-recent N reviews, not a random sample of all reviews. Recency bias applies: it reflects the current build, which is usually what you want, but it is not the lifetime picture.', '');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv);
if (!args.apple && !args.google) {
  console.error('Usage: node store-intel.mjs --apple <id> --google <package> [--country us] [--pages 10] [--out path/prefix]');
  process.exit(1);
}

const result = { label: args.google || args.apple, country: args.country, pulledAt: new Date().toISOString() };

if (args.apple) {
  try {
    const meta = await appleMeta(args.apple, args.country);
    const { reviews, failures } = await appleReviews(args.apple, args.country, args.pages);
    result.apple = { meta, failures, reviews, analysis: analyse(reviews) };
  } catch (err) {
    result.apple = { error: String(err.message) };
  }
}

if (args.google) {
  try {
    const { meta, reviews } = await googleAll(args.google, args.country, args.googleReviews);
    result.google = { meta, failures: [], reviews, analysis: analyse(reviews) };
  } catch (err) {
    result.google = { error: String(err.message) };
  }
}

const md = markdown(result);
console.log(md);

if (args.out) {
  const base = resolve(process.cwd(), args.out);
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${base}.md`, md);
  console.error(`\nWrote ${base}.json and ${base}.md`);
}

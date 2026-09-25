// termsNormalize.mjs — what the TERMS-PAGE HASH WATCHER hashes, as PURE functions
// (scripts/watch-venue-terms.mjs does the I/O; tests/unit/termsNormalize.test.ts
// exercises this exact code).
//
// WHAT COUNTS AS A TERMS CHANGE (ruling 2026-09-25): any edit to the page's visible
// text EXCEPT live market figures the venue embeds for marketing. Those move every
// tick and say nothing about the exit gate:
//   - a yield rate tagged APY/APR ("3.60% apy")            → <rate>
//   - an amount with a k/m/b/bn/million/billion suffix     → <amount>
//     ("total susds supply 4.46b", "$1.2m tvl")
//   - the copyright year ("© 2026")                        → <year>
// Everything else still counts: fees ("0.5% fee"), durations ("7 days"), caps,
// limits, bare numbers, and any wording change. A fee or cooldown edit therefore
// still fires gate_change; a TVL tick no longer does.
//
// Measured cause (2026-09-25): sky.money/susds renders "3.60% apy · total susds
// supply 4.46b". The supply figure flipped the v1 hash 75 times in 19 days, which
// held the sUSDS gate_change alarm open permanently.
//
// VERSIONING: hashes are stored as `${TERMS_HASH_VERSION}:${sha256}`. A stored hash
// without the current prefix was produced by an older normalizer, so the watcher
// RE-BASELINES it (new row, NO event) instead of reporting a change the normalizer
// itself caused. Bump the version whenever normalization changes.

import { createHash } from 'node:crypto'

export const TERMS_HASH_VERSION = 'v2'

/**
 * Visible text only: drop comments, script/style/head blocks, strip tags,
 * collapse whitespace, trim, lowercase. Cosmetic markup churn never flaps the hash.
 */
export function normalizeVisibleText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`

/** Mask the live market figures listed in the header. Input is normalized text. */
export function maskLiveFigures(text) {
  return String(text)
    .replace(new RegExp(String.raw`${NUM}\s?%(?=\s*(?:apy|apr)\b)`, 'g'), '<rate>')
    .replace(new RegExp(String.raw`\b(apy|apr)(\s*(?:of|is|:)?\s*)${NUM}\s?%`, 'g'), '$1$2<rate>')
    .replace(new RegExp(String.raw`\$?\b${NUM}\s?(?:k|m|b|bn|million|billion)\b`, 'g'), '<amount>')
    .replace(/(©|&copy;|copyright)\s*\d{4}/g, '$1 <year>')
}

/** The text the watcher hashes: visible, then masked. */
export const termsText = (html) => maskLiveFigures(normalizeVisibleText(html))

/** Versioned hash of the hashed text. */
export const termsHash = (text) =>
  `${TERMS_HASH_VERSION}:${createHash('sha256').update(text, 'utf8').digest('hex')}`

/** True when a stored hash came from the current normalizer. */
export const isCurrentTermsHash = (stored) =>
  typeof stored === 'string' && stored.startsWith(`${TERMS_HASH_VERSION}:`)

/**
 * The watcher's decision for one fetch, given the latest stored hash (or null).
 *   'baseline'   — nothing stored yet: store, no event
 *   'rebaseline' — stored hash is from an older normalizer: store, no event
 *   'unchanged'  — same hash: store nothing
 *   'changed'    — real terms change: store + terms_page_changed event
 */
export function termsDecision(prevHash, nextHash) {
  if (!prevHash) return 'baseline'
  if (!isCurrentTermsHash(prevHash)) return 'rebaseline'
  return prevHash === nextHash ? 'unchanged' : 'changed'
}

// Server-only session helpers for the offchain Q-Racing game.
// See docs/OFFCHAIN_QRACING_PLAN.md, Phase 1 ("Identity without a wallet").
//
// The cookie holds only a pointer (a signed playerId). All game data lives in Postgres
// (see db/schema.ts). Every future game route should call requirePlayer() rather than
// re-implementing cookie parsing.
//
// NOTE: we intentionally do NOT use the `server-only` package here (unlike db/index.ts's
// comment referencing it) — `server-only` throws on import in the pages-router API runtime,
// not just in the browser, which would crash every /pages/api/game/* route. The manual
// `typeof window` guard below is the pages-router-safe equivalent.

import type { NextApiRequest, NextApiResponse } from 'next'
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'

if (typeof window !== 'undefined') {
  throw new Error('lib/game/session must never be imported from client-side code')
}

export const PLAYER_COOKIE_NAME = 'mbrn_player'

const PLAYER_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365 // 1 year, matches the cookie Max-Age
const WALLET_NONCE_TTL_SECONDS = 60 * 10 // 10 minutes

type PlayerTokenPayload = {
  sub: string
  purpose: 'player'
}

type WalletNoncePayload = {
  sub: string
  purpose: 'wallet-link-nonce'
  rnd: string
}

// Lazy + never logged: mirrors db/index.ts's lazy-read pattern so a missing env var only
// breaks the routes that actually need it, and its value never appears in an error message.
function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET is not configured')
  }
  return new TextEncoder().encode(secret)
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// ---------------------------------------------------------------------------
// Player token (the cookie payload)
// ---------------------------------------------------------------------------

export async function signPlayerToken(playerId: string): Promise<string> {
  return new SignJWT({ purpose: 'player' } satisfies Omit<PlayerTokenPayload, 'sub'>)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(playerId)
    .setIssuedAt()
    .setExpirationTime(nowEpochSeconds() + PLAYER_TOKEN_TTL_SECONDS)
    .sign(getSessionSecret())
}

export async function verifyPlayerToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), { algorithms: ['HS256'] })
    if (payload.purpose !== 'player' || typeof payload.sub !== 'string') return null
    return payload.sub
  } catch {
    // Expired, malformed, or bad signature — treat identically to "no session".
    return null
  }
}

// ---------------------------------------------------------------------------
// Cookie plumbing
// ---------------------------------------------------------------------------

/**
 * Hand-rolled Set-Cookie serialization — the `cookie` package is not a direct
 * dependency here (Next re-exports it internally for parsing `req.cookies`, but not
 * for writing), and this cookie's attributes are fixed, so a helper library buys nothing.
 */
export async function setPlayerCookie(res: NextApiResponse, playerId: string): Promise<void> {
  const token = await signPlayerToken(playerId)
  const attrs = [
    `${PLAYER_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${PLAYER_TOKEN_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (process.env.NODE_ENV === 'production') {
    attrs.push('Secure')
  }
  res.setHeader('Set-Cookie', attrs.join('; '))
}

/** Reads and verifies the player cookie. Returns null if absent or invalid — never throws. */
export async function getPlayerId(req: NextApiRequest): Promise<string | null> {
  const token = req.cookies?.[PLAYER_COOKIE_NAME]
  if (!token) return null
  return verifyPlayerToken(token)
}

/**
 * Every future game route's entry point. Returns the playerId, or sends a 401 JSON
 * response itself and returns null — callers just need `if (!playerId) return`.
 */
export async function requirePlayer(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<string | null> {
  const playerId = await getPlayerId(req)
  if (!playerId) {
    res.status(401).json({ error: 'unauthorized' })
    return null
  }
  return playerId
}

// ---------------------------------------------------------------------------
// Wallet-link nonce — stateless (no DB write). The signed JWT itself IS the nonce;
// the SIWE-style message embeds that same compact token, so verify only needs
// { nonce, signature } to both authenticate the challenge and reconstruct what was signed.
// ---------------------------------------------------------------------------

export async function signWalletNonce(
  playerId: string,
): Promise<{ nonce: string; message: string }> {
  const rnd = crypto.randomUUID()
  const nonce = await new SignJWT({ purpose: 'wallet-link-nonce', rnd } satisfies Omit<
    WalletNoncePayload,
    'sub'
  >)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(playerId)
    .setIssuedAt()
    .setExpirationTime(nowEpochSeconds() + WALLET_NONCE_TTL_SECONDS)
    .sign(getSessionSecret())

  return { nonce, message: buildWalletLinkMessage(playerId, nonce) }
}

/** Exact text the client signs. Must stay byte-identical between nonce issuance and verify. */
export function buildWalletLinkMessage(playerId: string, nonce: string): string {
  return `Membrane Q-Racing\nLink wallet to player ${playerId}\nNonce: ${nonce}`
}

export type WalletNonceVerifyResult =
  | { ok: true; playerId: string }
  | { ok: false; reason: 'invalid' | 'expired' }

/** Verifies the nonce JWT's signature/expiry and that it was issued to `expectedPlayerId`. */
export async function verifyWalletNonce(
  nonce: string,
  expectedPlayerId: string,
): Promise<WalletNonceVerifyResult> {
  try {
    const { payload } = await jwtVerify(nonce, getSessionSecret(), { algorithms: ['HS256'] })
    if (payload.purpose !== 'wallet-link-nonce' || typeof payload.sub !== 'string') {
      return { ok: false, reason: 'invalid' }
    }
    if (payload.sub !== expectedPlayerId) {
      return { ok: false, reason: 'invalid' }
    }
    return { ok: true, playerId: payload.sub }
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, reason: 'expired' }
    }
    return { ok: false, reason: 'invalid' }
  }
}

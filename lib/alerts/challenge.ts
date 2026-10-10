import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getAddress, isAddress } from 'viem'

import type { ConsentChoices } from './consent'

const TEN_MINUTES_MS = 10 * 60 * 1000

function signatureFor(secret: string, address: string, issuedAt: string, random: string): string {
  return createHmac('sha256', secret)
    .update(`membrane-alerts-v1\n${address}\n${issuedAt}\n${random}`)
    .digest('hex')
}

export function createConsentChallenge(
  address: string,
  secret: string,
  now = new Date(),
): { issuedAt: string; nonce: string } {
  if (!isAddress(address) || secret.length < 32) throw new Error('consent unavailable')
  const canonical = getAddress(address)
  const issuedAt = now.toISOString()
  const random = randomBytes(16).toString('hex')
  return { issuedAt, nonce: `${random}.${signatureFor(secret, canonical, issuedAt, random)}` }
}

export function validConsentChallenge(
  choice: ConsentChoices,
  secret: string,
  now = Date.now(),
): boolean {
  if (secret.length < 32) return false
  const age = now - Date.parse(choice.issuedAt)
  if (!Number.isFinite(age) || age < 0 || age > TEN_MINUTES_MS) return false
  const [random, mac] = choice.nonce.split('.')
  const expected = Buffer.from(signatureFor(secret, choice.address, choice.issuedAt, random), 'hex')
  return timingSafeEqual(Buffer.from(mac, 'hex'), expected)
}

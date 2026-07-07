/**
 * Referral link utilities for the affiliate system.
 *
 * Encodes wallet addresses as base64url strings so referral links
 * don't expose raw Cosmos addresses.
 */

/**
 * Encode a wallet address to base64url format.
 * Standard base64 with '+' -> '-', '/' -> '_', stripped '=' padding.
 */
export function encodeAddressToBase64Url(address: string): string {
  if (typeof window !== 'undefined') {
    return btoa(address)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }
  return Buffer.from(address)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Decode a base64url string back to a wallet address.
 * Returns null if decoding fails.
 */
export function decodeBase64UrlToAddress(encoded: string): string | null {
  try {
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padLength = (4 - (base64.length % 4)) % 4
    base64 += '='.repeat(padLength)

    if (typeof window !== 'undefined') {
      return atob(base64)
    }
    return Buffer.from(base64, 'base64').toString('utf-8')
  } catch {
    return null
  }
}

/**
 * Validate that a decoded string looks like a valid Cosmos bech32 address.
 */
export function isValidCosmosAddress(address: string): boolean {
  return /^[a-z]{1,10}1[a-z0-9]{38,58}$/.test(address)
}

/**
 * Generate a referral link for a given wallet address.
 * Optionally include a label for campaign tracking (base64url encoded).
 */
export function generateReferralLink(address: string, label?: string): string {
  const encoded = encodeAddressToBase64Url(address)
  const labelParam = label ? `&label=${encodeAddressToBase64Url(label)}` : ''
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/?ref=${encoded}${labelParam}`
  }
  return `/?ref=${encoded}${labelParam}`
}

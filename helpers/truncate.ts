/**
 * Truncate an EVM address for display: 0x1234…abcd.
 * The legacy second param (bech32 prefix) is accepted and ignored so pre-migration
 * call sites like truncate(address, 'osmo') compile until each is cleaned up.
 */
export const truncate = (address: string | undefined, _legacyPrefix?: string | undefined) => {
  if (!address) return
  if (address.length <= 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

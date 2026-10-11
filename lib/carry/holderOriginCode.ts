// EIP-7702 permits an EOA with exactly this delegation marker to originate transactions.
// Code shape alone does not establish possession of the account's signing key.
const DELEGATION_CODE = /^0xef0100[0-9a-fA-F]{40}$/i

export function isEoaTransactionOriginCode(code: unknown): boolean {
  return code === '0x' || (typeof code === 'string' && DELEGATION_CODE.test(code))
}

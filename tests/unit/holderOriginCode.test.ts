import { describe, expect, it } from 'vitest'

import { isEoaTransactionOriginCode } from '@/lib/carry/holderOriginCode'

describe('EOA transaction origin code', () => {
  it('accepts empty code and an exact EIP-7702 delegation marker', () => {
    expect(isEoaTransactionOriginCode('0x')).toBe(true)
    expect(isEoaTransactionOriginCode(`0xef0100${'1'.repeat(40)}`)).toBe(true)
  })

  it('rejects ordinary contract code, malformed markers, and missing responses', () => {
    for (const code of [
      '0x6001',
      `0xef0100${'1'.repeat(39)}`,
      `0xef0100${'1'.repeat(41)}`,
      undefined,
    ]) {
      expect(isEoaTransactionOriginCode(code)).toBe(false)
    }
  })
})

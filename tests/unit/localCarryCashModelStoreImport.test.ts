import { describe, expect, it } from 'vitest'

import {
  buildLocalCashModelPlan,
  verifyLocalCarryCashModelLedgerFromVerified,
} from '../../scripts/lib/localCarryCashModelStore.mjs'

describe('local cash model store module interop', () => {
  it('exposes the store through the Vitest TypeScript module graph', () => {
    expect(buildLocalCashModelPlan).toBeTypeOf('function')
    expect(verifyLocalCarryCashModelLedgerFromVerified).toBeTypeOf('function')
  })
})

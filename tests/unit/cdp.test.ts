import { describe, it, expect } from 'vitest'
import { getDebt, getLTV, getLiquidValue, getMaxMint, getMintAmount, getTVL } from '@/services/cdp'

/**
 * CDP collateral math: LTV, mint capacity and liquidation value.
 *
 * This is the money. Every number here ends up either on screen next to a
 * liquidation warning or inside a transaction, so the tests below pin both the
 * happy path and the degenerate inputs (zero TVL, zero price) that arithmetic
 * silently turns into Infinity.
 */

const position = (usdValue: number) => ({ usdValue }) as never

describe('getTVL', () => {
  it('sums the USD value of every position', () => {
    expect(getTVL([position(100), position(250.5)] as never)).toBe(350.5)
  })

  it('is zero for an empty set', () => {
    expect(getTVL([] as never)).toBe(0)
  })

  it('tolerates a missing array rather than throwing', () => {
    expect(getTVL(undefined as never)).toBe(0)
  })

  it('skips null entries instead of producing NaN', () => {
    expect(getTVL([position(100), null, position(50)] as never)).toBe(150)
  })
})

describe('getLTV', () => {
  it('expresses debt as a percentage of collateral', () => {
    expect(getLTV(1000, 400)).toBe(40)
    expect(getLTV(1000, 333)).toBe(33.3)
  })

  it('rounds to two decimal places', () => {
    // 333.333/1000 => 33.3333% => 33.33
    expect(getLTV(1000, 333.333)).toBe(33.33)
  })

  it('short-circuits to zero for no debt, even with no collateral', () => {
    // Guards the 0/0 case that would otherwise be NaN.
    expect(getLTV(1000, 0)).toBe(0)
    expect(getLTV(0, 0)).toBe(0)
  })

  it('yields Infinity for debt against zero collateral', () => {
    // Documents current behaviour rather than endorsing it: a fully-drained
    // position with outstanding debt divides by zero. Callers that format or
    // compare this value need to expect a non-finite number.
    expect(getLTV(0, 100)).toBe(Infinity)
  })
})

describe('getMaxMint', () => {
  it('caps mintable debt by the borrow LTV and credit price', () => {
    // 1000 collateral * 60% / 1.0 credit price
    expect(getMaxMint(1000, 60, 1)).toBe(600)
  })

  it('scales inversely with the credit price', () => {
    expect(getMaxMint(1000, 60, 2)).toBe(300)
  })

  it('is zero when nothing may be borrowed', () => {
    expect(getMaxMint(1000, 0, 1)).toBe(0)
  })

  it('yields Infinity at a zero credit price', () => {
    // Unlike getMintAmount, this one does not clamp the price — see below.
    expect(getMaxMint(1000, 60, 0)).toBe(Infinity)
  })
})

describe('getMintAmount', () => {
  it('returns how much more may be minted to reach the target LTV', () => {
    // 1000 * 50% / 1 - 100 already borrowed
    expect(getMintAmount({ tvl: 1000, creditPrice: 1, debtAmount: 100, ltv: 50 })).toBe(400)
  })

  it('goes negative when the target is below current debt, indicating a repay', () => {
    expect(getMintAmount({ tvl: 1000, creditPrice: 1, debtAmount: 600, ltv: 50 })).toBe(-100)
  })

  it('clamps the credit price to a floor of 1', () => {
    // A sub-1 price would otherwise inflate mint capacity; Math.max(price, 1)
    // means 0.5 and 1 must produce identical results.
    const clamped = getMintAmount({ tvl: 1000, creditPrice: 0.5, debtAmount: 0, ltv: 50 })
    const atFloor = getMintAmount({ tvl: 1000, creditPrice: 1, debtAmount: 0, ltv: 50 })
    expect(clamped).toBe(atFloor)
    expect(clamped).toBe(500)
  })

  it('is finite at a zero credit price, because of that clamp', () => {
    // Contrast with getMaxMint, which returns Infinity for the same input.
    expect(getMintAmount({ tvl: 1000, creditPrice: 0, debtAmount: 0, ltv: 50 })).toBe(500)
  })
})

describe('getLiquidValue', () => {
  it('grosses net debt up by the liquidation LTV', () => {
    // (100 + 50 - 0) * 1 / 0.8
    expect(
      getLiquidValue({
        liqudationLTV: 80,
        debtAmount: 100,
        mintAmount: 50,
        repayAmount: 0,
        creditPrice: 1,
      }),
    ).toBeCloseTo(187.5, 10)
  })

  it('subtracts repayments from the debt', () => {
    expect(
      getLiquidValue({
        liqudationLTV: 100,
        debtAmount: 100,
        mintAmount: 0,
        repayAmount: 40,
        creditPrice: 1,
      }),
    ).toBe(60)
  })

  it('yields Infinity when the liquidation LTV is zero', () => {
    expect(
      getLiquidValue({
        liqudationLTV: 0,
        debtAmount: 100,
        mintAmount: 0,
        repayAmount: 0,
        creditPrice: 1,
      }),
    ).toBe(Infinity)
  })
})

describe('getDebt', () => {
  const basket = (creditAmount: string, positionIndex = 0) =>
    [
      {
        positions: Array.from({ length: positionIndex + 1 }, (_, i) => ({
          credit_amount: i === positionIndex ? creditAmount : '0',
        })),
      },
    ] as never

  it('shifts credit amounts out of micro-denominations', () => {
    expect(getDebt(basket('1000000'))).toBe(1)
    expect(getDebt(basket('1500000'))).toBe(1.5)
  })

  it('reads the requested position index', () => {
    expect(getDebt(basket('2000000', 1), 1)).toBe(2)
  })

  it('is zero when there are no positions at all', () => {
    expect(getDebt(undefined)).toBe(0)
    expect(getDebt([] as never)).toBe(0)
  })

  it('is zero when the requested index does not exist', () => {
    // Reaching past the end must not throw or produce NaN.
    expect(getDebt(basket('1000000'), 99)).toBe(0)
  })
})

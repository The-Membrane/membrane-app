import { describe, expect, it } from 'vitest'

import { replayEpisode, type HistoricLiquidation } from '@/lib/position-sim/history'
import { stablePriceRounds, TOKENS } from '@/lib/position-sim/historyScan'

describe('history scan token pricing', () => {
  it.each([
    [
      '0x514910771af9ca656af840dff83e8264ecf986ca',
      'LINK',
      '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c',
    ],
    [
      '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
      'AAVE',
      '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9',
    ],
    [
      '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
      'UNI',
      '0x553303d460EE0afB37EdFf9bE42922D8FF63220e',
    ],
    [
      '0xd533a949740bb3306d119cc777fa900ba034cd52',
      'CRV',
      '0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f',
    ],
    [
      '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72',
      'ENS',
      '0x5C00128d4d1c2F4f652C267d7bcdD7aC99C16E16',
    ],
    [
      '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f',
      'SNX',
      '0xDC3EA94CD0AC27d9A86C180091e7f78C683d3699',
    ],
    [
      '0x111111111117dc0aa78b770fa6a738034120c302',
      '1INCH',
      '0xc929ad75B72593967DE83E7F7Cda0493458261D9',
    ],
    [
      '0xba100000625a3754423978a60c9317c58a424e3d',
      'BAL',
      '0xdF2917806E30300537aEB49A7663062F4d1F2b5F',
    ],
    [
      '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0',
      'FXS',
      '0x6Ebc52C8C1089be9eB3945C4350B68B8E4C2233f',
    ],
  ])('prices %s with its direct USD feed', (address, symbol, feed) => {
    expect(TOKENS[address]).toEqual({
      symbol,
      decimals: 18,
      pricing: { kind: 'feed', feed },
    })
  })

  it('gives stable-anchor replays a $1 observation inside the first 8-hour window', () => {
    const eventTs = Date.UTC(2025, 9, 10, 12) / 1000
    const spanEndTs = eventTs + 72 * 60 * 60
    const event: HistoricLiquidation = {
      ts: eventTs,
      collateralSeizedUsd: 110_000,
      debtRepaidUsd: 100_000,
      ltvAtEvent: 0.8,
      liqLine: 0.8,
    }

    // The old { event - 1, spanEnd } shape has no observation inside the window.
    expect(
      replayEpisode(
        [event],
        [
          { ts: eventTs - 1, price: 1 },
          { ts: spanEndTs, price: 1 },
        ],
      ).verdict,
    ).toBe('unknown')

    const stableRounds = stablePriceRounds(eventTs, spanEndTs)
    for (const spanHours of [1, 8, 72]) {
      const rounds = stablePriceRounds(eventTs, eventTs + spanHours * 60 * 60)
      expect(rounds.every((round) => round.price === 1)).toBe(true)
      expect(rounds.some((round) => round.ts > eventTs && round.ts <= eventTs + 8 * 60 * 60)).toBe(
        true,
      )
    }
    expect(replayEpisode([event], stableRounds).verdict).not.toBe('unknown')
  })
})

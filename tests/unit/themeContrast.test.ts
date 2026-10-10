import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

const css = readFileSync(new URL('../../styles/themes.css', import.meta.url), 'utf8')

function palette(theme: 'dark' | 'light') {
  const selector =
    theme === 'dark'
      ? /:root,\s*:root\[data-membrane-theme='dark'\]\s*\{([^}]*)\}/
      : /:root\[data-membrane-theme='light'\]\s*\{([^}]*)\}/
  const block = css.match(selector)?.[1]
  if (!block) throw new Error(`Missing ${theme} palette`)
  return Object.fromEntries(
    [...block.matchAll(/(--m-[a-z-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((match) => [
      match[1],
      match[2],
    ]),
  )
}

function luminance(hex: string) {
  const channel = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  )
  const linear = channel.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)]
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} text and state colors meet the surface contrast floor`, () => {
    const colors = palette(theme)
    const surfaces = ['--m-bg-primary', '--m-bg-secondary', '--m-bg-tertiary']
    for (const text of ['--m-text-primary', '--m-text-secondary', '--m-text-tertiary']) {
      for (const surface of surfaces) {
        expect(
          contrast(colors[text], colors[surface]),
          `${text} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
    for (const state of ['--m-success', '--m-warning', '--m-risk-caution', '--m-danger']) {
      for (const surface of surfaces) {
        expect(
          contrast(colors[state], colors[surface]),
          `${state} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
}

import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// Exercise the row's actual handler without loading Next, Chakra, or a browser.
const path = new URL('../../components/Strats/StratsBoard.tsx', import.meta.url)
const radarPath = new URL('../../components/Radar/Radar.tsx', import.meta.url)
const source = ts.createSourceFile(
  path.pathname,
  readFileSync(path, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

function rowKeyHandler(onOpen: (address: string) => void) {
  let handler: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'Grid') {
      const role = node.attributes.properties.find(
        (attr) => ts.isJsxAttribute(attr) && attr.name.text === 'role',
      )
      if (role && ts.isJsxAttribute(role) && role.initializer?.getText(source) === '"button"') {
        const keyDown = node.attributes.properties.find(
          (attr) => ts.isJsxAttribute(attr) && attr.name.text === 'onKeyDown',
        )
        if (
          keyDown &&
          ts.isJsxAttribute(keyDown) &&
          keyDown.initializer &&
          ts.isJsxExpression(keyDown.initializer)
        ) {
          handler = keyDown.initializer.expression
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!handler) throw new Error('Strategy row keyboard handler not found')
  const compiled = ts.transpileModule(`return (${handler.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return new Function('onOpen', 's', compiled)(onOpen, { address: '0xstrategy' }) as (event: {
    key: string
    target: object
    currentTarget: object
    preventDefault: () => void
  }) => void
}

describe('strategy row keyboard activation', () => {
  it('does not present the position scanner count as venue-wide forecast coverage', () => {
    for (const file of [path, radarPath]) {
      expect(readFileSync(file, 'utf8')).not.toContain('five instrumented venues')
    }
  })

  it.each(['Enter', ' '])('opens Radar on %s when the row has focus', (key) => {
    const open = vi.fn()
    const preventDefault = vi.fn()
    const row = {}
    rowKeyHandler(open)({ key, target: row, currentTarget: row, preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledExactlyOnceWith('0xstrategy')
  })

  it.each(['Enter', ' '])('leaves venue-link %s activation to the link', (key) => {
    const open = vi.fn()
    const preventDefault = vi.fn()
    rowKeyHandler(open)({ key, target: {}, currentTarget: {}, preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})

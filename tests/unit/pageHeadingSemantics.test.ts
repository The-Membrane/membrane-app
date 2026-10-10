import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, test } from 'vitest'

function titleIsH1(file: string, title: string): boolean {
  const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found = false
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'Text') {
      const heading = node.openingElement.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.text === 'as' &&
          attribute.initializer &&
          ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === 'h1',
      )
      if (heading && node.children.some((child) => child.getText(tree).includes(title)))
        found = true
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

test.each([
  ['components/Carry/Hero.tsx', 'Borrow against dollars that keep earning.'],
  ['components/Radar/Radar.tsx', 'Carry Radar'],
  ['components/Receipts/Receipts.tsx', 'Called It'],
])('%s exposes its visible page title as an h1', (file, title) => {
  expect(titleIsH1(file, title)).toBe(true)
})

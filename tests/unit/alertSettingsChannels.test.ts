import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const path = new URL('../../components/Alerts/AlertSettings.tsx', import.meta.url)
const source = ts.createSourceFile(
  path.pathname,
  readFileSync(path, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

function evaluate(expression: ts.Expression, args: string[], values: unknown[]) {
  const compiled = ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return new Function(...args, `return ${compiled}`)(...values)
}

function choiceChannels(): ts.Expression {
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'normalizeChoices' &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const channels = node.arguments[0].properties.find(
        (property) =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === 'channels',
      )
      if (channels && ts.isPropertyAssignment(channels)) expression = channels.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('Signed channel choice not found')
  return expression
}

function disabledExpression(fragment: string): ts.Expression {
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node)) {
      const disabled = node.attributes.properties.find(
        (property) => ts.isJsxAttribute(property) && property.name.text === 'isDisabled',
      )
      if (
        disabled &&
        ts.isJsxAttribute(disabled) &&
        disabled.initializer &&
        ts.isJsxExpression(disabled.initializer) &&
        disabled.initializer.expression?.getText(source).includes(fragment)
      )
        expression = disabled.initializer.expression
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Disabled expression containing ${fragment} not found`)
  return expression
}

function emailBlurHandler(): ts.Expression {
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Input') {
      const id = node.attributes.properties.find(
        (property) => ts.isJsxAttribute(property) && property.name.text === 'id',
      )
      if (
        id &&
        ts.isJsxAttribute(id) &&
        id.initializer?.getText(source) === '"alert-email-address"'
      ) {
        const blur = node.attributes.properties.find(
          (property) => ts.isJsxAttribute(property) && property.name.text === 'onBlur',
        )
        if (
          blur &&
          ts.isJsxAttribute(blur) &&
          blur.initializer &&
          ts.isJsxExpression(blur.initializer)
        )
          expression = blur.initializer.expression
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('Email blur handler not found')
  return expression
}

describe('alert settings checked channels', () => {
  it('puts every checked channel in the signed subscribe choice', () => {
    const expression = choiceChannels()
    expect(
      evaluate(expression, ['action', 'telegram', 'email'], ['subscribe', true, true]),
    ).toEqual(['telegram', 'email'])
    expect(
      evaluate(expression, ['action', 'telegram', 'email'], ['subscribe', false, true]),
    ).toEqual(['email'])
    expect(evaluate(expression, ['action', 'telegram', 'email'], ['pause', true, true])).toEqual([])
  })

  it('blocks signing unavailable Telegram while allowing it to be unchecked', () => {
    const signDisabled = disabledExpression('telegramUnavailable')
    const telegramDisabled = disabledExpression('!status?.telegramLinkReady && !telegram')
    expect(
      evaluate(
        signDisabled,
        ['status', 'busy', 'events', 'email', 'normalizedEmail', 'telegramUnavailable', 'telegram'],
        [{ consentReady: true }, false, ['delay_started'], true, 'a@example.com', true, true],
      ),
    ).toBe(true)
    expect(
      evaluate(
        telegramDisabled,
        ['busy', 'status', 'telegram'],
        [false, { telegramLinkReady: false }, true],
      ),
    ).toBe(false)
    expect(
      evaluate(
        telegramDisabled,
        ['busy', 'status', 'telegram'],
        [false, { telegramLinkReady: false }, false],
      ),
    ).toBe(true)
  })

  it('shows the canonical email address before signing after blur', () => {
    const values: string[] = []
    const blur = evaluate(
      emailBlurHandler(),
      ['setEmailTouched', 'normalizedEmail', 'setEmailAddress'],
      [() => {}, 'Case.Name@example.com', (value: string) => values.push(value)],
    ) as () => void
    blur()
    expect(values).toEqual(['Case.Name@example.com'])
  })
})

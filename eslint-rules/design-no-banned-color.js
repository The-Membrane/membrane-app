'use strict'
/**
 * design-no-banned-color
 *
 * Source: CLAUDE.md "Color Usage Rules" and "Button Rules":
 *   142  NEVER use purple (`#A692FF`, `#6943FF`) — legacy brand color, being migrated out
 *   143  NEVER use cyan for success — cyan/`#22d3ee` was the old success color
 *   144  NEVER use pure white (`#fff`, `whiteAlpha.*`) for text — always warm bone
 *   351  NEVER use `colorScheme="purple"` — legacy
 *   662  (Common Mistakes) `<Text ... color="white">`
 *
 * Three checks, each a named, explicitly-banned value (not taste):
 *   legacyHex     any string literal containing #A692FF / #6943FF / #22d3ee (any case)
 *   purpleScheme  colorScheme="purple" (literal) on any JSX element
 *   pureWhiteText `color` (text colour) set to white / #fff / #ffffff / whiteAlpha.*
 */
const { jsxStyleVisitor } = require('./lib/style-values')

const LEGACY_HEX = /#(a692ff|6943ff|22d3ee)\b/i
const PURE_WHITE = /^(white|#fff|#ffffff|whiteAlpha\.\d+)$/i

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Bans the legacy purple/cyan hexes, colorScheme="purple" and pure-white text named in CLAUDE.md:142-144,351',
    },
    schema: [],
    messages: {
      legacyHex: 'Legacy colour {{value}} is banned (CLAUDE.md:142-143) — use SEMANTIC_COLORS.',
      purpleScheme: 'colorScheme="purple" is legacy (CLAUDE.md:351) — use colorScheme="phosphor" or a variant.',
      pureWhiteText:
        'Pure white text "{{value}}" is banned (CLAUDE.md:144) — use SEMANTIC_COLORS.textPrimary (warm bone).',
    },
  },
  create(context) {
    const checkString = (node, s) => {
      if (typeof s !== 'string') return
      const m = s.match(LEGACY_HEX)
      if (m) context.report({ node, messageId: 'legacyHex', data: { value: m[0] } })
    }
    const styleVisitor = jsxStyleVisitor(
      (prop) => prop === 'color',
      (prop, value, node) => {
        if (typeof value === 'string' && PURE_WHITE.test(value.trim()))
          context.report({ node, messageId: 'pureWhiteText', data: { value } })
      },
    )
    return {
      Literal(node) {
        checkString(node, node.value)
      },
      TemplateElement(node) {
        checkString(node, node.value.cooked)
      },
      JSXText(node) {
        checkString(node, node.value)
      },
      JSXAttribute(attr) {
        if (
          attr.name.type === 'JSXIdentifier' &&
          attr.name.name === 'colorScheme' &&
          attr.value &&
          ((attr.value.type === 'Literal' && attr.value.value === 'purple') ||
            (attr.value.type === 'JSXExpressionContainer' &&
              attr.value.expression.type === 'Literal' &&
              attr.value.expression.value === 'purple'))
        ) {
          context.report({ node: attr, messageId: 'purpleScheme' })
        }
        styleVisitor.JSXAttribute(attr)
      },
    }
  },
}

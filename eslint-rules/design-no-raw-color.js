'use strict'
/**
 * design-no-raw-color
 *
 * Source: CLAUDE.md lines 105-146 ("Semantic Colors", config/semanticColors.ts):
 *   109  ALWAYS use semantic colors for states
 *   141  NEVER use random colors
 *   145  ALWAYS use semantic color names
 *   655  (Common Mistakes) `<Box bg="rgba(10,10,10,0.8)" ...>`
 *
 * Flags hex / rgb() / rgba() / hsl() literals on colour-bearing JSX props
 * (color, bg, borderColor, fill, stroke, border shorthand, boxShadow, gradients, ...)
 * and on the same keys inside sx/style/_pseudo objects. SEMANTIC_COLORS.* references
 * and Chakra tokens ("transparent", "currentColor") are not literals with a raw colour.
 */
const { jsxStyleVisitor } = require('./lib/style-values')

const COLOR_PROP =
  /^(color|bg|bgColor|background|backgroundColor|bgGradient|backgroundImage|fill|stroke|stopColor|floodColor|lightingColor|border|borderTop|borderRight|borderBottom|borderLeft|borderX|borderY|outline|boxShadow|textShadow|shadow|caretColor|accentColor|placeholderColor|textFillColor|[a-zA-Z]*Color)$/
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\s*\(/

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Colour props must use SEMANTIC_COLORS from config/semanticColors.ts (CLAUDE.md:109,141,145) — no raw hex/rgb/hsl',
    },
    schema: [],
    messages: {
      raw: 'Raw colour "{{value}}" on `{{prop}}` — use SEMANTIC_COLORS.* from config/semanticColors.ts (CLAUDE.md:141,145).',
    },
  },
  create(context) {
    return jsxStyleVisitor(
      (prop) => COLOR_PROP.test(prop),
      (prop, value, node) => {
        if (typeof value !== 'string' || !RAW_COLOR.test(value)) return
        const shown = value.length > 40 ? value.slice(0, 37) + '...' : value
        context.report({ node, messageId: 'raw', data: { prop, value: shown } })
      },
    )
  },
}

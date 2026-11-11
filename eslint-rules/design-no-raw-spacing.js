'use strict'
/**
 * design-no-raw-spacing
 *
 * Source: CLAUDE.md lines 152-182 ("Spacing Scale", config/spacing.ts):
 *   178  NEVER use arbitrary values like `p={5}`, `gap="20px"`, `gap="9%"`
 *   179  NEVER use inline pixel values: `padding: "20px"`
 *   180  NEVER mix units: `gap="1.5rem"`
 *   182  ALWAYS use numeric Chakra values (not strings)
 *   160-168 the scale: 0, 1, 2, 3, 4, 6, 8, 12, 16 (SPACING.none..3xl)
 *
 * Flags literal values on Chakra spacing props (and padding/margin/gap keys in
 * sx/style/_pseudo objects) that are: a CSS length string ("20px", "1.5rem", "9%",
 * "calc(...px)"), a numeric string ("4"), or a number off the SPACING scale (5, 0.5).
 * Allowed: SPACING.* references (any non-literal), scale numbers, 0/"0", "auto".
 */
const { jsxStyleVisitor } = require('./lib/style-values')

const SCALE = new Set([0, 1, 2, 3, 4, 6, 8, 12, 16])
const SPACING_PROP =
  /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|rowGap|columnGap|gridGap|gridRowGap|gridColumnGap|spacing|spacingX|spacingY|(padding|margin)(X|Y|Top|Right|Bottom|Left|Inline|InlineStart|InlineEnd|Block|BlockStart|BlockEnd|Start|End)?)$/
const UNIT = /\d(px|rem|em|%|vh|vw|vmin|vmax|ch|pt)(?![a-z])/i
const ZERO = /^-?0(\.0+)?(px|rem|em|%)?$/
const NUMERIC_STRING = /^-?\d*\.?\d+$/

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Spacing props must use config/spacing.ts tokens (CLAUDE.md:152-182) — no px/rem/% strings, no off-scale numbers',
    },
    schema: [],
    messages: {
      unit: 'Raw spacing "{{value}}" on `{{prop}}` — use SPACING / SPACING_PATTERNS from config/spacing.ts (CLAUDE.md:178-180).',
      offScale:
        '`{{prop}}={{value}}` is off the spacing scale (0,1,2,3,4,6,8,12,16) — use a SPACING token (CLAUDE.md:178).',
      stringNumeric:
        '`{{prop}}="{{value}}"` is a numeric string — use a numeric SPACING token, not a string (CLAUDE.md:182).',
    },
  },
  create(context) {
    return jsxStyleVisitor(
      (prop) => SPACING_PROP.test(prop),
      (prop, value, node) => {
        if (typeof value === 'number') {
          if (!SCALE.has(Math.abs(value))) context.report({ node, messageId: 'offScale', data: { prop, value } })
          return
        }
        const v = String(value).trim()
        if (v === '' || ZERO.test(v)) return
        if (UNIT.test(v)) return context.report({ node, messageId: 'unit', data: { prop, value: v } })
        if (NUMERIC_STRING.test(v)) context.report({ node, messageId: 'stringNumeric', data: { prop, value: v } })
      },
    )
  },
}

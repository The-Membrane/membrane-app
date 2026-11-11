'use strict'
/**
 * design-no-inline-transition
 *
 * Source: CLAUDE.md "Animation Rules" (config/transitions.ts):
 *   281  NEVER use inline transitions: `transition="all 0.2s"`
 *   282  NEVER use arbitrary timings
 *   284  ALWAYS import from `config/transitions.ts`
 *   642  (Common Mistakes) `<Button transition="all 0.2s">`
 *
 * Flags string literals on `transition` / `transitionDuration` /
 * `transitionTimingFunction` JSX props and the same keys inside sx/style/_pseudo
 * objects. TRANSITIONS.* references, "none", and framer-motion object transitions
 * (transition={{ duration }}) are not flagged.
 */
const { jsxStyleVisitor } = require('./lib/style-values')

const TRANSITION_PROP = /^(transition|transitionDuration|transitionTimingFunction|transitionProperty)$/

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Transitions must come from config/transitions.ts (CLAUDE.md:281-284) — no inline strings',
    },
    schema: [],
    messages: {
      inline: 'Inline {{prop}} "{{value}}" — use TRANSITIONS.* from config/transitions.ts (CLAUDE.md:281-284).',
    },
  },
  create(context) {
    return jsxStyleVisitor(
      (prop) => TRANSITION_PROP.test(prop),
      (prop, value, node) => {
        if (typeof value !== 'string') return
        const v = value.trim()
        if (v === '' || v === 'none') return
        context.report({ node, messageId: 'inline', data: { prop, value: v } })
      },
    )
  },
}

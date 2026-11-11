'use strict'
/**
 * no-duplicate-exec-phase
 *
 * The confirm-sheet execution phase union 'confirm' | 'signing' | 'pending' | 'done'
 * is the state machine every exec sheet shares. At 1038051b it is hand-copied in
 *   components/Position/ExecContext.tsx:22, components/Carry/ExecSheet.tsx:21,
 *   components/Defend/ExecSheet.tsx:19
 * next to the exported canonical `ExecPhase` in components/Borrow/types.ts:57
 * (components/Borrow/hooks/useMockExec.ts already imports it). Copies drift: add a
 * phase (e.g. 'error') to one sheet and the others silently diverge.
 *
 * Flags any TS union of string literals that contains all four phases, declared
 * anywhere except the canonical module (option `canonical`, path suffix).
 */
const PHASES = ['confirm', 'signing', 'pending', 'done']
const DEFAULT_CANONICAL = 'components/Borrow/types.ts'

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "The exec phase union 'confirm'|'signing'|'pending'|'done' must be imported (ExecPhase), not re-declared",
    },
    schema: [
      {
        type: 'object',
        properties: { canonical: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      dup: "Exec phase union re-declared here — import `ExecPhase` from '{{canonical}}' instead of copying it.",
    },
  },
  create(context) {
    const canonical = ((context.options[0] || {}).canonical || DEFAULT_CANONICAL).replace(/\\/g, '/')
    const filename = (context.filename || context.getFilename()).replace(/\\/g, '/')
    if (filename.endsWith(canonical)) return {}
    return {
      TSUnionType(node) {
        if (node.parent && node.parent.type === 'TSUnionType') return
        const lits = new Set()
        for (const t of node.types) {
          if (t.type === 'TSLiteralType' && t.literal.type === 'Literal' && typeof t.literal.value === 'string')
            lits.add(t.literal.value)
        }
        if (PHASES.every((p) => lits.has(p))) {
          context.report({ node, messageId: 'dup', data: { canonical: canonical.replace(/\.tsx?$/, '') } })
        }
      },
    }
  },
}

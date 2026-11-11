'use strict'
const tester = require('./tester')
const rule = require('../no-duplicate-exec-phase')

const PHASE = "'confirm' | 'signing' | 'pending' | 'done'"

tester.run('no-duplicate-exec-phase', rule, {
  valid: [
    { code: `export type ExecPhase = ${PHASE}`, filename: '/repo/components/Borrow/types.ts' },
    { code: "import type { ExecPhase } from '../types'\nconst p: ExecPhase = 'confirm'", filename: '/repo/a.ts' },
    { code: "type Step = 'confirm' | 'signing' | 'done'", filename: '/repo/a.ts' }, // subset, different machine
    { code: `type P = ${PHASE}`, filename: '/repo/lib/exec/phase.ts', options: [{ canonical: 'lib/exec/phase.ts' }] },
  ],
  invalid: [
    // The bug as found at 1038051b: components/Carry/ExecSheet.tsx:21
    { code: `type Phase = ${PHASE}`, filename: '/repo/components/Carry/ExecSheet.tsx', errors: [{ messageId: 'dup' }] },
    {
      code: `const [phase, setPhase] = useState<'done' | 'pending' | 'signing' | 'confirm' | 'error'>('confirm')`,
      filename: '/repo/components/X.tsx',
      errors: [{ messageId: 'dup' }],
    },
    {
      code: `export type ExecPhase = ${PHASE}`,
      filename: '/repo/components/Borrow/types.ts',
      options: [{ canonical: 'lib/exec/phase.ts' }],
      errors: [{ messageId: 'dup' }],
    },
  ],
})

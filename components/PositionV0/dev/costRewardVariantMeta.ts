// The cost-vs-reward design candidates' names and reasons (pages/dev/cost-reward.tsx),
// apart from their React so the unit tests can read them in node.

export type VariantKey = 'A' | 'B' | 'C'

export const VARIANTS: ReadonlyArray<{ key: VariantKey; title: string; rationale: string }> = [
  {
    key: 'A',
    title: "The spec's tracker",
    rationale:
      'Faithful to the Q34 wireframe: both rates in $/yr at today’s size on one axis from $0, so a reader sees each level and whether they are converging.',
  },
  {
    key: 'B',
    title: 'Yield spread',
    rationale:
      'One line about $0 answers "does income cover interest at this size?" without comparing two lines; it needs ruling 1 (the yield spread is a new number). Incentives ‡ sit beside it, current only.',
  },
  {
    key: 'C',
    title: 'Compact card',
    rationale:
      'For the position row: the yield spread first, so nobody does the subtraction; interest paid and income earned fold out below it, each leg with its rate and trace.',
  },
]

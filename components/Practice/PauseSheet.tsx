import React from 'react'
import { Box, SimpleGrid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import {
  CHOICES,
  clockAt,
  currentLtv,
  elapsed,
  fmtPct,
  fmtUsd,
  previewChoice,
  type Choice,
  type PauseKind,
  type PracticeState,
} from '@/lib/practice/engine'

import { ActionButton, Eyebrow, Panel } from './atoms'

const CHOICE_LABEL: Record<Choice, string> = {
  'add-10': 'Add 10% collateral',
  'add-25': 'Add 25% collateral',
  'repay-to-borrow-line': 'Repay to the borrow line',
  'repay-half-way': 'Repay half-way',
  hold: 'Hold',
}

export const choiceLabel = (c: Choice) => CHOICE_LABEL[c]

export const PauseSheet: React.FC<{ st: PracticeState; pause: PauseKind; onChoose: (c: Choice) => void }> = ({
  st,
  pause,
  onChoose,
}) => {
  const { sc } = st
  const ltv = currentLtv(st)
  const windowEnds = st.armedAt !== null ? st.armedAt + sc.delaySteps : null
  const left = windowEnds !== null ? Math.max(0, windowEnds - st.index) : null

  const headline =
    pause === 'arm'
      ? `Over the line at ${fmtPct(ltv, 2)}. The 8-hour window started.`
      : pause === 'band-approach'
        ? `${fmtPct(ltv, 2)}: within 1 pp of the break line, ${fmtPct(sc.breakLine, 2)}.`
        : `${elapsed(st.index - (st.armedAt ?? st.index))} in, still over the line at ${fmtPct(ltv, 2)}.`

  const sub =
    pause === 'band-approach'
      ? 'Past the break line the sale is immediate.'
      : left !== null && windowEnds !== null
        ? `Still over at ${clockAt(sc, windowEnds)} (${elapsed(left)}) and it sells to the borrow line, ${fmtPct(sc.cap)}.`
        : ''

  return (
    <Panel accent={pause === 'band-approach' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.warning} role="dialog" aria-label="Choose an action">
      <Eyebrow color={pause === 'band-approach' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.warning}>
        {pause === 'arm' ? 'Timer armed' : pause === 'band-approach' ? 'Band approach' : 'Mid-window'} · {clockAt(sc, st.index)}
      </Eyebrow>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="15px" color={SEMANTIC_COLORS.textPrimary} mt={SPACING.sm}>
        {headline}
      </Text>
      {sub && (
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} mt={SPACING.xs}>
          {sub}
        </Text>
      )}
      <SimpleGrid columns={{ base: 1, md: 5 }} spacing={SPACING.sm} mt={SPACING.md}>
        {CHOICES.map((c) => {
          const p = previewChoice(st, c)
          const noop = c !== 'hold' && !(p.usd > 0)
          return (
            <ActionButton key={c} onClick={() => onChoose(c)} disabled={noop}>
              <Box>
                <Text>{CHOICE_LABEL[c]}</Text>
                <Text color={SEMANTIC_COLORS.textTertiary} fontSize="11px" mt="2px">
                  {c === 'hold' ? `stay at ${fmtPct(ltv, 2)}` : noop ? 'nothing to repay' : `${fmtUsd(p.usd)} → ${fmtPct(p.ltvAfter, 2)}`}
                </Text>
              </Box>
            </ActionButton>
          )
        })}
      </SimpleGrid>
    </Panel>
  )
}

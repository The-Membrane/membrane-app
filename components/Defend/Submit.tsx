import React from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { Card } from '@/components/ui/Card'
import { DemoAwareCta } from '@/components/demo'

import { SUBMIT_CONFIG } from './Hero'
import { CopyChip, SectionHeading, Stamp } from './Primitives'
import { ctaGold } from './styles'
import { ExecConfig } from './types'

export interface SubmitProps {
  openExec: (config: ExecConfig) => void
}

export const Submit: React.FC<SubmitProps> = ({ openExec }) => (
  <>
    <SectionHeading index="07" title="Submit" />
    <Card
      display="flex"
      gap={SPACING.base}
      alignItems="center"
      flexWrap="wrap"
      p={SPACING.base}
    >
      <DemoAwareCta {...ctaGold} onAction={() => openExec(SUBMIT_CONFIG)}>
        Submit a strategy
      </DemoAwareCta>
      <CopyChip value="github.com/membrane-fi/curator-starter">
        starter repo: github.com/membrane-fi/curator-starter ⧉
      </CopyChip>
      <Stamp mt={0}>
        sandboxed runtime · scored on rotating seed sets · submission cooldown applies
      </Stamp>
    </Card>
  </>
)

export default Submit

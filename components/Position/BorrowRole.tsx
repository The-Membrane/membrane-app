import React from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'

import { PositionHeader } from './PositionHeader'
import { ThroughputHero } from './ThroughputHero'
import { DeliveriesChart } from './DeliveriesChart'
import { IntentCountdowns } from './IntentCountdowns'
import { Encounters } from './Encounters'
import { Calibration } from './Calibration'
import { DittoRecap } from './DittoRecap'
import { NotShown } from './NotShown'

/** The Borrow role: the full position view (sections 0–5 of the proto). */
export const BorrowRole: React.FC = () => (
  <Box>
    <PositionHeader />
    <Box mt={SPACING.base}>
      <ThroughputHero />
    </Box>
    <DeliveriesChart />
    <IntentCountdowns />
    <Encounters />
    <Calibration />
    <DittoRecap />
    <NotShown />
  </Box>
)

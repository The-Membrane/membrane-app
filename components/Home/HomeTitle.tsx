import { Button, HStack, Stack, Text } from '@chakra-ui/react'
import React, { useCallback, useMemo, useState } from 'react'
import { useBasket } from '@/hooks/useCDP'
import { shiftDigits } from '@/helpers/math'
import { Formatter } from '@/helpers/formatter'
import { getProjectTVL } from '@/services/cdp'
import { useOraclePrice } from '@/hooks/useOracle'
import Divider from '../Divider'
import OnboardModal from './LeapOnboarding'



export const HomeTitle = React.memo(() => {

  const [isOpen, setOpen] = useState(false)

  return (
    <Stack gap={5}>
      <HStack mt="auto" gap="24" justifyContent="center">
        <Stack gap={5}>

          <h1
            className={"home-title"}
          >
            Decentralized Stablecoins: A New Age of Empowerment
          </h1>
          <Button alignSelf="center" width="31%" minWidth="180px"
            onClick={() => setOpen(true)}>
            Add Funds to Osmosis
          </Button>
        </Stack>
      </HStack>
      <OnboardModal isOpen={isOpen} setOpen={setOpen} />
      <Divider mx="0" mb="5" />
    </Stack>
  )
})
import { Button, Grid, GridItem, Text, Stack, useBreakpointValue, Checkbox } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import SPCard from './QASPCard'
import EarnCard from './QAEarnCard'

import React, { useEffect, useMemo, useState } from "react"
import RangeBoundLPCard from './RangeBoundLPCard'
import RangeBoundVisual from './RangeBoundVisual'
import { FaArrowDown, FaArrowUp } from 'react-icons/fa6'
import useVaultSummary from '../Mint/hooks/useVaultSummary'
import { colors, MAX_CDP_POSITIONS } from '@/config/defaults'
import { useUserPositions } from '@/hooks/useCDP'
import useToaster from '@/hooks/useToaster'
import { num } from '@/helpers/num'
import useMintState from '../Mint/hooks/useMintState'
import NeuroGuardCard from './NeuroGuardCard'
import { useUserBoundedIntents } from '../Earn/hooks/useEarnQueries'
import useNeuroState from './hooks/useNeuroState'


// Memoize child components
// const MemoizedRangeBoundVisual = React.memo(RangeBoundVisual)
// const MemoizedRangeBoundLPCard = React.memo(RangeBoundLPCard)
const MemoizedNeuroGuardCard = React.memo(NeuroGuardCard)

const Home = () => {
  console.log("Home")
  const { neuroState, setNeuroState } = useNeuroState()
  const [hasShownToast, setHasShownToast] = useState(false);
  const toaster = useToaster()
  // Function to handle cookie checkbox toggle
  const handleToggle = (event) => {
    setNeuroState({ setCookie: event.target.checked });
    console.log("setCookie", event.target.checked)
  };
  const showToast = () => {
    toaster.message({
      title: `Accept Cookies`,
      message: (
        <>
          <Checkbox
            checked={neuroState?.setCookie}
            onChange={handleToggle}
            fontFamily="Inter">
            Accept cookies to track profits
          </Checkbox>
        </>
      ), duration: null
    }
    )
  }
  useEffect(() => {
    // Only show toast if it hasn't been shown before
    if (!hasShownToast && neuroState?.setCookie === undefined) {
      showToast();
      setHasShownToast(true);
    }
  }, []); // Empty dependency array means this runs once on mount

  //Dismiss toaster if setCookie is true
  useMemo(() => {
    if (neuroState?.setCookie) toaster.dismiss()
  }, [neuroState?.setCookie]);


  return (
    <Stack>
      <StatsCard />
      <Stack>
        <MemoizedNeuroGuardCard />
      </Stack>
    </Stack>
  )
}

export default React.memo(Home)
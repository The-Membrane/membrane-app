import { Button, Grid, GridItem, Text, Stack, useBreakpointValue, Checkbox } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import SPCard from './QASPCard'
import EarnCard from './QAEarnCard'

import React, { useCallback, useEffect, useMemo, useState } from "react"
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
  const { neuroState, setNeuroState } = useNeuroState();
  const [hasShownToast, setHasShownToast] = useState(false);
  const toaster = useToaster();

  // Memoize the toggle handler to prevent recreating on each render
  const handleToggle = useCallback((event) => {
    setNeuroState({ setCookie: event.target.checked });
  }, [setNeuroState]);

  // Memoize the toast content to prevent recreating on each render
  const toastContent = useMemo(() => ({
    title: 'Accept Cookies',
    message: (
      <Checkbox
        checked={neuroState?.setCookie}
        onChange={handleToggle}
        fontFamily="Inter"
      >
        Accept cookies to track profits & optimize load times
      </Checkbox>
    ),
    duration: null
  }), [neuroState?.setCookie, handleToggle]);

  // Show toast effect with proper dependencies
  useEffect(() => {
    if (!hasShownToast && neuroState?.setCookie === undefined) {
      toaster.message(toastContent);
      setHasShownToast(true);
    }
  }, [hasShownToast, neuroState?.setCookie, toastContent, toaster]);

  // Handle toaster dismissal with proper effect
  useEffect(() => {
    if (neuroState?.setCookie) {
      toaster.dismiss();
    }
  }, [neuroState?.setCookie, toaster]);

  // Memoize the entire content to prevent unnecessary re-renders
  const content = useMemo(() => (
    <Stack>
      <StatsCard />
      <Stack>
        <MemoizedNeuroGuardCard />
      </Stack>
    </Stack>
  ), []);

  return content;
};

// Only use memo if this component's parent might cause unnecessary re-renders
export default Home;
import { Button, HStack, Stack, Text } from '@chakra-ui/react'
import React, { useCallback, useMemo, useState } from 'react'
import Divider from './Divider'
import { useBasket } from '@/hooks/useCDP'
import { shiftDigits } from '@/helpers/math'
import { Formatter } from '@/helpers/formatter'
import { getProjectTVL } from '@/services/cdp'
import { useOraclePrice } from '@/hooks/useOracle'
import OnboardModal from './Home/LeapOnboarding'


// export const Stats = React.memo(({ label, value }) => (
//   <Stack gap="1">
//     <Text variant="title" letterSpacing="unset" textTransform="none"
//       textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)" fontSize="4xl">
//       {label}
//     </Text>
//     <Text variant="title" letterSpacing="unset"
//       textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)" fontSize="4xl">
//       {value}
//     </Text>
//   </Stack>
// ))

export const StatsCard = React.memo(() => {
  // const tvl = useMemo(() =>
  //   getProjectTVL({ basket, prices })
  //   , [basket, prices])

  // const mintedAmount = useMemo(() => {
  //   const cdtAmount = basket?.credit_asset?.amount || 0
  //   return shiftDigits(cdtAmount, -6).dp(0).toNumber()
  // }, [basket])

  // const [titleToggle, setTitleToggle] = useState(true)
  const [isOpen, setOpen] = useState(false)

  // const onTitleClick = useCallback(() =>
  //   setTitleToggle(prev => !prev)
  //   , [])

  return (
    <Stack gap={5}>
      <HStack mt="auto" gap="24" justifyContent="center">
        {/* {titleToggle ? ( */}
        <Stack gap={5}>

          <h1
            style={{
              fontWeight: 'bold',
              fontSize: '33px',
              // fontFamily: 'monospace',
              justifyContent: 'center',
              display: 'flex',
              textAlign: 'center'
            }}
          >
            Decentralized Stablecoins: A New Age of Empowerment
          </h1>
          <Button alignSelf="center" width="31%" minWidth="180px"
            onClick={() => setOpen(true)}>
            Add Funds to Osmosis
          </Button>
        </Stack>
        {/* ) : ( */}


        {/* <Text onClick={onTitleClick} fontWeight="bold" fontSize="33px"
            fontFamily="monospace" justifyContent="center"
            display="flex" textAlign="center">
            welcome within.
          </Text>
          // <HStack gap={16} onClick={onTitleClick}>
          //   <Stats label="TVL" value={Formatter.currency(tvl, 0)} />
          //   <Stats label="Total Minted" value={`${Formatter.tvl(mintedAmount)} CDT`} />
          // </HStack>
        )} */}
      </HStack>
      <OnboardModal isOpen={isOpen} setOpen={setOpen} />
      <Divider mx="0" mb="5" />
    </Stack>
  )
})
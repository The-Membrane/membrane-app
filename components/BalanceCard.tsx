import { Button, HStack, Stack, Text } from '@chakra-ui/react'
import React, { useMemo, useState } from 'react'
import Divider from './Divider'
import { Formatter } from '@/helpers/formatter'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { colors } from '@/config/defaults'
import { GrPowerReset } from 'react-icons/gr'
import { queryClient } from '@/pages/_app'

export const Stats = ({ label, value }) => (
  <Stack gap="1">

    {label != "" ? <Text
      variant="title"
      letterSpacing="unset"
      textTransform="none"
      textShadow={`0px 0px 8px ${colors.tabBG}`}
      fontSize="lg"
    >
      {label}
    </Text> : null}
    <Text variant="title" letterSpacing="unset" textShadow={`0px 0px 8px ${colors.tabBG}`}>
      {value}
    </Text>
  </Stack>
)

export function useTemporaryDisable(durationMs: number = 3000) {
  const [isDisabled, setIsDisabled] = useState(false);

  const triggerDisable = () => {
    setIsDisabled(true);
    setTimeout(() => setIsDisabled(false), durationMs);
  };

  return { isDisabled, triggerDisable };
}

export const BalanceCard = () => {
  const cdt = useAssetBySymbol('CDT')
  const cdtBalance = useBalanceByAsset(cdt)
  const mbrn = useAssetBySymbol('MBRN')
  const mbrnBalance = useBalanceByAsset(mbrn)



  const { isDisabled, triggerDisable } = useTemporaryDisable(7000);


  //onRest
  const onRest = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    triggerDisable()
  }



  return (
    <Stack gap="3">
      <Divider mx="0" mb="5" />
      <HStack>

        <Text
          variant="title"
          letterSpacing="unset"
          textTransform="none"
          textShadow={`0px 0px 8px ${colors.tabBG}`}
          fontSize="lg"
        >
          Wallet Balances
        </Text>
        <div style={{ width: "21%", display: "flex", justifyContent: "flex-end", marginBottom: "1%" }}>
          <Button isDisabled={isDisabled} variant="ghost" width={"5%"} padding={0} leftIcon={<GrPowerReset size={25} />} marginLeft={"auto"} onClick={onRest} />
        </div>
      </HStack>
      <Stats label="" value={`${Formatter.tvl(mbrnBalance)} MBRN`} />
      <Stats label="" value={`${Formatter.tvl(cdtBalance)} CDT`} />
    </Stack>
  )
}

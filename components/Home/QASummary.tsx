import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, Checkbox, HStack, Image, Stack, Text } from '@chakra-ui/react'
import useQuickActionState from './hooks/useQuickActionState'
import { AssetWithBalance } from '../Mint/hooks/useCombinBalance'
import { useMemo } from 'react'
import { loopMax } from '@/config/defaults'

type SummaryItemProps = Partial<AssetWithBalance> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  logos?: string[]
  isLP?: boolean
  newValue?: number
  startingValue?: number
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  logos,
  isLP,
  newValue,
  startingValue,
}: SummaryItemProps) => (
  <HStack
    key={label}
    justifyContent="space-between"
    pb="1"
    my="1"
    borderBottom="1px solid"
    borderColor="whiteAlpha.200"
  >
    <HStack>
      <HStack>
        {isLP ? (
          <HStack>
            <Image src={logos?.[0]} w="24px" h="24px" />
            <Image src={logos?.[1]} w="24px" h="24px" ml="-16px" />
          </HStack>
        ) : (
          <Image src={logo} w="24px" h="24px" />
        )}
        <Text variant="value" textTransform="unset">
          {label}
        </Text>
      </HStack>

      {showBadge && (
        <Badge fontSize="10px" colorScheme="green">
          {badge}
        </Badge>
      )}
      {badge === "SWAP" ? <Text variant="value" textTransform="unset">
      to USDC
      </Text> : badge === "LOOP" ? <Text variant="value" textTransform="unset">
       for {num(newValue??0).div(startingValue??0).multipliedBy(100).toFixed(0)}% leverage on {label} at a ${newValue} new position value
      </Text>
      : null}
    </HStack>
    <HStack>
      {badge !== "LOOP" ? <Text>{num(amount).abs().toString()}</Text> : null}
    </HStack>
  </HStack>
)

export const QASummary = ({ newPositionValue, swapRatio, summary } : {newPositionValue: number, swapRatio: number, summary: any[]}) => {
  const { quickActionState, setQuickActionState } = useQuickActionState()
  // const cdt = useAssetBySymbol('CDT')
  // const usdc = useAssetBySymbol('USDC')

  return (
    <Stack h="max-content" overflow="auto" w="full">

      <SummaryItem
        key={quickActionState?.levAsset?.symbol??"" + quickActionState?.levAsset?.amount}
        label={quickActionState?.levAsset?.symbol??""}
        amount={num(quickActionState?.levAsset?.amount).times(swapRatio).toNumber()}
        logo={quickActionState?.levAsset?.logo}
        isLP={quickActionState?.levAsset?.isLP}
        badge={"Swap"}
      />

      {summary.map((asset) => {
        const badge = 'Deposit'
        return (
          <SummaryItem
            key={asset?.label + asset?.amount}
            label={asset?.label}
            amount={asset?.amount}
            logo={asset?.logo}
            isLP={asset?.isLP}
            badge={badge}
          />
        )
      })}

      <SummaryItem
        key={quickActionState?.levAsset?.symbol??"" + quickActionState?.levAsset?.amount}
        label={quickActionState?.levAsset?.symbol??""}
        amount={num(quickActionState?.levAsset?.amount).times(quickActionState?.levSwapRatio??0).toNumber()}
        logo={quickActionState?.levAsset?.logo}
        isLP={quickActionState?.levAsset?.isLP}
        badge={"LOOP"}
        startingValue={quickActionState?.levAsset?.sliderValue??0}
        newValue={newPositionValue}
      />
      <Checkbox isChecked={quickActionState.useCookies} paddingBottom={"4%"} borderColor={"#00A3F9"} onChange={() => {setQuickActionState({useCookies: !quickActionState.useCookies})}}> 
        Use cookies to track performance
      </Checkbox >
    </Stack>    
  )
}

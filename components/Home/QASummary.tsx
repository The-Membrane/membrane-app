import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
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
       for {parseInt((newValue??0/(startingValue??0)).toFixed(0))}% leverage on {label} at a ${newValue} new position value
      </Text>
      : null}
    </HStack>
    <HStack>
      {badge !== "LOOP" ? <Text>{num(amount).abs().toString()}</Text> : null}
    </HStack>
  </HStack>
)

export const QASummary = ({ newPositionValue } : {newPositionValue: number, newLTV: number}) => {
  const { quickActionState } = useQuickActionState()
  const cdt = useAssetBySymbol('CDT')
  const usdc = useAssetBySymbol('USDC')
  // console.log(parseInt((newValue??0/(startingValue??0)).toFixed(0)), num(??0), newPositionValue??0, num(quickActionState?.levAsset?.sliderValue??0).div(newPositionValue??0).toFixed(0))
  return (
    <Stack h="max-content" overflow="auto" w="full">

      <SummaryItem
        key={quickActionState?.levAsset?.symbol??"" + quickActionState?.levAsset?.amount}
        label={quickActionState?.levAsset?.symbol??""}
        amount={num(quickActionState?.levAsset?.amount).times(quickActionState?.levSwapRatio??0).toNumber()}
        logo={quickActionState?.levAsset?.logo}
        isLP={quickActionState?.levAsset?.isLP}
        badge={"Swap"}
      />

      {quickActionState?.summary?.map((asset) => {
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
        // amount={num(quickActionState?.levAsset?.amount).times(quickActionState?.levSwapRatio??0).toNumber()}
        logo={quickActionState?.levAsset?.logo}
        isLP={quickActionState?.levAsset?.isLP}
        badge={"LOOP"}
        startingValue={quickActionState?.levAsset?.sliderValue??0}
        newValue={newPositionValue}
      />
    </Stack>
  )
}

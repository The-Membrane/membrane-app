import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import { AssetWithBalance } from './hooks/useCombinBalance'
import useMintState from './hooks/useMintState'
import useVaultSummary from './hooks/useVaultSummary'

type SummaryItemProps = Partial<AssetWithBalance> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  logos?: string[]
  isLP?: boolean
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  logos,
  isLP,
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
    </HStack>
    <HStack>
      <Text>{badge != "Mint" && badge != "Repay" && "$"}{num(amount).abs().toString()}</Text>
    </HStack>
  </HStack>
)

export const Summary = () => {
  const { mintState } = useMintState()
  const { data } = useVaultSummary()
  const { debtAmount } = data || {
    debtAmount: 0,
    cost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  }
  const { summary } = mintState
  const cdt = useAssetBySymbol('CDT')
  // console.log("Mint Summary", mintState.repay ?? 0, debtAmount)

  if (!mintState.isTakeAction) return null

  return (
    <Stack h="max-content" overflow="auto" w="full">
      {summary?.map((asset) => {
        const badge = num(asset.amount).isGreaterThan(0) ? 'Deposit' : 'Withdraw'
        console.log("Mint Summary", asset.amount, badge)
        return (
          <SummaryItem
            key={asset?.label + asset?.amount}
            label={asset?.label}
            amount={asset?.amountValue.toFixed(2)}
            logo={asset?.logo}
            logos={asset?.logos}
            isLP={asset?.isLP}
            badge={badge}
          />
        )
      })}

      {num(mintState.mint).isGreaterThan(0) && (
        <SummaryItem
          label="CDT"
          badge="Mint"
          amount={mintState.mint?.toFixed(2)}
          logo={cdt?.logo}
        />
      )}

      {num(mintState.repay).isGreaterThan(0) && (
        <SummaryItem
          label="CDT"
          badge="Repay"
          amount={Math.min(debtAmount, mintState.repay ?? 0).toFixed(2)}
          logo={cdt?.logo}
        />
      )}
    </Stack>
  )
}

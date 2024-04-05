import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Asset } from '@chain-registry/types'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import useStakeState from './hooks/useStakeState'
import { getAssetByDenom, getAssetLogo } from '@/helpers/chain'
import { ClaimsResponse } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.types'
import { shiftDigits } from '@/helpers/math'
// import { AssetWithBalance } from './hooks/useCombinBalance'
// import useMintState from './hooks/useMintState'

type SummaryItemProps = Partial<Asset> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  asset?: Asset
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  asset,
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
        {asset?.isLP ? (
          <HStack>
            <Image src={asset?.logos?.[0]} w="24px" h="24px" />
            <Image src={asset?.logos?.[1]} w="24px" h="24px" ml="-16px" />
          </HStack>
        ) : (
          <Image src={asset?.logo} w="24px" h="24px" />
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
      <Text>{num(amount).abs().toString()}</Text>
    </HStack>
  </HStack>
)

type Props = {
  claims?: ClaimsResponse[]
}

export const ClaimSummary = ({ claims = [] }: Props) => {
  // const { stakeState } = useStakeState()
  // const { asset, amount } = stakeState
  // const logo = getAssetLogo(asset!)

  // const txType = num(amount).isGreaterThan(0) ? 'Stake' : 'Unstake'

  return (
    <Stack h="max-content" overflow="auto" w="full">
      {claims
        .filter((a) => num(a.pending_liquidated_collateral).isGreaterThan(0))
        .map((claim) => {
          const asset = getAssetByDenom(claim.bid_for)
          const amount = shiftDigits(
            claim.pending_liquidated_collateral,
            -asset?.decimal!,
          ).toNumber()
          return (
            <SummaryItem
              key={claim.bid_for}
              label={asset?.symbol!}
              amount={amount}
              badge="Claim"
              asset={asset}
            />
          )
        })}
    </Stack>
  )
}

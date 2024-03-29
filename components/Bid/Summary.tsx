import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
// import { Asset } from '@chain-registry/types'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
// import useStakeState from './hooks/useStakeState'
import { Asset, getAssetLogo } from '@/helpers/chain'
import useBidState from './hooks/useBidState'
// import { AssetWithBalance } from './hooks/useCombinBalance'
// import useMintState from './hooks/useMintState'

type SummaryItemProps = Partial<Asset> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  selectedAsset: Asset
  premium: number
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  selectedAsset,
  premium,
}: SummaryItemProps) => (
  <Stack gap="10">
    <Stack alignSelf="center">
      <Text variant="value" textTransform="unset" fontSize="md">
        Bidding on
      </Text>
      <HStack>
        <Image src={selectedAsset?.logo} w="30px" h="30px" />
        <Text variant="value" textTransform="unset">
          {selectedAsset?.symbol}
        </Text>
      </HStack>
    </Stack>

    {/* 5 CDT BID on ATOM at 5% premium */}

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
          <Image src={logo} w="20px" h="20px" />
          <Text variant="value" textTransform="unset">
            {label}
          </Text>
        </HStack>

        <Badge fontSize="10px" colorScheme="green">
          {badge}
        </Badge>
        <Text variant="value" textTransform="unset">
          with {premium}% premium
        </Text>
      </HStack>
      <HStack>
        <Text>{num(amount).abs().toString()}</Text>
      </HStack>
    </HStack>
  </Stack>
)

const Summary = () => {
  // const { stakeState } = useStakeState()
  // const { asset, amount } = stakeState
  const cdtAsset = useAssetBySymbol('CDT')
  const logo = getAssetLogo(cdtAsset!)
  const { bidState, setBidState } = useBidState()
  const selectedAsset = bidState?.selectedAsset
  const { premium, cdt: amount } = bidState?.placeBid

  // const txType = num(amount).isGreaterThan(0) ? 'Stake' : 'Unstake'

  return (
    <Stack h="max-content" overflow="auto" w="full">
      <SummaryItem
        label={cdtAsset?.symbol!}
        badge="Bid"
        amount={amount}
        logo={logo}
        selectedAsset={selectedAsset}
        premium={premium}
      />
    </Stack>
  )
}

export default Summary

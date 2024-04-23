import ConfirmModal from '@/components/ConfirmModal'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { Card, HStack, Stack, Text } from '@chakra-ui/react'
import { SliderWithState } from '../Mint/SliderWithState'
import Summary from './Summary'
import useBid from './hooks/useBid'
import useBidState from './hooks/useBidState'
import useQueue from './hooks/useQueue'

const PlaceBid = () => {
  const { bidState, setBidState } = useBidState()

  const txSuccess = () => {
    setBidState({ placeBid: { cdt: 0, premium: 0 } })
  }

  const bid = useBid({ txSuccess })
  const { data: queue } = useQueue(bidState?.selectedAsset)

  const cdt = useAssetBySymbol('CDT')
  const cdtBalance = useBalanceByAsset(cdt)

  const maxPremium = queue?.max_premium

  const onCDTChange = (value: number) => {
    const existingBid = bidState?.placeBid || {}
    const placeBid = {
      ...existingBid,
      cdt: value,
    }
    setBidState({ ...bidState, placeBid })
  }

  const onPremiumChange = (value: number) => {
    const existingBid = bidState?.placeBid || {}
    const placeBid = {
      ...existingBid,
      premium: value,
    }
    setBidState({ ...bidState, placeBid })
  }

  const isDisabled = !bidState?.placeBid?.cdt || !bidState?.placeBid?.premium

  return (
    <Card p="8" alignItems="center" gap={5}>
      <Text variant="title" fontSize="24px">
        Place Bid
      </Text>

      <HStack w="full" gap="10" mb="2">
        <Stack w="full" gap="1">
          <HStack justifyContent="space-between">
            <Text fontSize="16px" fontWeight="700">
              {bidState?.placeBid?.cdt}
            </Text>
            <Text fontSize="16px" fontWeight="700">
              CDT with
            </Text>
          </HStack>
          <SliderWithState
            value={bidState?.placeBid?.cdt}
            onChange={onCDTChange}
            min={0}
            max={Number(cdtBalance)}
          />
        </Stack>

        <Stack w="full" gap="1">
          <HStack justifyContent="space-between">
            <Text fontSize="16px" fontWeight="700">
              {bidState?.placeBid?.premium}
            </Text>
            <Text fontSize="16px" fontWeight="700">
              % Premium
            </Text>
          </HStack>
          <SliderWithState
            value={bidState?.placeBid?.premium}
            onChange={onPremiumChange}
            min={0}
            max={Number(maxPremium || 0)}
          />
        </Stack>
      </HStack>

      <Stack gap="5">
        <Stack>
          <HStack justifyContent="space-between">
            <Text fontSize="16px" fontWeight="700">
              Single Asset Pool
            </Text>
            <Text fontSize="16px" fontWeight="700">
              0-{maxPremium}%
            </Text>
          </HStack>
          <Text fontSize="14px">
            Bid to earn from liquidations of your chosen collateral in the order of descending
            premiums (i.e. 0% is first). There is a 1 hour waiting period that is handled
            automatically, so there is no need to activate your bid manually. If you bid too high a
            premium, other liquidators can undercut you so beware!
          </Text>
        </Stack>

        <Stack>
          <HStack justifyContent="space-between">
            <Text fontSize="16px" fontWeight="700">
              Omni Asset Pool
            </Text>
            <Text fontSize="16px" fontWeight="700">
              10%
            </Text>
          </HStack>
          <Text fontSize="14px">
            Earn from every liquidation of every asset done at a non-zero premium. This is First In
            First Out with a 1 day unstaking period where your bid can still be used to liquidate.
            Get your bid in early then sit back and enjoy the flow of assets!
          </Text>
        </Stack>
      </Stack>

      <ConfirmModal label="Place Bid" action={bid} isDisabled={isDisabled}>
        <Summary />
      </ConfirmModal>
    </Card>
  )
}

export default PlaceBid

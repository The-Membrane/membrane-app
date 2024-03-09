import { HStack, Stack, Text } from '@chakra-ui/react'
import React from 'react'
import ConfirmModal from '../ConfirmModal'
import { SliderWithState } from '../Mint/SliderWithState'
import TxError from '../TxError'
import { Summary } from './Summary'

type Props = {}

const ClaimAndRestake = (props: Props) => {
  return (
    <Stack gap="10" pt="5">
      <Stack>
        <HStack justifyContent="space-between">
          <Text>MBRN</Text>
          <Text>12 MBRN</Text>
        </HStack>
        <HStack justifyContent="space-between">
          <Text>CDT</Text>
          <Text>898 MBRN</Text>
        </HStack>
      </Stack>
      <ConfirmModal label={'Claim'}>
        <Summary />
        {/* <TxError action={stake} /> */}
      </ConfirmModal>
    </Stack>
  )
}

export default ClaimAndRestake

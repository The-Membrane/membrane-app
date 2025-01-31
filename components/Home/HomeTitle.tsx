import { Button, HStack, Stack, Text } from '@chakra-ui/react'
import React, { useCallback, useMemo, useState } from 'react'
import Divider from '../Divider'
import OnboardModal from './LeapOnboarding'



export const HomeTitle = React.memo(() => {

  const [isOpen, setOpen] = useState(false)

  return (
    <Stack gap={5}>
      <HStack mt="auto" gap="24" justifyContent="center">
        <Stack gap={5}>

          <h1
            className={"home-title"}
          >
            Decentralized Market Making the World's Reserve
          </h1>
          <Button alignSelf="center" width="50%" minWidth="180px"
            onClick={() => setOpen(true)}>
            Add Funds to Osmosis
          </Button>
        </Stack>
      </HStack>
      <OnboardModal isOpen={isOpen} setOpen={setOpen} />
      <Divider mx="0" mb="5" />
    </Stack>
  )
})
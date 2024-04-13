import { Center } from '@chakra-ui/react'
import useMembersRulesState from './useRules'
import { RulesModal } from './RulesModal'

export const rules = [
  'Sovereign individuals only',
  'Your actions are your own responsibility/liability',
  'If your jurisdiction is banned, do not enter',
  "Once you're in, you're within",
]

const MembersRules = () => {
  const { show } = useMembersRulesState()
  if (!show) return null
  return (
    <Center
      w="1440px"
      h="1080px"
      margin="auto"
      bg="#111015"
      position="relative"
      zIndex={1}
      bgImg={`url("/images/backgrounds/rules_bg.svg")`}
      bgSize="contain"
      bgRepeat="no-repeat"
      bgPosition="center"
    >
      <RulesModal />
    </Center>
  )
}

export default MembersRules

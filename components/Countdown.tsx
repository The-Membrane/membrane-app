import { Text, TextProps } from "@chakra-ui/react"
import useCountdown from "@/hooks/useCountdown"
import { memo } from "react"

type Props = {
  timestamp: number | undefined
  showLabel?: boolean
  fontSize?: string
  color?: string
  fontFamily?: string
  fontWeight?: string | number
} & Omit<TextProps, 'fontSize' | 'color' | 'fontFamily' | 'fontWeight'>

const Countdown = memo(({
  timestamp,
  showLabel = false,
  fontSize = "16px",
  color,
  fontFamily,
  fontWeight = "700",
  ...textProps
}: Props) => {
  const timeLeft = useCountdown(timestamp).timeString

  return (
    <Text
      fontSize={fontSize}
      color={color}
      fontFamily={fontFamily}
      fontWeight={fontWeight}
      {...textProps}
    >
      {showLabel && "Time Left: "}{timeLeft}
    </Text>
  )
})

export default Countdown

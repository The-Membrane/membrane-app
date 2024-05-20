import { useState, useEffect } from 'react'
import dayjs from 'dayjs'

const useCountdown = (timestamp: number | null | undefined) => {
  const [isEnded, setIsEnded] = useState(false)
  const [timeString, setTimeString] = useState('')

  useEffect(() => {
    if (!timestamp) return
    const intervalId = setInterval(() => {
      const currentTime = dayjs()
      const endTime = dayjs.unix(timestamp + 86400)
      const remainingTime = endTime.diff(currentTime, 'second')

      if (remainingTime <= 0) {
        setIsEnded(true)
        setTimeString('00:00:00')
        clearInterval(intervalId)
      } else {
        const hours = Math.floor(remainingTime / 3600)
        const minutes = Math.floor((remainingTime % 3600) / 60)
        const seconds = remainingTime % 60

        const formattedHours = String(hours).padStart(2, '0')
        const formattedMinutes = String(minutes).padStart(2, '0')
        const formattedSeconds = String(seconds).padStart(2, '0')

        setTimeString(`${formattedHours}:${formattedMinutes}:${formattedSeconds}`)
      }
    }, 1000)

    return () => clearInterval(intervalId)
  }, [timestamp])

  return { isEnded, timeString }
}

export default useCountdown

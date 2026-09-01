import dayjs from 'dayjs'

export const getTimeLeft = (unstakeStartDate: number) => {
  const unstakingDate = dayjs.unix(unstakeStartDate).add(4, 'day')
  const daysLeft = unstakingDate.diff(dayjs(), 'day')
  const hoursLeft = unstakingDate.diff(dayjs(), 'hour')
  const minutesLeft = unstakingDate.diff(dayjs(), 'minute')

  return {
    daysLeft,
    hoursLeft,
    minutesLeft,
  }
}

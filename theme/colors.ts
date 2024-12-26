import type { DeepPartial, Theme } from '@chakra-ui/react'
import { colors as configColors } from '@/config/defaults'


/** extend additional color here */
export const colors: DeepPartial<Record<string, Theme['colors']['blackAlpha']>> = {
  primary: {
    '100': configColors.p100,
    '200': configColors.p200,
    '300': configColors.p300,
    '400': configColors.p400,
    '500': configColors.p500,
    '600': configColors.p600,
    '700': configColors.p700,
    '800': configColors.p800,
    '900': configColors.p900,
  },
}

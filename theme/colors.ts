import type { DeepPartial, Theme } from '@chakra-ui/react'
import { colors as configColors } from '@/config/defaults'


/** extend additional color here */
export const colors: DeepPartial<Record<string, Theme['colors']['blackAlpha']>> = {
  // Phosphor ramp — Chakra colorScheme="primary" (default). Living Typeface accent/positive.
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
  // Cyber-teal ramp — colorScheme="secondary". Machine/info emphasis; the migration
  // target for legacy cyan.* references. Canonical token #46d39a sits at 400.
  secondary: {
    '100': '#d3f4e8',
    '200': '#a9e9cf',
    '300': '#7fddb7',
    '400': '#46d39a',
    '500': '#38bd88',
    '600': '#2ea073',
    '700': '#26805c',
    '800': '#1d6046',
    '900': '#133f2f',
  },
}

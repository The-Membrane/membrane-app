import type { DeepPartial, Theme } from '@chakra-ui/react'

// Living Typeface font stacks. Redaction + JetBrains Mono are declared via
// @font-face in styles/fonts.css (pointing at /fonts/redaction/*.woff2 and
// /fonts/jetbrains/*.woff2). Georgia / ui-monospace fallbacks mean nothing breaks
// if the woff2 files aren't present yet — run scripts/extract-fonts.mjs to emit them.
//
// - heading: Redaction (serif) — display + headings, weight 400, italic for editorial.
// - body:    JetBrains Mono — body UI AND all numbers/data (machine-readable).
// - mono:    JetBrains Mono — same face; kept distinct for `fontFamily="mono"` sites.
export const fonts: DeepPartial<Theme['fonts']> = {
  heading: "'Redaction', Georgia, 'Times New Roman', serif",
  body: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
  mono: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
}

export const fontSizes = {
  xs: '12px',
  sm: '14px',
  md: '16px',
  lg: '18px',
  xl: '24px',
}
export const fontWeights = {
  normal: 400,
  medium: 500,
  bold: 700,
}

'use strict'
const tester = require('./tester')
const rule = require('../design-no-banned-color')

tester.run('design-no-banned-color', rule, {
  valid: [
    '<Text color={SEMANTIC_COLORS.textPrimary} />',
    '<Button colorScheme="phosphor" />',
    '<Box bg="white" />', // CLAUDE.md:144 bans white TEXT; bg is out of scope for this rule
    '<Text color="#fffff0" />', // not pure white
    '// legacy #A692FF in a comment is fine\nconst x = 1',
    'const purple = "#A692FE"',
  ],
  invalid: [
    { code: '<Text color="#A692FF">Emphasis</Text>', errors: [{ messageId: 'legacyHex' }] }, // CLAUDE.md:645
    { code: 'const c = { accent: "#6943ff" }', errors: [{ messageId: 'legacyHex' }] },
    { code: 'const glow = `0 0 8px #22D3EE`', errors: [{ messageId: 'legacyHex' }] },
    { code: '<Button colorScheme="purple" />', errors: [{ messageId: 'purpleScheme' }] }, // CLAUDE.md:351
    { code: "<Button colorScheme={'purple'} />", errors: [{ messageId: 'purpleScheme' }] },
    { code: '<Text fontFamily="Inter" color="white" />', errors: [{ messageId: 'pureWhiteText' }] }, // CLAUDE.md:662
    { code: '<Text color="whiteAlpha.700" />', errors: [{ messageId: 'pureWhiteText' }] },
    { code: '<Box _hover={{ color: "#FFF" }} />', errors: [{ messageId: 'pureWhiteText' }] },
  ],
})

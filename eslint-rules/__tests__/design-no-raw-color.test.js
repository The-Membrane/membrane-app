'use strict'
const tester = require('./tester')
const rule = require('../design-no-raw-color')

tester.run('design-no-raw-color', rule, {
  valid: [
    '<Box bg={SEMANTIC_COLORS.bgCard} borderColor={SEMANTIC_COLORS.hairline} />',
    '<Box bg="transparent" color="currentColor" />',
    '<Box border="1px solid" />',
    '<a href="#section" />', // not a colour prop
    '<Chart data={{ color: "#fff" }} />', // data object, not a style container
    '<Box color={`${SEMANTIC_COLORS.success}`} />',
  ],
  invalid: [
    // CLAUDE.md:655 Common Mistakes, verbatim
    { code: '<Box bg="rgba(10,10,10,0.8)" borderRadius="24px" p={6} />', errors: [{ messageId: 'raw' }] },
    { code: '<Text color="#ece6d8" />', errors: [{ messageId: 'raw' }] },
    { code: '<Box border="1px solid #333" />', errors: [{ messageId: 'raw' }] },
    { code: '<Box _hover={{ boxShadow: "0 0 20px rgba(155,220,79,0.6)" }} />', errors: [{ messageId: 'raw' }] }, // CLAUDE.md:659
    { code: '<path fill="#9bdc4f" stroke={"#000"} />', errors: [{ messageId: 'raw' }, { messageId: 'raw' }] },
    { code: '<div style={{ backgroundColor: "hsl(0 0% 50%)" }} />', errors: [{ messageId: 'raw' }] },
    { code: '<Box bg={{ base: "#111", md: SEMANTIC_COLORS.bgCard }} />', errors: [{ messageId: 'raw' }] },
    { code: '<Box borderTopColor={ok ? "#fff" : "#000"} />', errors: [{ messageId: 'raw' }, { messageId: 'raw' }] },
  ],
})

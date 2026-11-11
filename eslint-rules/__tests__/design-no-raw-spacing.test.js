'use strict'
const tester = require('./tester')
const rule = require('../design-no-raw-spacing')

tester.run('design-no-raw-spacing', rule, {
  valid: [
    '<Box p={SPACING.base} gap={SPACING_PATTERNS.sectionGap} />',
    '<Box p={4} m={0} gap={6} px={16} mt={-2} />',
    '<Box p={{ base: 4, md: 6, lg: 8 }} />', // CLAUDE.md:451 responsive example
    '<Box mx="auto" p="0" m="0px" />',
    '<Box w="20px" h="100%" />', // not spacing props
    '<Chart data={{ p: 5, gap: "20px" }} />', // data objects are not style containers
    '<Box p={isMobile ? SPACING.sm : SPACING.base} />',
  ],
  invalid: [
    // CLAUDE.md:639 Common Mistakes, verbatim
    {
      code: '<Box p={5} gap="20px" mt="1.5rem" mb="9%" />',
      errors: [{ messageId: 'offScale' }, { messageId: 'unit' }, { messageId: 'unit' }, { messageId: 'unit' }],
    },
    { code: '<div style={{ padding: "20px" }} />', errors: [{ messageId: 'unit' }] }, // CLAUDE.md:179
    { code: '<Box p="4" />', errors: [{ messageId: 'stringNumeric' }] }, // CLAUDE.md:182
    { code: '<Box p={{ base: 5, md: "2rem" }} />', errors: [{ messageId: 'offScale' }, { messageId: 'unit' }] },
    { code: '<Box p={[2, 5]} />', errors: [{ messageId: 'offScale' }] },
    { code: '<Box _hover={{ "& > p": { mt: 0.5 } }} />', errors: [{ messageId: 'offScale' }] },
    { code: '<Box sx={{ gap: `12px` }} />', errors: [{ messageId: 'unit' }] },
    { code: '<Box p={open ? 5 : 4} />', errors: [{ messageId: 'offScale' }] },
    { code: '<Box mt={-5} />', errors: [{ messageId: 'offScale' }] },
  ],
})

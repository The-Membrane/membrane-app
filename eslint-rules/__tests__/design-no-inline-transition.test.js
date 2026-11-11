'use strict'
const tester = require('./tester')
const rule = require('../design-no-inline-transition')

tester.run('design-no-inline-transition', rule, {
  valid: [
    '<Button transition={TRANSITIONS.colorAndBorder} />',
    '<Box transition="none" />',
    '<motion.div transition={{ duration: 0.3, ease: "easeOut" }} />', // framer object, not CSS string
    '<Box _hover={HOVER_EFFECTS.borderHighlight} />',
  ],
  invalid: [
    { code: '<Button transition="all 0.2s" />', errors: [{ messageId: 'inline' }] }, // CLAUDE.md:281,642
    { code: '<Box sx={{ transition: "opacity 300ms ease" }} />', errors: [{ messageId: 'inline' }] },
    { code: '<div style={{ transitionDuration: "1s" }} />', errors: [{ messageId: 'inline' }] },
    { code: '<Box transition={`color .3s`} />', errors: [{ messageId: 'inline' }] },
    { code: '<Box transition={open ? "all .2s" : "none"} />', errors: [{ messageId: 'inline' }] },
  ],
})

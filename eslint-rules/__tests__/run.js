'use strict'
/**
 * Runs every eslint-rules/__tests__/*.test.js with plain node and prints pass/fail counts.
 *   node eslint-rules/__tests__/run.js
 * eslint + @typescript-eslint/parser must be resolvable (repo node_modules, or NODE_PATH).
 * Defining describe/it before RuleTester loads makes it report each case instead of
 * throwing on the first failure.
 */
const fs = require('fs')
const path = require('path')

let pass = 0
let fail = 0
const stack = []
global.describe = (name, fn) => {
  stack.push(name)
  fn()
  stack.pop()
}
global.it = (name, fn) => {
  try {
    fn()
    pass++
  } catch (e) {
    fail++
    console.error(`FAIL ${stack.join(' > ')} > ${name}\n  ${String(e.message).split('\n').join('\n  ')}`)
  }
}
global.it.only = global.it

for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) {
  const before = pass + fail
  require(path.join(__dirname, f))
  console.log(`${f}: ${pass + fail - before} cases`)
}
console.log(`RuleTester: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

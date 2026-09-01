/**
 * Safe evaluator for the Ditto condition DSL (the `when` / message `condition` strings
 * authored in-repo under contracts/*Contract.ts).
 *
 * SECURITY: this replaces `new Function(...)` / `eval(...)` (react-doctor `no-eval`, a
 * code-injection + CSP-violation risk) with a tiny recursive-descent evaluator over a
 * FIXED grammar. No assignment, no arbitrary property calls (only `Math.*`), no access to
 * globals beyond `Math`. Even though the expressions are trusted (developer-authored, never
 * user input), removing runtime code-gen lets the app run under a strict CSP and closes the
 * class entirely.
 *
 * Behavioral contract (matches the previous `new Function(...keys, 'return Boolean(expr)')`):
 * - Identifiers resolve from `scope`; an identifier absent from `scope` (and not `Math`)
 *   throws — exactly like the old ReferenceError, which every call site already catches and
 *   turns into `false`.
 * - `&&` / `||` short-circuit and return the operand value (not a coerced boolean), so the
 *   un-taken branch is never evaluated (and never throws) — same as JS.
 * - `==` / `!=` are loose, `===`-family is not part of the grammar.
 *
 * Supported: number / string / boolean / null literals, identifiers, member access (`a.b`),
 * `Math.*(...)` calls, unary `!` and `-`, `* + -`, `== != < <= > >=`, `&& ||`, parentheses.
 */

type Scope = Record<string, unknown>

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }

const MULTI_CHAR_OPS = ['&&', '||', '==', '!=', '<=', '>=']
const SINGLE_CHAR_OPS = ['!', '<', '>', '+', '-', '*', '(', ')', '.', ',']

function tokenize(src: string): Tok[] {
  const tokens: Tok[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    // string literal
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      let s = ''
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) {
          s += src[j + 1]
          j += 2
        } else {
          s += src[j]
          j++
        }
      }
      if (j >= n) throw new Error('Unterminated string literal')
      tokens.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    // number literal
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++
      tokens.push({ t: 'num', v: Number(src.slice(i, j)) })
      i = j
      continue
    }
    // identifier
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++
      tokens.push({ t: 'id', v: src.slice(i, j) })
      i = j
      continue
    }
    // multi-char operator
    const two = src.slice(i, i + 2)
    if (MULTI_CHAR_OPS.includes(two)) {
      tokens.push({ t: 'op', v: two })
      i += 2
      continue
    }
    // single-char operator
    if (SINGLE_CHAR_OPS.includes(c)) {
      tokens.push({ t: 'op', v: c })
      i++
      continue
    }
    throw new Error(`Unexpected character '${c}' in expression`)
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Parser (recursive descent → AST) + evaluator (walks AST with short-circuit)
// ---------------------------------------------------------------------------

type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'id'; name: string }
  | { k: 'member'; obj: Node; prop: string }
  | { k: 'call'; callee: Node; args: Node[] }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'logical'; op: string; l: Node; r: Node }

const BLOCKED_PROPS = new Set(['__proto__', 'constructor', 'prototype'])

class Parser {
  private pos = 0
  constructor(private toks: Tok[]) {}

  parse(): Node {
    const node = this.parseOr()
    if (this.pos < this.toks.length) throw new Error('Unexpected trailing tokens')
    return node
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos]
  }
  private eatOp(v: string): boolean {
    const t = this.peek()
    if (t && t.t === 'op' && t.v === v) {
      this.pos++
      return true
    }
    return false
  }

  private parseOr(): Node {
    let left = this.parseAnd()
    while (this.eatOp('||')) left = { k: 'logical', op: '||', l: left, r: this.parseAnd() }
    return left
  }
  private parseAnd(): Node {
    let left = this.parseEquality()
    while (this.eatOp('&&')) left = { k: 'logical', op: '&&', l: left, r: this.parseEquality() }
    return left
  }
  private parseEquality(): Node {
    let left = this.parseRelational()
    for (;;) {
      const t = this.peek()
      if (t && t.t === 'op' && (t.v === '==' || t.v === '!=')) {
        this.pos++
        left = { k: 'bin', op: t.v, l: left, r: this.parseRelational() }
      } else break
    }
    return left
  }
  private parseRelational(): Node {
    let left = this.parseAdditive()
    for (;;) {
      const t = this.peek()
      if (t && t.t === 'op' && (t.v === '<' || t.v === '<=' || t.v === '>' || t.v === '>=')) {
        this.pos++
        left = { k: 'bin', op: t.v, l: left, r: this.parseAdditive() }
      } else break
    }
    return left
  }
  private parseAdditive(): Node {
    let left = this.parseMultiplicative()
    for (;;) {
      const t = this.peek()
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.pos++
        left = { k: 'bin', op: t.v, l: left, r: this.parseMultiplicative() }
      } else break
    }
    return left
  }
  private parseMultiplicative(): Node {
    let left = this.parseUnary()
    for (;;) {
      const t = this.peek()
      if (t && t.t === 'op' && t.v === '*') {
        this.pos++
        left = { k: 'bin', op: '*', l: left, r: this.parseUnary() }
      } else break
    }
    return left
  }
  private parseUnary(): Node {
    const t = this.peek()
    if (t && t.t === 'op' && (t.v === '!' || t.v === '-')) {
      this.pos++
      return { k: 'unary', op: t.v, arg: this.parseUnary() }
    }
    return this.parsePostfix()
  }
  private parsePostfix(): Node {
    let node = this.parsePrimary()
    for (;;) {
      if (this.eatOp('.')) {
        const t = this.peek()
        if (!t || t.t !== 'id') throw new Error('Expected property name after "."')
        this.pos++
        if (BLOCKED_PROPS.has(t.v)) throw new Error(`Access to '${t.v}' is not allowed`)
        node = { k: 'member', obj: node, prop: t.v }
      } else if (this.eatOp('(')) {
        const args: Node[] = []
        if (!this.eatOp(')')) {
          args.push(this.parseOr())
          while (this.eatOp(',')) args.push(this.parseOr())
          if (!this.eatOp(')')) throw new Error('Expected ")"')
        }
        node = { k: 'call', callee: node, args }
      } else break
    }
    return node
  }
  private parsePrimary(): Node {
    const t = this.peek()
    if (!t) throw new Error('Unexpected end of expression')
    if (t.t === 'num') {
      this.pos++
      return { k: 'lit', v: t.v }
    }
    if (t.t === 'str') {
      this.pos++
      return { k: 'lit', v: t.v }
    }
    if (t.t === 'id') {
      this.pos++
      if (t.v === 'true') return { k: 'lit', v: true }
      if (t.v === 'false') return { k: 'lit', v: false }
      if (t.v === 'null') return { k: 'lit', v: null }
      if (t.v === 'undefined') return { k: 'lit', v: undefined }
      return { k: 'id', name: t.v }
    }
    if (t.t === 'op' && t.v === '(') {
      this.pos++
      const node = this.parseOr()
      if (!this.eatOp(')')) throw new Error('Expected ")"')
      return node
    }
    throw new Error(`Unexpected token '${t.v}'`)
  }
}

function evalNode(node: Node, scope: Scope): unknown {
  switch (node.k) {
    case 'lit':
      return node.v
    case 'id': {
      if (Object.prototype.hasOwnProperty.call(scope, node.name)) return scope[node.name]
      if (node.name === 'Math') return Math
      // Match the old `new Function` ReferenceError; callers catch → false.
      throw new ReferenceError(`${node.name} is not defined`)
    }
    case 'member': {
      const obj = evalNode(node.obj, scope) as Record<string, unknown> | null | undefined
      if (obj == null) throw new TypeError(`Cannot read '${node.prop}' of ${String(obj)}`)
      if (BLOCKED_PROPS.has(node.prop)) throw new Error(`Access to '${node.prop}' is not allowed`)
      return obj[node.prop]
    }
    case 'call': {
      // Only allow calling a method on a member expression whose receiver is Math.
      if (node.callee.k !== 'member') throw new Error('Only Math.* calls are allowed')
      const receiver = evalNode(node.callee.obj, scope)
      if (receiver !== Math) throw new Error('Only Math.* calls are allowed')
      const fn = (Math as unknown as Record<string, unknown>)[node.callee.prop]
      if (typeof fn !== 'function') throw new TypeError(`Math.${node.callee.prop} is not a function`)
      const args = node.args.map((a) => evalNode(a, scope))
      return (fn as (...a: unknown[]) => unknown)(...args)
    }
    case 'unary': {
      const v = evalNode(node.arg, scope) as any
      return node.op === '!' ? !v : -v
    }
    case 'logical': {
      const l = evalNode(node.l, scope) as any
      if (node.op === '&&') return l ? evalNode(node.r, scope) : l
      return l ? l : evalNode(node.r, scope)
    }
    case 'bin': {
      const l = evalNode(node.l, scope) as any
      const r = evalNode(node.r, scope) as any
      switch (node.op) {
        case '+': return l + r
        case '-': return l - r
        case '*': return l * r
        case '<': return l < r
        case '<=': return l <= r
        case '>': return l > r
        case '>=': return l >= r
        // eslint-disable-next-line eqeqeq
        case '==': return l == r
        // eslint-disable-next-line eqeqeq
        case '!=': return l != r
      }
    }
  }
  throw new Error('Unknown node')
}

const astCache = new Map<string, Node>()

/**
 * Evaluate a Ditto condition expression against a scope of facts/values.
 * Returns the raw expression value (callers typically wrap in `Boolean(...)`).
 * Throws on unknown identifiers or malformed input — callers catch and treat as `false`.
 */
export function evaluateExpression(expr: string, scope: Scope): unknown {
  let ast = astCache.get(expr)
  if (!ast) {
    ast = new Parser(tokenize(expr)).parse()
    astCache.set(expr, ast)
  }
  return evalNode(ast, scope)
}

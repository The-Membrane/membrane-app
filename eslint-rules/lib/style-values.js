'use strict'
/**
 * Shared walker for Chakra-style JSX props.
 *
 * Yields every literal value that ends up on a style prop, whether written as
 *   <Box p="20px">                       (attribute literal)
 *   <Box p={{ base: 5, md: '2rem' }}>    (responsive object)
 *   <Box p={[2, 5]}>                     (responsive array)
 *   <Box sx={{ padding: '20px' }}>       (style container: sx/style/css/__css/_hover/...)
 *   <Box _hover={{ '& > p': { m: 5 } }}> (nested selectors)
 * Objects passed to NON-style props (e.g. data={{ p: 5 }}) are not descended,
 * which keeps the rules from flagging arbitrary data objects.
 *
 * Lives in eslint-rules/lib/ because --rulesdir loads every top-level .js file as a rule.
 */

const BREAKPOINTS = new Set(['base', 'xxs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'])
const CONTAINER_ATTRS = new Set(['sx', 'style', 'css', '__css'])

function isContainerKey(name) {
  return (
    CONTAINER_ATTRS.has(name) ||
    name.startsWith('_') ||
    name.startsWith('&') ||
    name.startsWith(':') ||
    name.startsWith('@')
  )
}

function keyName(prop) {
  if (!prop || prop.type !== 'Property') return null
  if (prop.computed) return null
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal') return String(prop.key.value)
  return null
}

/** Normalise a value node to {value, node} if it is a static literal, else null. */
function literalOf(node) {
  if (!node) return null
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) {
    return { value: node.value, node }
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return { value: node.quasis[0].value.cooked, node }
  }
  if (
    node.type === 'UnaryExpression' &&
    node.operator === '-' &&
    node.argument.type === 'Literal' &&
    typeof node.argument.value === 'number'
  ) {
    return { value: -node.argument.value, node }
  }
  return null
}

/**
 * Walk `node` as the value of style prop `prop`, calling visit(prop, value, node)
 * for every static literal found. `isTarget(prop)` limits which props are reported.
 */
function walkValue(prop, node, isTarget, visit) {
  if (!node) return
  switch (node.type) {
    case 'JSXExpressionContainer':
      return walkValue(prop, node.expression, isTarget, visit)
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return walkValue(prop, node.expression, isTarget, visit)
    case 'ConditionalExpression':
      walkValue(prop, node.consequent, isTarget, visit)
      return walkValue(prop, node.alternate, isTarget, visit)
    case 'LogicalExpression':
      walkValue(prop, node.left, isTarget, visit)
      return walkValue(prop, node.right, isTarget, visit)
    case 'ArrayExpression':
      if (!isTarget(prop)) return
      for (const el of node.elements) walkValue(prop, el, isTarget, visit)
      return
    case 'ObjectExpression': {
      const container = isContainerKey(prop)
      for (const p of node.properties) {
        const k = keyName(p)
        if (k === null) continue
        if (container) walkValue(k, p.value, isTarget, visit)
        else if (BREAKPOINTS.has(k) && isTarget(prop)) walkValue(prop, p.value, isTarget, visit)
      }
      return
    }
    default: {
      if (!isTarget(prop)) return
      const lit = literalOf(node)
      if (lit) visit(prop, lit.value, lit.node)
    }
  }
}

/** Build a JSXAttribute visitor. */
function jsxStyleVisitor(isTarget, visit) {
  return {
    JSXAttribute(attr) {
      if (attr.name.type !== 'JSXIdentifier') return
      const name = attr.name.name
      if (!isTarget(name) && !isContainerKey(name)) return
      walkValue(name, attr.value, isTarget, visit)
    },
  }
}

module.exports = { jsxStyleVisitor, walkValue, literalOf, BREAKPOINTS }

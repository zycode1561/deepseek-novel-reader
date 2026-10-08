import { load } from 'cheerio'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { select } from 'xpath'
import { JSONPath } from 'jsonpath-plus'
import safeRegex from 'safe-regex2'

export interface ExpressionContext { host: string; keyword?: string; result?: unknown; lastResult?: unknown }
export class RuleExpressionError extends Error {
  constructor(public readonly field: string, message: string) { super(`${field}: ${message}`) }
}
export function valueText(value: unknown): string {
  return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function checkedRegex(pattern: string, flags: string): RegExp {
  const regex = new RegExp(pattern, flags)
  if (pattern.length > 16_384 || !safeRegex(regex)) throw new Error('正则表达式复杂度过高，请简化嵌套重复。')
  return regex
}

function splitAnalyzers(value: string): string[] {
  const parts: string[] = []
  let quote = '', depth = 0, start = 0
  for (let i = 0; i < value.length; i++) {
    const character = value[i]!
    if (character === '\\') { i++; continue }
    if (quote) { if (character === quote) quote = ''; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if ('[({'.includes(character)) depth++
    if ('])}'.includes(character)) depth--
    const marker = depth === 0 ? /^@(?:css|json|xpath|replace):/i.exec(value.slice(i)) : null
    if (marker) {
      if (i > start) parts.push(value.slice(start, i))
      start = i
      i += marker[0].length - 1
    }
  }
  parts.push(value.slice(start))
  return parts.filter(Boolean)
}

// Operators inside selectors, JSON filters, regular expressions and templates are literals.
function splitOutside(value: string, separator: string): string[] {
  const parts: string[] = []
  let quote = '', depth = 0, start = 0
  for (let i = 0; i < value.length; i++) {
    const character = value[i]!
    if (character === '\\') { i++; continue }
    if (quote) { if (character === quote) quote = ''; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if ('[({'.includes(character)) depth++
    if ('])}'.includes(character)) depth--
    if (depth === 0 && value.startsWith(separator, i)) {
      parts.push(value.slice(start, i)); i += separator.length - 1; start = i + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

export function textParagraphs(value: string): string[] {
  const $ = load(value, null, false)
  $('script, style, iframe, object').remove()
  $('br').replaceWith('\n')
  $('p, div, li, blockquote, h1, h2, h3, h4, h5, h6').append('\n')
  return $.root().text().replace(/\r/g, '').split('\n').map(line => line.replace(/\u00a0/g, ' ').trim()).filter(Boolean)
}

function variables(expression: string, context: ExpressionContext): string {
  return expression.replace(/\$(host|keyword|lastResult|result|pageSize|page)\b/g, (_, name: string) => {
    if (name === 'page') return '1'
    if (name === 'pageSize') return '20'
    return valueText(context[name as keyof ExpressionContext])
  })
}

export function evaluate(expression: string, input: unknown, context: ExpressionContext, field = 'rule', depth = 0): unknown[] {
  try {
    if (depth > 24) throw new Error('规则嵌套过深。')
    if (!expression.trim()) return []
    if (/@(?:js|hetu|web|webview|filter|http|encode|decode):/i.test(expression)) throw new Error('不支持脚本或浏览器规则。')
    const direct = /^(?:\$)?(result|lastResult|host|keyword)$/.exec(expression.trim())
    if (direct) return [context[direct[1] as keyof ExpressionContext]].filter(value => value !== undefined)
    if (expression.includes('{{')) {
      return [variables(expression.replace(/\{\{([\s\S]*?)\}\}/g, (_, rule: string) =>
        evaluate(rule, input, context, field, depth + 1).map(valueText).join('  ')), context)]
    }
    // Each analyzer's replacement runs before the next analyzer consumes its output.
    const chain = splitAnalyzers(expression)
    if (chain.length > 1) {
      let values = [input]
      for (const step of chain) values = values.flatMap(value => evaluate(step, value, context, field, depth + 1))
      return values
    }
    const replacement = splitOutside(expression, '##')
    if (replacement.length > 1) {
      const [base, pattern = '', substitute = '', first] = replacement
      const regex = checkedRegex(pattern, first ? '' : 'g')
      return evaluate(base!, input, context, field, depth + 1).map(value => valueText(value).replace(regex, substitute))
    }
    // Upstream combines branches first, with fallback resolved inside each branch.
    const merged = splitOutside(expression, '&&')
    if (merged.length > 1) return merged.flatMap(branch => evaluate(branch, input, context, field, depth + 1))
    const fallback = splitOutside(expression, '||')
    if (fallback.length > 1) {
      for (const branch of fallback) {
        const found = evaluate(branch, input, context, field, depth + 1).filter(value => valueText(value).trim() !== '')
        if (found.length) return found
      }
      return []
    }
    if (expression.startsWith('@replace:')) return [valueText(input).replace(checkedRegex(expression.slice(9), 'g'), '')]
    if (/^@json:|^\$(?:[.\[]|$)/i.test(expression)) {
      const path = expression.replace(/^@json:/i, '')
      if (/\?\s*\(|\[\s*\(/.test(path)) throw new Error('JSONPath 脚本表达式不受支持。')
      const json = typeof input === 'string' ? JSON.parse(input) : input
      const result = JSONPath({ path, json: json as object, eval: false, wrap: true }) as unknown[]
      // Upstream returns the single matched array as the list itself.
      return result.length === 1 && Array.isArray(result[0]) ? result[0] : result
    }
    if (/^https?:/i.test(expression)) return [variables(expression, context)]
    if (/^@xpath:|^\//i.test(expression)) {
      const html = load(valueText(input), null, false).xml()
      const document = new DOMParser().parseFromString(`<dnr-root>${html}</dnr-root>`, 'text/xml')
      const result = select(expression.replace(/^@xpath:/i, ''), document as unknown as Node)
      return (Array.isArray(result) ? result : [result]).map(value => {
        if (typeof value !== 'object' || value === null) return value
        const node = value as unknown as { nodeType: number; nodeValue: string | null }
        return node.nodeType === 2 || node.nodeType === 3 ? node.nodeValue ?? '' : new XMLSerializer().serializeToString(value as unknown as Parameters<XMLSerializer['serializeToString']>[0])
      })
    }
    const css = expression.replace(/^@css:/i, '')
    const match = /^(.*?)@([\w-]+)$/.exec(css)
    const selector = match ? match[1]! : css
    const mode = match?.[2]
    const $ = load(valueText(input), null, false)
    const nodes = selector.trim() ? $(selector) : $.root().children()
    return nodes.toArray().map(element => {
      const root = $(element)
      if (!mode || mode === 'outerHtml') return $.html(element)
      if (mode === 'text') return root.text().trim()
      if (mode === 'textNodes') return root.contents().toArray().map(node => $(node).text()).join('\n').trim()
      if (mode === 'innerHtml') return root.html() ?? ''
      if (mode === 'html') return textParagraphs($.html(element)).join('\n')
      return root.attr(mode) ?? ''
    })
  } catch (error) {
    if (error instanceof RuleExpressionError) throw error
    throw new RuleExpressionError(field, error instanceof Error ? error.message : String(error))
  }
}

export function extract(expression: string, input: unknown, context: ExpressionContext, field: string): string {
  return evaluate(expression, input, context, field).map(valueText).filter(Boolean).join('  ').trim()
}

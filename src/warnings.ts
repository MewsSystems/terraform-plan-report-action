export const MAX_WARNING_ADDRESSES = 10
export const MAX_WARNINGS_PER_STACK = 5
export const MAX_WARNING_SUMMARY_LENGTH = 200
export const MAX_ADDRESS_LENGTH = 300
export const MAX_COMMENT_WARNINGS_LENGTH = 6000

const WARNING_PREFIX = /^Warning:\s*/
const MAX_ADDRESS_LINE_LENGTH = MAX_ADDRESS_LENGTH + 100
const INDEX_KEY = String.raw`(?:\[[^\]\n<>\x60]*\])*`
const ADDRESS_SEGMENT = String.raw`[A-Za-z_][\w-]*${INDEX_KEY}`
const ADDRESS_ROOT = String.raw`(?:module|data|[A-Za-z][A-Za-z0-9]*_[\w-]*)${INDEX_KEY}`
const ADDRESS_LINE = new RegExp(
  String.raw`^\s*[-*]\s+(${ADDRESS_ROOT}(?:\.${ADDRESS_SEGMENT})+)\s*$`
)
const FILE_NAME = /\.(?:tf|tfvars|json|hcl|ya?ml|md|txt)$/i
const MORE_SIMILAR = /\(and (\d{1,6}|one) more similar warnings? elsewhere\)/
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g

export interface ParsedWarning {
  summary: string
  addresses: string[]
  moreSimilar?: number
}

export interface PayloadWarnings {
  warnings: ParsedWarning[]
  truncated: boolean
}

function codePointLength(text: string): number {
  return [...text].length
}

function clip(text: string, max: number): string {
  const points = [...text]
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text
}

export function parseWarning(text: string): ParsedWarning {
  const [firstLine = '', ...rest] = text.split('\n')
  const lines = rest.map((line) => line.replace(INVISIBLE_CHARS, ' '))
  const addresses = lines
    .map((line) =>
      line.length > MAX_ADDRESS_LINE_LENGTH
        ? undefined
        : ADDRESS_LINE.exec(line)?.[1]
    )
    .filter((a): a is string => a !== undefined && !FILE_NAME.test(a))
  const similar = lines
    .map((line) => MORE_SIMILAR.exec(line)?.[1])
    .find(Boolean)
  return {
    summary: firstLine
      .replace(WARNING_PREFIX, '')
      .replace(INVISIBLE_CHARS, ' ')
      .trim(),
    addresses,
    ...(similar !== undefined && {
      moreSimilar: similar === 'one' ? 1 : Number(similar)
    })
  }
}

export function payloadWarnings(texts: string[]): PayloadWarnings {
  const parsed = texts.map(parseWarning)
  let truncated = parsed.length > MAX_WARNINGS_PER_STACK
  const warnings = parsed.slice(0, MAX_WARNINGS_PER_STACK).map((p) => {
    const summary = clip(p.summary, MAX_WARNING_SUMMARY_LENGTH)
    const fitting = p.addresses.filter(
      (a) => codePointLength(a) <= MAX_ADDRESS_LENGTH
    )
    const addresses = fitting.slice(0, MAX_WARNING_ADDRESSES)
    if (summary !== p.summary || addresses.length < p.addresses.length) {
      truncated = true
    }
    return {
      summary,
      addresses,
      ...(p.moreSimilar !== undefined && { moreSimilar: p.moreSimilar })
    }
  })
  return { warnings, truncated }
}

// GitHub links mentions even when the @ is backslash-escaped.
export function escapeMarkdown(text: string): string {
  return text.replace(ASCII_PUNCTUATION, (ch) =>
    ch === '@' ? '@\u200b' : `\\${ch}`
  )
}

export function inlineCode(text: string): string {
  const longestRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  )
  const fence = '`'.repeat(longestRun + 1)
  return `${fence} ${text} ${fence}`
}

function renderWarning(p: ParsedWarning, withAddresses: boolean): string[] {
  const summary = clip(p.summary, MAX_WARNING_SUMMARY_LENGTH) || 'Warning'
  const lines = [`- **${escapeMarkdown(summary)}**`]
  if (withAddresses) {
    for (const address of p.addresses.slice(0, MAX_WARNING_ADDRESSES)) {
      lines.push(`  - ${inlineCode(clip(address, MAX_ADDRESS_LENGTH))}`)
    }
    const more = p.addresses.length - MAX_WARNING_ADDRESSES
    if (more > 0) lines.push(`  - and ${more} more`)
  }
  if (p.moreSimilar !== undefined) {
    lines.push(`  - and ${p.moreSimilar} more similar elsewhere`)
  }
  return lines
}

export function renderStackWarnings(
  texts: string[],
  withAddresses = true
): string {
  const lines = texts
    .slice(0, MAX_WARNINGS_PER_STACK)
    .flatMap((text) => renderWarning(parseWarning(text), withAddresses))
  const more = texts.length - MAX_WARNINGS_PER_STACK
  if (more > 0)
    lines.push(`- and ${more} more ${more === 1 ? 'warning' : 'warnings'}`)
  return lines.join('\n')
}

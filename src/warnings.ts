export const MAX_WARNING_ADDRESSES = 10
export const MAX_WARNINGS_PER_STACK = 5
export const MAX_WARNING_SUMMARY_LENGTH = 200
export const MAX_ADDRESS_LENGTH = 300
export const MAX_COMMENT_WARNINGS_LENGTH = 6000

const WARNING_PREFIX = /^Warning:\s*/
const MAX_ADDRESS_LINE_LENGTH = MAX_ADDRESS_LENGTH + 100
const INDEX_KEY = String.raw`(?:\[(?:"(?:[^"\\\n<>\x60]|\\[^\n<>\x60])*"|\d+)\])*`
const ADDRESS_SEGMENT = String.raw`[A-Za-z_][\w-]*${INDEX_KEY}`
const ADDRESS_ROOT = String.raw`(?:module|data|[A-Za-z][A-Za-z0-9]*_[\w-]*)${INDEX_KEY}`
const ADDRESS_LINE = new RegExp(
  String.raw`^\s*[-*]\s+(${ADDRESS_ROOT}(?:\.${ADDRESS_SEGMENT})+)\s*$`
)
const ADDRESS_LIKE_BULLET =
  /^[-*]\s+(?:module|data|[A-Za-z][A-Za-z0-9]*_[\w-]*)[.[]/
const INVISIBLE_CHAR = /[\p{Cc}\p{Cf}\u2028\u2029]/u
const MORE_SIMILAR = /\(and (\d{1,6}|one) more similar warnings? elsewhere\)/
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g

export interface ParsedWarning {
  summary: string
  addresses: string[]
  omittedAddresses: number
  moreSimilar?: number
}

export interface PayloadWarning {
  summary: string
  addresses: string[]
  moreSimilar?: number
}

export interface PayloadWarnings {
  warnings: PayloadWarning[]
  truncated: boolean
}

function codePointLength(text: string): number {
  return [...text].length
}

function clip(text: string, max: number): string {
  const points = [...text]
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text
}

function parseAddressBullet(line: string): string | null | undefined {
  const bullet = line.trim()
  if (!ADDRESS_LIKE_BULLET.test(bullet.slice(0, MAX_ADDRESS_LINE_LENGTH))) {
    return undefined
  }
  if (bullet.length > MAX_ADDRESS_LINE_LENGTH || INVISIBLE_CHAR.test(bullet)) {
    return null
  }
  return ADDRESS_LINE.exec(bullet)?.[1] ?? null
}

export function parseWarning(text: string): ParsedWarning {
  const [firstLine = '', ...rest] = text.split('\n')
  const bullets = rest.map(parseAddressBullet)
  const similar = rest.map((line) => MORE_SIMILAR.exec(line)?.[1]).find(Boolean)
  return {
    summary: firstLine
      .replace(WARNING_PREFIX, '')
      .replace(INVISIBLE_CHARS, ' ')
      .trim(),
    addresses: bullets.filter((a): a is string => typeof a === 'string'),
    omittedAddresses: bullets.filter((a) => a === null).length,
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
    if (
      summary !== p.summary ||
      p.omittedAddresses > 0 ||
      addresses.length < p.addresses.length
    ) {
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
    const more =
      Math.max(0, p.addresses.length - MAX_WARNING_ADDRESSES) +
      p.omittedAddresses
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

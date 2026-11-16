import * as core from '@actions/core'
import type { StackResult } from './types.js'
import { payloadWarnings } from './warnings.js'

export const PAYLOAD_MARKER = 'tf-plan-report:data'
export const PAYLOAD_SCHEMA_VERSION = 1
export const MAX_LISTED_ADDRESSES = 100
export const MAX_PAYLOAD_LENGTH = 20000

interface PayloadDetail {
  includeLists: boolean
  includeWarnings: boolean
}

function stackPayload(
  result: StackResult,
  { includeLists, includeWarnings }: PayloadDetail
) {
  const overCap =
    result.replaced.length > MAX_LISTED_ADDRESSES ||
    result.destroyed.length > MAX_LISTED_ADDRESSES
  const droppedLists =
    !includeLists && (result.replaced.length > 0 || result.destroyed.length > 0)
  const truncated = overCap || droppedLists
  const cap = includeLists ? MAX_LISTED_ADDRESSES : 0
  const replaced = result.replaced.slice(0, cap)
  const destroyed = result.destroyed.slice(0, cap)
  const shown = includeWarnings
    ? payloadWarnings(result.warnings)
    : { warnings: [], truncated: result.warnings.length > 0 }
  return {
    stack: result.name,
    ...(result.failed && { failed: true }),
    counts: Object.fromEntries(
      Object.entries(result.counts ?? {}).filter(([, n]) => n > 0)
    ),
    ...(replaced.length > 0 && { replaced }),
    ...(destroyed.length > 0 && { destroyed }),
    ...(shown.warnings.length > 0 && { warnings: shown.warnings }),
    ...(truncated && { truncated }),
    ...(shown.truncated && { warningsTruncated: true })
  }
}

/**
 * Plan-derived text is PR-author controlled and could close the HTML comment
 * early, so `>` and `--` runs are written as unicode escapes.
 */
function serialize(data: object): string {
  const json = JSON.stringify({ schema: PAYLOAD_SCHEMA_VERSION, ...data })
    .replace(/>/g, '\\u003e')
    .replace(/-{2,}/g, (run) => '\\u002d'.repeat(run.length))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<!-- ${PAYLOAD_MARKER} ${json} -->`
}

const DETAIL_TIERS: PayloadDetail[] = [
  { includeLists: true, includeWarnings: true },
  { includeLists: true, includeWarnings: false },
  { includeLists: false, includeWarnings: false }
]

function serializeStacks(
  results: StackResult[],
  commit: string,
  detail: PayloadDetail
): string {
  return serialize({
    commit,
    stacks: results.map((r) => stackPayload(r, detail))
  })
}

export function renderPayload(results: StackResult[], commit: string): string {
  let smallest = ''
  for (const detail of DETAIL_TIERS) {
    smallest = serializeStacks(results, commit, detail)
    if (smallest.length <= MAX_PAYLOAD_LENGTH) return smallest
  }

  core.warning(
    `Machine-readable payload is ${smallest.length} chars, over the ${MAX_PAYLOAD_LENGTH} budget even without address lists; posting the omitted marker instead.`
  )
  return serialize({ commit, omitted: true })
}

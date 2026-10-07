import * as core from '@actions/core'
import type { PlanCounts, StackResult } from './types.js'

export const PAYLOAD_MARKER = 'tf-plan-report:data'
export const PAYLOAD_SCHEMA_VERSION = 1
export const MAX_LISTED_ADDRESSES = 100
export const MAX_PAYLOAD_LENGTH = 20000

const NO_COUNTS: PlanCounts = {
  add: 0,
  change: 0,
  destroy: 0,
  replace: 0,
  import: 0,
  forget: 0,
  move: 0
}

function stackPayload(result: StackResult, includeLists: boolean) {
  const overCap =
    result.replaced.length > MAX_LISTED_ADDRESSES ||
    result.destroyed.length > MAX_LISTED_ADDRESSES
  const truncated = overCap || !includeLists
  const cap = includeLists ? MAX_LISTED_ADDRESSES : 0
  return {
    stack: result.name,
    failed: result.failed,
    counts: result.counts ?? NO_COUNTS,
    replaced: result.replaced.slice(0, cap),
    destroyed: result.destroyed.slice(0, cap),
    ...(truncated && { truncated })
  }
}

/**
 * Resource addresses are PR-author controlled and could close the HTML comment
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

function serializeStacks(
  results: StackResult[],
  commit: string,
  includeLists: boolean
): string {
  return serialize({
    commit,
    stacks: results.map((r) => stackPayload(r, includeLists))
  })
}

export function renderPayload(results: StackResult[], commit: string): string {
  const full = serializeStacks(results, commit, true)
  if (full.length <= MAX_PAYLOAD_LENGTH) return full

  const compact = serializeStacks(results, commit, false)
  if (compact.length <= MAX_PAYLOAD_LENGTH) return compact

  core.warning(
    `Machine-readable payload is ${compact.length} chars, over the ${MAX_PAYLOAD_LENGTH} budget even without address lists; posting the omitted marker instead.`
  )
  return serialize({ commit, omitted: true })
}

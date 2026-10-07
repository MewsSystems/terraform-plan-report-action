import type { PlanCounts, StackResult } from './types.js'

export const PAYLOAD_MARKER = 'tf-plan-report:data'
export const PAYLOAD_SCHEMA_VERSION = 1
export const MAX_LISTED_ADDRESSES = 100

const NO_COUNTS: PlanCounts = {
  add: 0,
  change: 0,
  destroy: 0,
  replace: 0,
  import: 0,
  forget: 0,
  move: 0
}

function stackPayload(result: StackResult) {
  const truncated =
    result.replaced.length > MAX_LISTED_ADDRESSES ||
    result.destroyed.length > MAX_LISTED_ADDRESSES
  return {
    stack: result.name,
    failed: result.failed,
    counts: result.counts ?? NO_COUNTS,
    replaced: result.replaced.slice(0, MAX_LISTED_ADDRESSES),
    destroyed: result.destroyed.slice(0, MAX_LISTED_ADDRESSES),
    ...(truncated && { truncated })
  }
}

/**
 * A hidden HTML comment carrying the plan outcome as JSON, for automated
 * consumers of the sticky comment. `>` and `--` runs are written as unicode
 * escapes because resource addresses are PR-author controlled and could
 * otherwise close the HTML comment early; JSON.parse restores them.
 */
export function renderPayload(results: StackResult[], commit: string): string {
  const json = JSON.stringify({
    schema: PAYLOAD_SCHEMA_VERSION,
    commit,
    stacks: results.map(stackPayload)
  })
    .replace(/>/g, '\\u003e')
    .replace(/-{2,}/g, (run) => '\\u002d'.repeat(run.length))
  return `<!-- ${PAYLOAD_MARKER} ${json} -->`
}

import { readFile } from 'node:fs/promises'
import type { PlanCounts, StackInput, StackResult } from './types.js'

/**
 * Analyze one stack: read its plan text, derive exact counts from plan_json
 * when present, and extract Terraform diagnostics. Never throws; a missing
 * plan file or an error diagnostic is recorded as a failed stack.
 */
export async function analyzeStack(stack: StackInput): Promise<StackResult> {
  let planText = ''
  let failed = false
  let readError: string | undefined

  try {
    planText = await readFile(stack.plan_file, 'utf8')
  } catch {
    failed = true
    readError = `Plan file not found: ${stack.plan_file}`
  }

  // Diagnostics are pulled from the raw text (refresh lines never match), then
  // the text is cleaned for display so the Plan details block shows the diff,
  // not megabytes of state-refresh chatter.
  const { warnings, errors } = extractDiagnostics(planText)
  planText = cleanPlanText(planText)
  if (errors.length > 0) failed = true

  let counts: PlanCounts | null = null
  if (!failed) {
    try {
      counts = countsFromPlanJson(await readFile(stack.plan_json, 'utf8'))
    } catch {
      failed = true
      readError =
        readError ?? `Plan JSON not found or invalid: ${stack.plan_json}`
    }
  }

  return {
    name: stack.name,
    failed,
    counts,
    planText,
    warnings,
    errors,
    errorExcerpt: readError ?? errors[0]
  }
}

/**
 * Strip Terraform's state-refresh chatter from plan text. Every resource and
 * data source in state emits a "Refreshing state..." / "Reading..." / "Read
 * complete after ..." line on every plan — pure log noise with no diff signal
 * that, on a large stack, dwarfs the actual execution plan (often megabytes of
 * it) and blows the job summary's 1 MiB cap. Removing these lines keeps the
 * plan diff and the `Plan:` summary intact.
 *
 * Deterministic and safe: it only drops Terraform's own refresh log lines
 * (matched by the fixed phrases below), never the execution plan, drift notes,
 * or diagnostics. Counts and statuses come from plan_json, so nothing derived
 * is affected.
 *
 * The match is anchored to column 0 (refresh lines always start with the bare
 * resource address) so an indented diff line whose author-controlled value
 * mimics the chatter (e.g. a tag containing ": Refreshing state...") can never
 * be stripped from the displayed plan.
 */
export function cleanPlanText(text: string): string {
  const noise =
    /^\S.*: (?:Refreshing state\.\.\.|Still refreshing state\.\.\.|Reading\.\.\.|Still reading\.\.\.|Read complete after \d)/
  return text
    .split('\n')
    .filter((line) => !noise.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface ResourceChange {
  // importing is nested inside change, not at the resource_change top level.
  change?: { actions?: string[]; importing?: unknown }
  // Present when a moved block renamed this resource (TF 1.1+).
  previous_address?: string
}

interface PlanJson {
  resource_changes?: ResourceChange[]
}

/** Derive exact counts from `terraform show -json`. Uses Terraform's own action vocabulary. */
export function countsFromPlanJson(raw: string): PlanCounts {
  const json = JSON.parse(raw) as PlanJson
  const counts: PlanCounts = {
    add: 0,
    change: 0,
    destroy: 0,
    replace: 0,
    import: 0,
    forget: 0,
    move: 0
  }

  for (const rc of json.resource_changes ?? []) {
    const actions = rc.change?.actions ?? []
    const has = (a: string): boolean => actions.includes(a)

    if (rc.change?.importing != null) {
      // TF 1.5+: importing is inside change{}. Real plans use no-op (exact match) or update (diff).
      counts.import++
    } else if (rc.previous_address != null) {
      // TF 1.1+: moved block — previous_address in resource_changes, not a top-level array.
      counts.move++
    } else if (has('create') && has('delete')) {
      counts.replace++
    } else if (actions.length === 1 && has('forget')) {
      // TF 1.7+: removed block with lifecycle { destroy = false }
      counts.forget++
    } else if (actions.length === 1 && has('create')) {
      counts.add++
    } else if (actions.length === 1 && has('update')) {
      counts.change++
    } else if (actions.length === 1 && has('delete')) {
      counts.destroy++
    }
    // no-op and read are not surfaced.
  }

  return counts
}

/**
 * Pull Terraform diagnostics out of plan text.
 *
 * Two formats exist:
 *  1. Standard: framed with ╷…╵, every content line prefixed by │.
 *  2. Check-block assertions (TF 1.5+): bare Warning:/Error: at the start of a
 *     line, no ╷…╵ wrapper. Uses ├─ / │ box-drawing inside the source snippet
 *     but the outer framing characters are absent.
 */
export function extractDiagnostics(text: string): {
  warnings: string[]
  errors: string[]
} {
  const warnings: string[] = []
  const errors: string[] = []

  // Format 1: standard framed diagnostics (╷…╵)
  const framedRe = /╷([\s\S]*?)╵/g
  let match: RegExpExecArray | null
  while ((match = framedRe.exec(text)) !== null) {
    const body = match[1]
      .split('\n')
      .map((line) => line.replace(/^│ ?/, ''))
      .join('\n')
      .trim()
    if (/^Warning:/.test(body)) warnings.push(body)
    else if (/^Error:/.test(body)) errors.push(body)
  }

  // Format 2: unframed check-block diagnostics.
  // Strip framed blocks first so │ Warning: lines inside them don't match.
  const stripped = text.replace(/╷[\s\S]*?╵/g, '')
  const unframedRe = /^((?:Warning|Error):.*(?:\n(?!(?:Warning|Error):).*)*)/gm
  while ((match = unframedRe.exec(stripped)) !== null) {
    const body = match[1].trim()
    if (!body) continue
    if (/^Warning:/.test(body)) warnings.push(body)
    else if (/^Error:/.test(body)) errors.push(body)
  }

  return { warnings, errors }
}

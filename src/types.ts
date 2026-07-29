/** Shared types for the Terraform plan report. */

/** One stack as declared in the `stacks` input. */
export interface StackInput {
  name: string
  plan_file: string
  plan_json: string
}

/**
 * The mandatory meta.json every plan artifact carries. `stack` is the sole
 * source of the stack's display name — never inferred from the directory or
 * artifact name. Extend additively (e.g. `order`, `priority`) as needed.
 */
export interface PlanMeta {
  stack: string
}

/** Section status, shown as an icon: `pass` ✅, `warn` ⚠️, `fail` ❌. */
export type SectionStatus = 'pass' | 'warn' | 'fail'

/** Lowest status that fires the "needs attention" callout for a section. */
export type SectionEscalation = 'warn' | 'fail'

/**
 * What each icon means for a section, in plain English, keyed by status. A
 * structured map (not a display string) so the renderer indexes it directly —
 * no parsing, no silent fallback. A section must define at least the status it
 * reports; define the whole scale so the meaning reads well everywhere.
 */
export interface SectionLegend {
  pass?: string
  warn?: string
  fail?: string
}

/**
 * A custom "add-on" section, self-describing JSON dropped by an upstream job
 * (tags, policy, cost, drift). The action groups, orders, and renders these
 * without understanding their content — which is why they carry their own
 * metadata. `markdown` is rendered verbatim.
 */
export interface Section {
  /** Machine id; files sharing a `section` become one Checks column. */
  section: string
  /** Human heading (Checks column header + detail heading). */
  title: string
  /** Sort position among sections (lower first). */
  order: number
  /** Join key — must match a stack's meta.json `stack`. */
  stack: string
  /** `pass` ✅ | `warn` ⚠️ | `fail` ❌. Defaults to `pass`. */
  status: SectionStatus
  /**
   * Lowest status that escalates to the callout. `warn` (default) escalates on
   * warn+fail; `fail` escalates only on fail (a warn shows in the table but
   * doesn't nag). A section-type policy: e.g. cost uses `fail`, AI review `warn`.
   */
  escalate: SectionEscalation
  /** Free-form cell text ("$340/mo", "12/12"). Rendered only in the detail. */
  label?: string
  /**
   * Mandatory per-status meaning for THIS section's icons (e.g. AI review:
   * `{pass:"high", warn:"medium", fail:"low merge confidence"}`). Required
   * because the icon only conveys severity; the producer owns what a status
   * means. Must include an entry for the status this section reports.
   */
  legend: SectionLegend
  /** Promote to a per-stack Checks column. Defaults to true. */
  table_column: boolean
  /** Full detail, rendered verbatim in the job summary. */
  markdown: string
}

/** Plan-derived resource counts for a single stack. */
export interface PlanCounts {
  add: number
  change: number
  destroy: number
  replace: number
  /** Resources imported into state (TF 1.5+ import blocks). */
  import: number
  /** Resources removed from state without destroying (TF 1.7+ removed { lifecycle { destroy = false } }). */
  forget: number
  /** Resources whose address changed via a moved block (TF 1.1+). */
  move: number
}

/** Everything the renderer needs about one stack. */
export interface StackResult {
  name: string
  /** True when the plan failed (file missing or an error diagnostic present). */
  failed: boolean
  /** Exact counts from plan_json, or null when the stack failed to plan. */
  counts: PlanCounts | null
  /** Raw `terraform show -no-color` text, for the per-stack plan block. */
  planText: string
  /** Cleaned Terraform warning diagnostics. */
  warnings: string[]
  /** Cleaned Terraform error diagnostics. */
  errors: string[]
  /** First error or read failure, surfaced in the row and callouts. */
  errorExcerpt?: string
}

/** Totals rolled up across all stacks. */
export interface Aggregate {
  total: number
  planned: number
  failed: number
  warnings: number
  stacksWithWarnings: number
  totals: PlanCounts
  hasDestroys: boolean
  hasReplaces: boolean
}

/** Run-level context woven into the report header and footer. */
export interface ReportContext {
  /** Repository name, used as the report title. */
  title: string
  /** Short commit SHA the report reflects. */
  sha: string
  /** URL to the commit on GitHub. */
  commitUrl: string
  /** Link to the run (where the job summary lives). */
  runUrl: string
  /** Link to the action README's "Reading the report" section. */
  docsUrl: string
}

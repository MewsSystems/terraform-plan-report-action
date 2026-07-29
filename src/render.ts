import type { NativeSection } from './inputs.js'
import type {
  Aggregate,
  PlanCounts,
  ReportContext,
  Section,
  SectionEscalation,
  SectionLegend,
  SectionStatus,
  StackResult
} from './types.js'

/** Roll totals up across all stacks. */
export function aggregate(results: StackResult[]): Aggregate {
  const totals: PlanCounts = {
    add: 0,
    change: 0,
    destroy: 0,
    replace: 0,
    import: 0,
    forget: 0,
    move: 0
  }
  let warnings = 0
  let stacksWithWarnings = 0
  let failed = 0

  for (const r of results) {
    if (r.counts) {
      totals.add += r.counts.add
      totals.change += r.counts.change
      totals.destroy += r.counts.destroy
      totals.replace += r.counts.replace
      totals.import += r.counts.import
      totals.forget += r.counts.forget
      totals.move += r.counts.move
    }
    if (r.failed) failed++
    if (r.warnings.length > 0) {
      warnings += r.warnings.length
      stacksWithWarnings++
    }
  }

  return {
    total: results.length,
    planned: results.length - failed,
    failed,
    warnings,
    stacksWithWarnings,
    totals,
    hasDestroys: totals.destroy > 0,
    hasReplaces: totals.replace > 0
  }
}

/**
 * Explains the ✅/⚠️/❌ in the comment's Status column — but only the icons
 * that actually appear there. Presence is derived from the same statusLabel
 * that renders the cells, so the legend can never drift from the table.
 * Returns '' when the column shows no status icon at all (e.g. every stack
 * has plain change counts), so the caller omits the line.
 */
function operationsLegend(results: StackResult[]): string {
  const cells = results.map((r) => statusLabel(r))
  const entries: string[] = []
  if (cells.some((c) => c.includes('✅'))) entries.push('✅ planned OK')
  if (cells.some((c) => c.includes('⚠️'))) entries.push('⚠️ has warnings')
  if (cells.some((c) => c.includes('❌'))) entries.push('❌ plan failed')
  if (entries.length === 0) return ''
  return `**What the plan result means:** ${entries.join(' · ')}`
}

/** The full report: written verbatim to the run's job summary. */
export function renderFullReport(
  results: StackResult[],
  show: NativeSection[],
  ctx: ReportContext,
  sections: Section[] = []
): string {
  const agg = aggregate(results)
  // H1 title; the two groups below are H2, their subsections H3 — a clear
  // three-level hierarchy so readers see the Terraform-native vs Checks split.
  const out: string[] = [`# Terraform Plan · ${ctx.title}`]

  if (show.includes('summary')) out.push('', healthLine(agg))

  // ---- Group 1: Terraform operations (everything the action derives) ----
  const withErrors = show.includes('errors')
    ? results.filter((r) => r.errors.length > 0 || r.failed)
    : []
  const withWarnings = show.includes('warnings')
    ? results.filter((r) => r.warnings.length > 0)
    : []
  const showOps = show.includes('summary')
  const showPlan = show.includes('plan')

  if (showOps || withErrors.length > 0 || withWarnings.length > 0 || showPlan) {
    out.push('', '## Terraform operations')

    if (showOps) {
      out.push('', operationsTable(results))
      const c = callouts(agg)
      if (c) out.push('', c)
    }

    if (withErrors.length > 0) {
      out.push('', '### Errors')
      for (const r of withErrors) {
        const body = r.errors.length
          ? r.errors.join('\n\n')
          : (r.errorExcerpt ?? 'Plan failed.')
        out.push('', detailsBlock(escapeHtml(r.name), body))
      }
    }

    if (withWarnings.length > 0) {
      out.push(
        '',
        `### Warnings (${agg.warnings} across ${agg.stacksWithWarnings} ${plural(agg.stacksWithWarnings, 'stack')})`
      )
      for (const r of withWarnings) {
        const summary = `${escapeHtml(r.name)} · ${r.warnings.length} ${plural(r.warnings.length, 'warning')}`
        out.push('', detailsBlock(summary, r.warnings.join('\n\n')))
      }
    }

    if (showPlan) {
      out.push('', '### Plan details')
      for (const r of results) {
        const body = r.failed
          ? (r.errorExcerpt ?? 'Plan failed.')
          : r.planText.trim() || 'No plan output.'
        const summary = `${escapeHtml(r.name)} · ${statusLabel(r, true)}`
        out.push('', detailsBlock(summary, body))
      }
    }
  }

  // ---- Group 2: Checks (custom sections) ----
  const checks = checksTable(results, sections)
  const detail = sectionsDetail(sections)
  if (checks || detail) {
    out.push('', '---', '', '## Checks')
    // No glossary list here — each stack's detail row spells out its own meaning
    // from the legend (e.g. "❌ missing or invalid tags"), so the list would be
    // redundant. The comment keeps the list because it has no detail rows.
    if (checks) out.push('', checks)
    const sc = sectionCallout(sections)
    if (sc) out.push('', sc)
    if (detail) out.push('', detail)
  }

  out.push('', '---', '', footerLine(ctx, agg, true))
  return out.join('\n')
}

/** The compact view: posted as the sticky PR comment, links to the full report. */
export function renderComment(
  results: StackResult[],
  ctx: ReportContext,
  summaryUrl: string,
  sections: Section[] = []
): string {
  const agg = aggregate(results)
  const out: string[] = [
    `## Terraform Plan · ${ctx.title}`,
    '',
    healthLine(agg)
  ]
  // The comment keeps the per-stack rollup (Status column); the full report's
  // operations table shows just a plan-health icon instead, to avoid repetition.
  out.push(
    '',
    '### Terraform operations',
    '',
    operationsTable(results, 'rollup')
  )
  const opsLegend = operationsLegend(results)
  if (opsLegend) out.push('', opsLegend)
  const checks = checksTable(results, sections)
  if (checks) {
    // The comment has no per-section detail, so the glossary rides under the
    // table here (in the summary it sits under each section's heading instead).
    out.push('', '### Checks', '', checks)
    const legendList = sectionLegendList(sections, results)
    if (legendList) out.push('', legendList)
  }
  const c = callouts(agg)
  if (c) out.push('', c)
  // In the comment the section detail lives in the summary, so link there.
  const sc = sectionCallout(sections, summaryUrl)
  if (sc) out.push('', sc)

  // The "open the full report" pointer rides in the footer, not a third alert
  // box — CAUTION and IMPORTANT are the ones that need the visual weight.
  out.push('', footerLine(ctx, agg, true, summaryUrl))
  return out.join('\n')
}

/**
 * Minimal replacement body used when the compact view would blow GitHub's
 * 64 KiB comment cap. Keeps the header, the health line (so reviewers still see
 * pass/warn/fail at a glance) and any destructive-change callout, then sends
 * readers to the job summary for the per-stack detail.
 */
export function renderCommentFallback(
  results: StackResult[],
  ctx: ReportContext,
  summaryUrl: string
): string {
  const agg = aggregate(results)
  const out: string[] = [
    `## Terraform Plan · ${ctx.title}`,
    '',
    healthLine(agg),
    '',
    '> [!IMPORTANT]',
    '> This report is too large to render as a PR comment (GitHub caps comments at 64 KiB). Open the full report below for the per-stack detail.'
  ]
  const c = callouts(agg)
  if (c) out.push('', c)
  out.push('', footerLine(ctx, agg, true, summaryUrl))
  return out.join('\n')
}

/**
 * GitHub's hard cap on a job summary, in bytes. The runner silently ABORTS a
 * summary over this size — nothing renders at all — so we must never write one
 * larger than this (measured in bytes, which is what the runner caps).
 */
export const MAX_SUMMARY_BYTES = 1024 * 1024

/**
 * Last-resort job-summary body, used only when the full report — even after the
 * plan text is stripped of refresh noise — still exceeds the 1 MiB cap. Keeps
 * the header, health line and any destructive-change callout, then points
 * readers at the run's plan-step logs and artifacts for the per-stack detail.
 */
export function renderSummaryFallback(
  results: StackResult[],
  ctx: ReportContext
): string {
  const agg = aggregate(results)
  const out: string[] = [
    `# Terraform Plan · ${ctx.title}`,
    '',
    healthLine(agg),
    '',
    '> [!IMPORTANT]',
    `> This report is too large to render as a job summary (GitHub caps job summaries at 1 MiB). Open the [workflow run](${ctx.runUrl}) and check each stack's plan step logs and artifacts for the full plan.`
  ]
  const c = callouts(agg)
  if (c) out.push('', c)
  out.push('', '---', '', footerLine(ctx, agg, true))
  return out.join('\n')
}

/** One labelled job-summary candidate, richest first. */
export interface SummaryCandidate {
  label: string
  body: string
}

/**
 * Pick the first summary candidate that fits under the byte cap, trying them
 * richest → poorest (full → plan details dropped → minimal). The last candidate
 * is the guaranteed-tiny fallback and is returned unconditionally if nothing
 * richer fits, so we never write an oversized summary (the runner would abort
 * it silently). Pure and byte-measured, so the shipped decision is exactly what
 * a test can exercise. Returns the chosen body, its label, and whether a richer
 * tier was skipped (i.e. the report was trimmed).
 */
export function chooseSummaryBody(
  candidates: SummaryCandidate[],
  maxBytes: number = MAX_SUMMARY_BYTES
): { body: string; label: string; truncated: boolean } {
  for (let i = 0; i < candidates.length - 1; i++) {
    if (Buffer.byteLength(candidates[i].body, 'utf8') <= maxBytes)
      return { ...candidates[i], truncated: i > 0 }
  }
  const last = candidates[candidates.length - 1]
  return { ...last, truncated: candidates.length > 1 }
}

/** Line 1: did it succeed? Any failures/warnings to act on? */
function healthLine(agg: Aggregate): string {
  let s = `${agg.total} ${plural(agg.total, 'stack')} · **${agg.planned}/${agg.total} planned OK**`
  if (agg.warnings > 0) {
    s += ` · ⚠️ ${agg.warnings} ${plural(agg.warnings, 'warning')} (${agg.stacksWithWarnings} ${plural(agg.stacksWithWarnings, 'stack')})`
  }
  if (agg.failed > 0) s += ` · ❌ ${agg.failed} failed`
  return s
}

/**
 * The Terraform operations matrix. Only columns with a non-zero value across
 * all stacks are shown. Last column is either a plan-health icon (`health`,
 * used in the job summary where the counts are already visible) or the verbose
 * per-stack rollup (`rollup`, used in the comment where there are no columns).
 */
function operationsTable(
  results: StackResult[],
  statusMode: 'health' | 'rollup' = 'health'
): string {
  type Col = keyof PlanCounts
  const allCols: Col[] = [
    'add',
    'change',
    'destroy',
    'replace',
    'import',
    'forget',
    'move'
  ]
  const labels: Record<Col, string> = {
    add: 'add',
    change: 'change',
    destroy: 'destroy',
    replace: 'replace',
    import: 'import',
    forget: 'remove',
    move: 'move'
  }

  const activeCols = allCols.filter((col) =>
    results.some((r) => r.counts && r.counts[col] > 0)
  )

  const lastHeader = statusMode === 'health' ? 'Plan' : 'Status'
  const midCols =
    activeCols.length > 0
      ? ` ${activeCols.map((c) => labels[c]).join(' | ')} |`
      : ''
  const midSep =
    activeCols.length > 0 ? ` ${activeCols.map(() => '---').join(' | ')} |` : ''
  const header = `| Stack |${midCols} ${lastHeader} |`
  const separator = `| --- |${midSep} --- |`
  const rows = results.map((r) => {
    const midCells =
      activeCols.length > 0
        ? ` ${activeCols.map((c) => cell(r, c)).join(' | ')} |`
        : ''
    const status = statusMode === 'health' ? healthCell(r) : statusLabel(r)
    return `| ${escapeHtml(r.name)} |${midCells} ${status} |`
  })
  return [header, separator, ...rows].join('\n')
}

/**
 * The Checks matrix: one column per custom section flagged `table_column`,
 * one row per stack, cell = the section's status icon + label. Returns empty
 * string when no section opts into a column.
 */
function checksTable(results: StackResult[], sections: Section[]): string {
  const columns = sectionColumns(sections)
  if (columns.length === 0) return ''

  // Index section files by (section id, stack) for O(1) cell lookup.
  const byKey = new Map<string, Section>()
  for (const s of sections) byKey.set(`${s.section} ${s.stack}`, s)

  const header = `| Stack | ${columns.map((c) => escapeHtml(c.title)).join(' | ')} |`
  const separator = `| --- | ${columns.map(() => '---').join(' | ')} |`
  const rows = results.map((r) => {
    const cells = columns.map((c) => {
      const s = byKey.get(`${c.section} ${r.name}`)
      return s ? checkCell(s) : '—'
    })
    return `| ${escapeHtml(r.name)} | ${cells.join(' | ')} |`
  })
  return [header, separator, ...rows].join('\n')
}

/** Distinct section ids that want a column, ordered by `order`. */
function sectionColumns(
  sections: Section[]
): { section: string; title: string }[] {
  const seen = new Map<
    string,
    { section: string; title: string; order: number }
  >()
  for (const s of sections) {
    if (!s.table_column) continue
    const existing = seen.get(s.section)
    if (!existing || s.order < existing.order) {
      seen.set(s.section, {
        section: s.section,
        title: s.title,
        order: s.order
      })
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ section, title }) => ({ section, title }))
}

// Icon only — the Checks table is an at-a-glance grid; the label/value (cost,
// confidence, findings) lives in the per-section detail block below.
function checkCell(s: Section): string {
  return statusIcon(s.status)
}

function cell(r: StackResult, key: keyof PlanCounts): string {
  if (r.failed) return '—'
  // counts is non-null for non-failed stacks (plan_json is required)
  const v = r.counts![key]
  // Bold non-zero destroy/replace counts — these are the ones that warrant a second look.
  if (v > 0 && (key === 'destroy' || key === 'replace')) return `**${v}**`
  return String(v)
}

/**
 * Compact plan-health icon for the job summary's operations table. Icon only
 * (plus the warning count) — the legend under the table already spells out
 * what ✅/⚠️/❌ mean, so repeating "Plan failed"/"warnings" is redundant.
 */
function healthCell(r: StackResult): string {
  if (r.failed) return '❌'
  if (r.warnings.length > 0) return `⚠️ ${r.warnings.length}`
  return '✅'
}

/**
 * Status label for a stack.
 * plain=true: used inside <details><summary> where markdown is not rendered.
 * plain=false (default): used in table cells where markdown renders normally.
 */
function statusLabel(r: StackResult, plain = false): string {
  // `plain` = used in a <details> summary (plan-details), where there's no
  // legend nearby, so it spells the result out in plain English. Non-plain =
  // the comment's operations table, which sits above the legend line, so it
  // stays icon-only for the pure-status cases (the words would just repeat it).
  if (r.failed) return plain ? '❌ plan failed' : '❌'
  // counts is non-null for non-failed stacks (plan_json is required)
  const c = r.counts!
  const hasChanges =
    c.add + c.change + c.destroy + c.replace + c.import + c.forget + c.move > 0
  if (!hasChanges) {
    if (r.warnings.length === 0) return '✅ no changes'
    return plain
      ? `⚠️ ${r.warnings.length} ${plural(r.warnings.length, 'warning')}`
      : `⚠️ ${r.warnings.length}`
  }

  const parts: string[] = []
  if (c.add) parts.push(plain ? `${c.add} add` : `\`${c.add} add\``)
  if (c.change)
    parts.push(plain ? `${c.change} change` : `\`${c.change} change\``)
  if (c.destroy)
    parts.push(plain ? `${c.destroy} destroy` : `**\`${c.destroy} destroy\`**`)
  if (c.replace)
    parts.push(
      plain
        ? `${c.replace} replace (destroy+create)`
        : `**\`${c.replace} replace (destroy+create)\`**`
    )
  if (c.import)
    parts.push(plain ? `${c.import} import` : `\`${c.import} import\``)
  if (c.forget)
    parts.push(plain ? `${c.forget} remove` : `\`${c.forget} remove\``)
  if (c.move) parts.push(plain ? `${c.move} move` : `\`${c.move} move\``)
  let label = parts.join(' · ')
  if (r.warnings.length > 0) label += ` ⚠️ ${r.warnings.length}`
  return label
}

/**
 * Returns a GitHub-flavoured alert block for destructive changes, or empty string.
 * Failures are already visible in the summary line; the callout is purely for
 * destroy/replace so reviewers can't miss them.
 */
function callouts(agg: Aggregate): string {
  if (!agg.hasDestroys && !agg.hasReplaces) return ''
  const parts: string[] = []
  if (agg.totals.destroy > 0)
    parts.push(`**\`${agg.totals.destroy} destroy\`**`)
  if (agg.totals.replace > 0)
    parts.push(`**\`${agg.totals.replace} replace (destroy+create)\`**`)
  return `> [!CAUTION]\n> ${parts.join(' · ')} — these operations permanently delete resources`
}

/**
 * Alerts the reviewer when any section warns or fails, linking each flagged
 * section to its detail block. `baseUrl` is '' for the job summary (same-page
 * anchor) and the summary URL for the comment (the detail lives there).
 */
function sectionCallout(sections: Section[], baseUrl = ''): string {
  // A section escalates when its worst status meets its own threshold: `warn`
  // escalates on warn+fail, `fail` only on fail.
  const flagged = groupSections(sections).filter(
    (g) => STATUS_RANK[worstStatus(g.items)] >= STATUS_RANK[g.escalate]
  )
  if (flagged.length === 0) return ''
  const names = flagged
    .map(
      (g) =>
        `${statusIcon(worstStatus(g.items))} [${escapeHtml(g.title)}](${baseUrl}#${slug(g.title)})`
    )
    .join(' · ')
  return `> [!IMPORTANT]\n> Checks need attention: ${names}. Open the linked section for detail.`
}

/** GitHub heading anchor slug: lowercase, drop punctuation, spaces to hyphens. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/**
 * One glossary line per section, for the comment (which has no detail sections
 * to carry each section's `legend`). Each line spells out what that check's
 * icons mean, so the icon-only Checks table is never unexplained — and lists
 * only the statuses that actually appear in that check's column, so an
 * all-green table isn't followed by explanations of icons nobody can see.
 */
function sectionLegendList(
  sections: Section[],
  results: StackResult[]
): string {
  // Only sections that own a Checks column — a legend for a section with no
  // column would explain an icon the reader can't see here.
  const cols = new Set(sectionColumns(sections).map((c) => c.section))
  const groups = groupSections(sections).filter((g) => cols.has(g.section))
  if (groups.length === 0) return ''
  // A section item only renders a cell when its stack joins a result row.
  const stacks = new Set(results.map((r) => r.name))
  const lines: string[] = []
  for (const g of groups) {
    const present = new Set(
      g.items.filter((s) => stacks.has(s.stack)).map((s) => s.status)
    )
    const display = legendDisplay(g.legend, present)
    if (display)
      lines.push(`- **${escapeHtml(g.title)}** icons mean: ${display}`)
  }
  if (lines.length === 0) return ''
  return ['**What each check means**', ...lines].join('\n')
}

/** Full per-section detail for the job summary: heading + per-stack blocks. */
function sectionsDetail(sections: Section[]): string {
  const groups = groupSections(sections)
  if (groups.length === 0) return ''
  const out: string[] = []
  for (const g of groups) {
    // Blank line before each heading — without it a heading glued to the
    // previous group's closing </details> renders as literal "### Title".
    out.push('', `### ${escapeHtml(g.title)}`)
    for (const s of g.items) {
      // Show the icon's plain-English meaning for this stack (from the legend),
      // e.g. "❌ missing or invalid tags" — not the bare status word.
      const meaning = legendPhrase(s.legend, s.status)
      const summary = `${escapeHtml(s.stack)} · ${statusIcon(s.status)} ${escapeHtml(meaning)}`
      out.push('', markdownDetails(summary, s.markdown))
    }
  }
  return out.join('\n').trim()
}

interface SectionGroup {
  section: string
  title: string
  order: number
  escalate: SectionEscalation
  legend: SectionLegend
  items: Section[]
}

/** Group section files by id, ordered by `order`; items sorted by stack. */
function groupSections(sections: Section[]): SectionGroup[] {
  const groups = new Map<string, SectionGroup>()
  for (const s of sections) {
    const g = groups.get(s.section)
    if (g) {
      g.items.push(s)
      if (s.order < g.order) g.order = s.order
    } else {
      groups.set(s.section, {
        section: s.section,
        title: s.title,
        order: s.order,
        escalate: s.escalate,
        legend: s.legend,
        items: [s]
      })
    }
  }
  const list = [...groups.values()].sort((a, b) => a.order - b.order)
  for (const g of list) g.items.sort((a, b) => a.stack.localeCompare(b.stack))
  return list
}

const STATUS_RANK: Record<SectionStatus, number> = {
  fail: 2,
  warn: 1,
  pass: 0
}

function worstStatus(items: Section[]): SectionStatus {
  return items.reduce<SectionStatus>(
    (worst, s) =>
      STATUS_RANK[s.status] > STATUS_RANK[worst] ? s.status : worst,
    'pass'
  )
}

function statusIcon(s: SectionStatus): string {
  return s === 'fail' ? '❌' : s === 'warn' ? '⚠️' : '✅'
}

function statusText(s: SectionStatus): string {
  return s
}

/**
 * The plain-English phrase for a status, straight from the section's legend
 * map. This is what lets a detail row say "❌ missing or invalid tags" instead
 * of the bare status word "fail". Parsing guarantees an entry for the reported
 * status, so this is defined in practice; statusText is a defensive fallback.
 */
function legendPhrase(legend: SectionLegend, s: SectionStatus): string {
  return legend[s] ?? statusText(s)
}

/**
 * Render a legend map as "✅ phrase · ⚠️ phrase · ❌ phrase", limited to the
 * statuses actually present in the check's column. legendPhrase falls back to
 * the bare status word, so a visible icon is never left unexplained even when
 * the group's legend map lacks its entry.
 */
function legendDisplay(
  legend: SectionLegend,
  present: Set<SectionStatus>
): string {
  return (['pass', 'warn', 'fail'] as SectionStatus[])
    .filter((s) => present.has(s))
    .map((s) => `${statusIcon(s)} ${legendPhrase(legend, s)}`)
    .join(' · ')
}

function footerLine(
  ctx: ReportContext,
  agg: Aggregate,
  includeGuide: boolean,
  summaryUrl?: string
): string {
  const parts: string[] = []
  // Comment only: the "read the full plan before approving" pointer, folded in
  // here rather than living in its own alert box.
  if (summaryUrl) parts.push(`**[Full report →](${summaryUrl})**`)
  parts.push(`updated for commit [\`${ctx.sha}\`](${ctx.commitUrl})`)
  if (includeGuide) parts.push(`[usage docs](${ctx.docsUrl})`)
  return `_${parts.join(' · ')}_`
}

/** <details> with a fenced code body — for raw plan text and diagnostics. */
function detailsBlock(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>`
}

/** <details> with a markdown body — for custom sections (rendered verbatim). */
function markdownDetails(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

import {
  MAX_SUMMARY_BYTES,
  aggregate,
  chooseSummaryBody,
  renderComment,
  renderCommentFallback,
  renderFullReport,
  renderSummaryFallback
} from '../src/render.js'
import type { ReportContext, Section, StackResult } from '../src/types.js'

const ctx: ReportContext = {
  title: 'tf-domain-foundations',
  sha: 'fe9f7f8',
  commitUrl:
    'https://github.com/MewsSystems/tf-domain-foundations/commit/fe9f7f8abc123',
  runUrl:
    'https://github.com/MewsSystems/tf-domain-foundations/actions/runs/42',
  docsUrl:
    'https://github.com/MewsSystems/terraform-plan-report-action#reading-the-report'
}

const zeroCounts = {
  add: 0,
  change: 0,
  destroy: 0,
  replace: 0,
  import: 0,
  forget: 0,
  move: 0
}

function stack(over: Partial<StackResult>): StackResult {
  return {
    name: 'stack',
    failed: false,
    counts: { ...zeroCounts },
    planText: 'No changes.',
    warnings: [],
    errors: [],
    ...over
  }
}

describe('aggregate', () => {
  it('sums counts and flags destroys/replaces and failures', () => {
    const agg = aggregate([
      stack({ counts: { ...zeroCounts, add: 2, destroy: 1 } }),
      stack({ counts: { ...zeroCounts, replace: 3 } }),
      stack({ failed: true, counts: null }),
      stack({ warnings: ['Warning: x'] })
    ])
    expect(agg.total).toBe(4)
    expect(agg.failed).toBe(1)
    expect(agg.planned).toBe(3)
    expect(agg.totals).toEqual({
      ...zeroCounts,
      add: 2,
      destroy: 1,
      replace: 3
    })
    expect(agg.hasDestroys).toBe(true)
    expect(agg.hasReplaces).toBe(true)
    expect(agg.warnings).toBe(1)
    expect(agg.stacksWithWarnings).toBe(1)
  })
})

describe('renderFullReport', () => {
  const results = [
    stack({ name: 'distribution (dev)' }),
    stack({
      name: 'fintech (dev)',
      warnings: ['Warning: Argument is deprecated']
    }),
    stack({
      name: 'core (prod)',
      counts: { ...zeroCounts, add: 1, replace: 1 },
      planText: 'Plan: 1 to add, 0 to change, 1 to replace.'
    }),
    stack({
      name: 'broken (dev)',
      failed: true,
      counts: null,
      errors: ['Error: boom'],
      errorExcerpt: 'Error: boom'
    })
  ]

  it('matches the snapshot for all native sections', () => {
    const report = renderFullReport(
      results,
      ['summary', 'plan', 'warnings', 'errors'],
      ctx
    )
    expect(report).toMatchSnapshot()
  })

  it('honours the show filter (summary only)', () => {
    const report = renderFullReport(results, ['summary'], ctx)
    expect(report).toContain('| Stack | add |')
    expect(report).not.toContain('### 📋 Plan details')
    expect(report).not.toContain('### ⚠️ Warnings')
  })

  it('renders a failed row with em-dash cells and a failed status', () => {
    const report = renderFullReport(results, ['summary'], ctx)
    // Only active columns are rendered; core (prod) has add+replace so those are the two columns.
    expect(report).toContain('| broken (dev) | — | — | ❌ |')
  })

  it('spells the plan result out in the Plan details collapsible', () => {
    const report = renderFullReport(results, ['plan'], ctx)
    expect(report).toContain('broken (dev) · ❌ plan failed')
    expect(report).toContain('fintech (dev) · ⚠️ 1 warning')
    expect(report).toContain('distribution (dev) · ✅ no changes')
  })
})

describe('all 7 operations rendered', () => {
  const allOps = stack({
    name: 'demo',
    counts: {
      add: 2,
      change: 1,
      destroy: 1,
      replace: 2,
      import: 1,
      forget: 1,
      move: 1
    },
    warnings: ['Warning: deprecated argument'],
    planText:
      'Plan: 2 to add, 1 to change, 1 to destroy, 2 to replace, 1 to import, 1 to remove from state, 1 to move.'
  })

  it('matrix table has a column for every operation type', () => {
    const report = renderFullReport([allOps], ['summary'], ctx)
    expect(report).toContain(
      '| Stack | add | change | destroy | replace | import | remove | move |'
    )
  })

  it('operations table uses a plan-health icon in the job summary', () => {
    const report = renderFullReport([allOps], ['summary'], ctx)
    expect(report).toContain('## Terraform operations')
    // Health icon, not the count rollup (which would duplicate the columns).
    expect(report).toContain(
      '| Stack | add | change | destroy | replace | import | remove | move | Plan |'
    )
    expect(report).toContain('⚠️ 1 |')
  })

  it('comment keeps the per-stack count rollup in the Status column', () => {
    // The verbose rollup lives only in the comment, where columns are shown too.
    const report = renderComment([allOps], ctx, ctx.runUrl)
    expect(report).toContain(
      '`2 add` · `1 change` · **`1 destroy`** · **`2 replace (destroy+create)`** · `1 import` · `1 remove` · `1 move`'
    )
  })

  it('keeps the plan-result legend in the comment, not the summary', () => {
    const summary = renderFullReport([allOps], ['summary'], ctx)
    const comment = renderComment([allOps], ctx, ctx.runUrl)
    // comment has no expandables, so it carries the legend line — but only
    // for the icons its Status column shows (allOps renders counts + ⚠️)
    expect(comment).toContain('**What the plan result means:** ⚠️ has warnings')
    expect(comment).not.toContain('✅ planned OK')
    expect(comment).not.toContain('❌ plan failed')
    // summary explains results inline in the detail rows instead
    expect(summary).not.toContain('What the plan result means')
    expect(summary).not.toContain('needs attention')
  })

  it('caution callout mentions destroy and replace', () => {
    const report = renderFullReport([allOps], ['summary'], ctx)
    expect(report).toContain('[!CAUTION]')
    expect(report).toContain('**`1 destroy`**')
    expect(report).toContain('**`2 replace (destroy+create)`**')
  })
})

describe('custom sections', () => {
  const results = [
    stack({ name: 'monolith-dev', counts: { ...zeroCounts, add: 1 } }),
    stack({ name: 'monolith-prod' })
  ]
  const sections: Section[] = [
    {
      section: 'tags',
      title: 'Tags',
      order: 10,
      stack: 'monolith-dev',
      status: 'pass',
      escalate: 'warn',
      legend: { pass: 'tags present', fail: 'missing tags' },
      table_column: true,
      markdown: 'Tag detail for dev'
    },
    {
      section: 'tags',
      title: 'Tags',
      order: 10,
      stack: 'monolith-prod',
      status: 'pass',
      escalate: 'warn',
      legend: { pass: 'tags present', fail: 'missing tags' },
      table_column: true,
      markdown: 'Tag detail for prod'
    },
    {
      section: 'cost',
      title: 'Cost',
      order: 20,
      stack: 'monolith-dev',
      status: 'warn',
      escalate: 'warn',
      label: '$340/mo',
      legend: { pass: 'no increase', warn: 'cost goes up' },
      table_column: true,
      markdown: 'Cost detail for dev'
    },
    {
      section: 'drift',
      title: 'Drift',
      order: 30,
      stack: 'monolith-dev',
      status: 'pass',
      escalate: 'warn',
      legend: { pass: 'no drift', warn: 'drift detected' },
      table_column: false,
      markdown: 'No drift detected'
    }
  ]

  it('renders a Checks table with a column per table_column section, ordered', () => {
    const report = renderFullReport(results, ['summary'], ctx, sections)
    expect(report).toContain('## Checks')
    expect(report).toContain('| Stack | Tags | Cost |')
    // drift has table_column:false — no column
    expect(report).not.toContain('| Stack | Tags | Cost | Drift |')
  })

  it('shows icon-only cells, em-dash where a section is absent for a stack', () => {
    const report = renderFullReport(results, ['summary'], ctx, sections)
    expect(report).toContain('| monolith-dev | ✅ | ⚠️ |')
    // prod has no cost section → em-dash
    expect(report).toContain('| monolith-prod | ✅ | — |')
  })

  it('renders per-section detail blocks with the legend meaning inline, no glossary list', () => {
    const report = renderFullReport(results, ['summary'], ctx, sections)
    expect(report).toContain('### Tags')
    expect(report).toContain('### Cost')
    expect(report).toContain('### Drift') // table_column:false still gets detail
    expect(report).toContain('Cost detail for dev')
    // detail row shows the icon's plain-English meaning for that stack…
    expect(report).toContain('monolith-dev · ⚠️ cost goes up')
    expect(report).toContain('monolith-dev · ✅ no drift')
    // …not the bare status word, and no glossary list in the summary
    expect(report).not.toContain('· ⚠️ warn')
    expect(report).not.toContain('**What each check means**')
  })

  it('fires the section callout only for warn/fail sections, linking each', () => {
    const report = renderFullReport(results, ['summary'], ctx, sections)
    expect(report).toContain('[!IMPORTANT]')
    expect(report).toContain('Checks need attention')
    // summary callout uses same-page anchors
    expect(report).toContain('⚠️ [Cost](#cost)')
    expect(report).not.toContain('[Tags](#tags)') // pass sections don't escalate
  })

  it('respects per-section escalate: a warn with escalate:fail does not fire the callout', () => {
    const costOnly: Section[] = [
      {
        section: 'cost',
        title: 'Cost',
        order: 20,
        stack: 'monolith-dev',
        status: 'warn',
        escalate: 'fail',
        legend: { pass: 'no increase', warn: 'cost goes up' },
        table_column: true,
        markdown: 'x'
      }
    ]
    const report = renderFullReport(results, ['summary'], ctx, costOnly)
    expect(report).not.toContain('[!IMPORTANT]') // warn < fail threshold
    expect(report).toContain('| monolith-dev | ⚠️ |') // still shown in the table
  })

  it('comment shows the Checks table (icons) and a callout linking to the summary sections', () => {
    const body = renderComment(results, ctx, ctx.runUrl, sections)
    expect(body).toContain('| Stack | Tags | Cost |')
    expect(body).toContain('| monolith-dev | ✅ | ⚠️ |')
    // callout links point at the summary URL (detail lives there)
    expect(body).toContain(`⚠️ [Cost](${ctx.runUrl}#cost)`)
    // per-section glossary rides under the Checks table in the comment,
    // listing only the statuses that actually appear in each column
    expect(body).toContain('**What each check means**')
    expect(body).toContain('- **Tags** icons mean: ✅ tags present')
    expect(body).toContain('- **Cost** icons mean: ⚠️ cost goes up')
    // cost is warn-only in the table, so its pass phrase is not explained
    expect(body).not.toContain('✅ no increase')
    // no `—` explainer line — it added no information
    expect(body).not.toContain('produced no result')
  })

  it('legend lists only the statuses present in each check column', () => {
    const mixed: Section[] = [
      {
        section: 'tags',
        title: 'Tags',
        order: 10,
        stack: 'monolith-dev',
        status: 'fail',
        escalate: 'warn',
        legend: { pass: 'tags present', fail: 'missing tags' },
        table_column: true,
        markdown: 'x'
      },
      {
        section: 'tags',
        title: 'Tags',
        order: 10,
        stack: 'monolith-prod',
        status: 'pass',
        escalate: 'warn',
        legend: { pass: 'tags present', fail: 'missing tags' },
        table_column: true,
        markdown: 'x'
      }
    ]
    const body = renderComment(results, ctx, ctx.runUrl, mixed)
    // both pass and fail appear in the column → both explained, warn absent
    expect(body).toContain(
      '- **Tags** icons mean: ✅ tags present · ❌ missing tags'
    )
  })

  it('a section for a stack outside the report does not widen the legend', () => {
    const orphaned: Section[] = [
      {
        section: 'tags',
        title: 'Tags',
        order: 10,
        stack: 'monolith-dev',
        status: 'pass',
        escalate: 'warn',
        legend: { pass: 'tags present', fail: 'missing tags' },
        table_column: true,
        markdown: 'x'
      },
      {
        // no result row for this stack → renders no cell → no legend entry
        section: 'tags',
        title: 'Tags',
        order: 10,
        stack: 'ghost-stack',
        status: 'fail',
        escalate: 'warn',
        legend: { pass: 'tags present', fail: 'missing tags' },
        table_column: true,
        markdown: 'x'
      }
    ]
    const body = renderComment(results, ctx, ctx.runUrl, orphaned)
    expect(body).toContain('- **Tags** icons mean: ✅ tags present')
    expect(body).not.toContain('missing tags')
  })

  it('renders Plan details before the custom-section detail', () => {
    const report = renderFullReport(results, ['summary', 'plan'], ctx, sections)
    expect(report.indexOf('### Plan details')).toBeGreaterThan(-1)
    expect(report.indexOf('### Plan details')).toBeLessThan(
      report.indexOf('### Tags')
    )
  })

  it('renders no Checks table and no section callout when there are no sections', () => {
    const report = renderFullReport(results, ['summary'], ctx, [])
    expect(report).not.toContain('## Checks')
    expect(report).not.toContain('Custom checks need attention')
  })
})

describe('plan-result legend lists only icons shown in the Status column', () => {
  it('omits the line entirely when every status is a plain count rollup', () => {
    // `1 add` carries no status icon, so there is nothing to explain
    const results = [stack({ counts: { ...zeroCounts, add: 1 } })]
    const body = renderComment(results, ctx, ctx.runUrl)
    expect(body).not.toContain('What the plan result means')
  })

  it('shows only ✅ when every stack planned clean with no changes', () => {
    const body = renderComment([stack({})], ctx, ctx.runUrl)
    expect(body).toContain('**What the plan result means:** ✅ planned OK')
    expect(body).not.toContain('⚠️ has warnings')
    expect(body).not.toContain('❌ plan failed')
  })

  it('shows ✅ and ❌ when clean and failed stacks coexist', () => {
    const results = [
      stack({ name: 'ok' }),
      stack({ name: 'broken', failed: true, counts: null })
    ]
    const body = renderComment(results, ctx, ctx.runUrl)
    expect(body).toContain(
      '**What the plan result means:** ✅ planned OK · ❌ plan failed'
    )
    expect(body).not.toContain('⚠️ has warnings')
  })
})

describe('renderComment', () => {
  it('is compact: table and link, no per-stack plan bodies', () => {
    const results = [stack({ name: 'a', planText: 'SECRET PLAN BODY' })]
    const body = renderComment(results, ctx, ctx.runUrl)
    expect(body).toContain('Full report →')
    expect(body).toContain(ctx.runUrl)
    expect(body).not.toContain('SECRET PLAN BODY')
    expect(body).toMatchSnapshot()
  })
})

describe('renderCommentFallback', () => {
  it('keeps the health line and links the full report, drops per-stack detail', () => {
    const results = [
      stack({ name: 'a', planText: 'SECRET PLAN BODY' }),
      stack({ name: 'b', failed: true, counts: null })
    ]
    const body = renderCommentFallback(results, ctx, ctx.runUrl)
    expect(body).toContain('too large to render as a PR comment')
    expect(body).toContain('planned OK')
    expect(body).toContain('Full report →')
    expect(body).toContain(ctx.runUrl)
    expect(body).not.toContain('SECRET PLAN BODY')
  })

  it('surfaces the destroy/replace callout when present', () => {
    const results = [stack({ counts: { ...zeroCounts, destroy: 2 } })]
    const body = renderCommentFallback(results, ctx, ctx.runUrl)
    expect(body).toContain('[!CAUTION]')
    expect(body).toContain('2 destroy')
  })
})

describe('renderSummaryFallback', () => {
  it('keeps the health line and points to the run, drops per-stack plan bodies', () => {
    const results = [
      stack({ name: 'a', planText: 'SECRET PLAN BODY' }),
      stack({ name: 'b', failed: true, counts: null })
    ]
    const body = renderSummaryFallback(results, ctx)
    expect(body).toContain('too large to render as a job summary')
    expect(body).toContain('1 MiB')
    expect(body).toContain('planned OK')
    expect(body).toContain(ctx.runUrl)
    expect(body).not.toContain('SECRET PLAN BODY')
  })

  it('surfaces the destroy/replace callout when present', () => {
    const results = [stack({ counts: { ...zeroCounts, destroy: 2 } })]
    const body = renderSummaryFallback(results, ctx)
    expect(body).toContain('[!CAUTION]')
    expect(body).toContain('2 destroy')
  })
})

describe('chooseSummaryBody', () => {
  const over = 'x'.repeat(MAX_SUMMARY_BYTES + 1)

  it('keeps the full report when it fits (tier 1)', () => {
    expect(
      chooseSummaryBody([
        { label: 'full', body: 'small' },
        { label: 'no plan details', body: 'mid' },
        { label: 'minimal', body: 'tiny' }
      ])
    ).toEqual({ label: 'full', body: 'small', truncated: false })
  })

  it('drops to no-plan-details when the full report is over cap (tier 2)', () => {
    const chosen = chooseSummaryBody([
      { label: 'full', body: over },
      { label: 'no plan details', body: 'fits' },
      { label: 'minimal', body: 'tiny' }
    ])
    expect(chosen).toEqual({
      label: 'no plan details',
      body: 'fits',
      truncated: true
    })
  })

  it('falls through to minimal when nothing richer fits (tier 3)', () => {
    const chosen = chooseSummaryBody([
      { label: 'full', body: over },
      { label: 'no plan details', body: over },
      { label: 'minimal', body: 'tiny' }
    ])
    expect(chosen).toEqual({ label: 'minimal', body: 'tiny', truncated: true })
  })

  it('measures bytes, not characters (multi-byte content)', () => {
    // 'π' is 2 bytes in UTF-8: half as many chars as the cap still overflows.
    const big = 'π'.repeat(MAX_SUMMARY_BYTES / 2 + 1)
    const chosen = chooseSummaryBody([
      { label: 'full', body: big },
      { label: 'minimal', body: 'tiny' }
    ])
    expect(chosen.label).toBe('minimal')
    expect(chosen.truncated).toBe(true)
  })
})

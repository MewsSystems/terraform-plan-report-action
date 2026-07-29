/**
 * Render the report locally without GitHub or a pull request.
 *
 * Renders through the same code the action runs in CI: it scans a plans-dir
 * (one subdirectory per stack, each with meta.json + plan.txt + plan.json) and
 * an optional sections-dir. Defaults to the bundled __fixtures__/plans-dir +
 * sections so you see the whole report — including custom sections — out of the
 * box. Both fixtures are canonical worked examples of what upstream jobs upload.
 *
 * Writes two files:
 *   preview-summary.md  — the full report (what lands in the job summary)
 *   preview-comment.md  — the compact sticky comment (what lands on the PR)
 *
 * Usage:
 *   npm run preview                                        # plans-dir + sections
 *   PLANS_DIR=__fixtures__/scenarios npm run preview       # full 7-operation spread
 *   npm run preview -- replace warnings                    # specific stacks by name
 *   PLANS_DIR=path/to/plans SECTIONS_DIR=path npm run preview  # your own artifacts
 */
import { writeFile } from 'node:fs/promises'
import {
  parseShow,
  sectionsFromDir,
  stacksFromPlansDir
} from '../src/inputs.js'
import { analyzeStack } from '../src/plan.js'
import {
  aggregate,
  renderComment,
  renderCommentFallback,
  renderFullReport
} from '../src/render.js'
import { chooseCommentBody } from '../src/comment.js'
import type { ReportContext } from '../src/types.js'

// Default to the bundled plans-dir + sections pairing so a bare `npm run
// preview` shows the whole report, custom sections included. Override PLANS_DIR
// (e.g. __fixtures__/scenarios for the full 7-operation spread); sections then
// only load if you also set SECTIONS_DIR, since section files join by stack name.
const PLANS_DIR = process.env.PLANS_DIR ?? '__fixtures__/plans-dir'
const SECTIONS_DIR =
  process.env.SECTIONS_DIR ??
  (process.env.PLANS_DIR ? undefined : '__fixtures__/sections')

// CLI args after -- are stack names to filter to; empty = all.
const filter = process.argv.slice(2)
let stacks = await stacksFromPlansDir(PLANS_DIR)
if (filter.length > 0) stacks = stacks.filter((s) => filter.includes(s.name))

const sections = SECTIONS_DIR ? await sectionsFromDir(SECTIONS_DIR) : []

const sha = (process.env.GITHUB_SHA ?? 'local000').slice(0, 7)
const repo =
  process.env.GITHUB_REPOSITORY ?? 'MewsSystems/terraform-plan-report-action'
const actionRepo =
  process.env.GITHUB_ACTION_REPOSITORY ??
  'MewsSystems/terraform-plan-report-action'
const ctx: ReportContext = {
  title: repo.split('/')[1] ?? 'terraform-plan-report (preview)',
  sha,
  commitUrl: `https://github.com/${repo}/commit/${process.env.GITHUB_SHA ?? 'local000'}`,
  runUrl:
    'https://github.com/MewsSystems/terraform-plan-report-action/actions/runs/0',
  docsUrl: `https://github.com/${actionRepo}#reading-the-report`
}

const show = parseShow(process.env.INPUT_SHOW ?? 'summary,plan,warnings,errors')

const results = await Promise.all(stacks.map(analyzeStack))
const agg = aggregate(results)

await writeFile(
  'preview-summary.md',
  renderFullReport(results, show, ctx, sections)
)
// Route through the same cap check the action ships, using the default marker,
// so an oversized report previews the fallback here too. Set PREVIEW_COMMENT_CAP
// (e.g. =1) to force the fallback against the small fixture comment.
const marker = process.env.INPUT_COMMENT_MARKER ?? '<!-- tf-plan-report -->'
const cap = process.env.PREVIEW_COMMENT_CAP
  ? Number(process.env.PREVIEW_COMMENT_CAP)
  : undefined
const chosen = chooseCommentBody(
  marker,
  renderComment(results, ctx, ctx.runUrl, sections),
  renderCommentFallback(results, ctx, ctx.runUrl),
  cap
)
if (chosen.truncated) {
  console.log('Comment exceeds the 64 KiB cap; previewing the fallback body.')
}
await writeFile('preview-comment.md', chosen.body)

console.log(
  `Rendered ${results.length} ${results.length === 1 ? 'stack' : 'stacks'} · ${agg.failed} failed · ${agg.warnings} warnings`
)
console.log(
  'preview-summary.md  — full report (job summary)\npreview-comment.md  — compact PR comment'
)

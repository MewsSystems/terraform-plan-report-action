import * as core from '@actions/core'
import * as github from '@actions/github'
import { getInputs } from './inputs.js'
import { analyzeStack } from './plan.js'
import {
  MAX_SUMMARY_BYTES,
  aggregate,
  chooseSummaryBody,
  renderComment,
  renderCommentFallback,
  renderFullReport,
  renderSummaryFallback
} from './render.js'
import { upsertComment } from './comment.js'
import type { ReportContext } from './types.js'

/**
 * Entry point. Analyzes every stack, renders the full report to the job
 * summary, and upserts the compact view as a single sticky PR comment.
 */
export async function run(): Promise<void> {
  try {
    const inputs = await getInputs()
    const results = await Promise.all(inputs.stacks.map(analyzeStack))
    const agg = aggregate(results)

    const { owner, repo } = github.context.repo
    const pr = github.context.payload.pull_request
    const sha = (pr?.head?.sha ?? github.context.sha) as string
    const runUrl = `${github.context.serverUrl}/${owner}/${repo}/actions/runs/${github.context.runId}`
    const shortSha = sha.slice(0, 7)
    const commitUrl = `${github.context.serverUrl}/${owner}/${repo}/commit/${sha}`
    const actionRepo =
      process.env.GITHUB_ACTION_REPOSITORY ??
      'MewsSystems/terraform-plan-report-action'
    const docsUrl = `${github.context.serverUrl}/${actionRepo}#reading-the-report`

    const ctx: ReportContext = {
      title: repo,
      sha: shortSha,
      commitUrl,
      runUrl,
      docsUrl
    }

    // Never send an oversized summary — the runner silently aborts it and the
    // report vanishes. Ship the richest body that fits the 1 MiB cap, degrading
    // in order: full (plan text already stripped of refresh noise) → the same
    // report with the heavy Plan details section dropped → a minimal pointer to
    // the run.
    const withoutPlan = inputs.show.filter((s) => s !== 'plan')
    const summary = chooseSummaryBody([
      {
        label: 'full',
        body: renderFullReport(results, inputs.show, ctx, inputs.sections)
      },
      {
        label: 'no plan details',
        body: renderFullReport(results, withoutPlan, ctx, inputs.sections)
      },
      { label: 'minimal', body: renderSummaryFallback(results, ctx) }
    ])
    if (summary.truncated) {
      core.warning(
        `Job summary exceeded GitHub's ${MAX_SUMMARY_BYTES}-byte cap; wrote the '${summary.label}' tier. See the run's plan step logs and artifacts for the full plan.`
      )
    }
    await core.summary.addRaw(summary.body).write()

    core.setOutput('has-destroys', String(agg.hasDestroys))
    core.setOutput('has-replaces', String(agg.hasReplaces))
    core.setOutput('failed-stacks', String(agg.failed))
    core.setOutput('summary-url', runUrl)

    if (pr?.number && inputs.githubToken) {
      const body = renderComment(results, ctx, runUrl, inputs.sections)
      const fallback = renderCommentFallback(results, ctx, runUrl)
      const commentId = await upsertComment(
        inputs.githubToken,
        pr.number,
        inputs.commentMarker,
        body,
        fallback
      )
      core.setOutput('comment-id', String(commentId))
      core.info(`Upserted PR comment ${commentId} on #${pr.number}.`)
    } else {
      core.info(
        'No pull_request context or token; wrote the job summary and skipped the PR comment.'
      )
    }

    if (agg.failed > 0) {
      core.warning(`${agg.failed} stack(s) failed to plan; see the report.`)
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

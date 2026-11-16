import * as core from '@actions/core'
import * as github from '@actions/github'

/**
 * GitHub's hard cap on an issue/PR comment body, in characters. The API rejects
 * anything longer with a 422 ("Body is too long (maximum is 65536 characters)").
 */
export const MAX_COMMENT_LENGTH = 65536

/**
 * Decide which body to post. `body` is one candidate or several, richest
 * first. The marker is prepended to the body (and counts toward the cap), so
 * the first candidate that fits under GitHub's 64 KiB limit wins; when none
 * fits the body is swapped for `fallback` (a short pointer to the job
 * summary). Pure, so the local preview can exercise the exact decision the
 * action ships. Returns the chosen body, the index of the candidate it came
 * from (0 when `fallback` was swapped in) and whether it was swapped.
 */
export function chooseCommentBody(
  marker: string,
  body: string | string[],
  fallback?: string,
  maxLength: number = MAX_COMMENT_LENGTH
): { body: string; index: number; truncated: boolean } {
  const candidates = [body].flat()
  if (candidates.length === 0) {
    throw new Error('chooseCommentBody needs at least one candidate body')
  }
  const index = candidates.findIndex(
    (c) => `${marker}\n${c}`.length <= maxLength
  )
  if (index !== -1) return { body: candidates[index], index, truncated: false }
  if (fallback !== undefined)
    return { body: fallback, index: 0, truncated: true }
  return { body: candidates[0], index: 0, truncated: false }
}

/**
 * Find the sticky comment by its marker and PATCH it, or POST a new one.
 * The marker is prepended to the body so the next run can find it again.
 * Returns the comment id.
 *
 * An oversized report is swapped for `fallback` (see `chooseCommentBody`) so it
 * still posts a comment instead of failing the whole action. The plan detail
 * always lives in the job summary, so nothing is lost.
 */
export async function upsertComment(
  token: string,
  prNumber: number,
  marker: string,
  body: string | string[],
  fallback?: string,
  payload?: string
): Promise<number> {
  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const payloadSuffix = payload === undefined ? '' : `\n\n${payload}`
  const chosen = chooseCommentBody(
    marker,
    body,
    fallback,
    MAX_COMMENT_LENGTH - payloadSuffix.length
  )
  if (chosen.truncated) {
    core.warning(
      `Comment body is over GitHub's ${MAX_COMMENT_LENGTH} cap; posting the compact fallback instead. See the job summary for the full report.`
    )
  } else if (chosen.index > 0) {
    core.warning(
      `Comment body is over GitHub's ${MAX_COMMENT_LENGTH} cap; posting a slimmer version of it. See the job summary for the full report.`
    )
  }
  const fullBody = `${marker}\n${chosen.body}${payloadSuffix}`

  const existingId = await findComment(octokit, owner, repo, prNumber, marker)
  if (existingId !== undefined) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingId,
      body: fullBody
    })
    return existingId
  }

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: fullBody
  })
  return data.id
}

type Octokit = ReturnType<typeof github.getOctokit>

async function findComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  marker: string
): Promise<number | undefined> {
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page
    })
    const hit = data.find((c) => c.body?.includes(marker))
    if (hit) return hit.id
    if (data.length < 100) return undefined
  }
}

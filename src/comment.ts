import * as core from '@actions/core'
import * as github from '@actions/github'

/**
 * GitHub's hard cap on an issue/PR comment body, in characters. The API rejects
 * anything longer with a 422 ("Body is too long (maximum is 65536 characters)").
 */
export const MAX_COMMENT_LENGTH = 65536

/**
 * Decide which body to post. The marker is prepended to the body (and counts
 * toward the cap), so when `marker + body` would exceed GitHub's 64 KiB limit
 * the body is swapped for `fallback` (a short pointer to the job summary). Pure,
 * so the local preview can exercise the exact decision the action ships.
 * Returns the chosen body and whether it was swapped.
 */
export function chooseCommentBody(
  marker: string,
  body: string,
  fallback?: string,
  maxLength: number = MAX_COMMENT_LENGTH
): { body: string; truncated: boolean } {
  const overCap = `${marker}\n${body}`.length > maxLength
  if (overCap && fallback !== undefined)
    return { body: fallback, truncated: true }
  return { body, truncated: false }
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
  body: string,
  fallback?: string
): Promise<number> {
  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const chosen = chooseCommentBody(marker, body, fallback)
  if (chosen.truncated) {
    core.warning(
      `Comment body is ${`${marker}\n${body}`.length} chars, over GitHub's ${MAX_COMMENT_LENGTH} cap; posting the compact fallback instead. See the job summary for the full report.`
    )
  }
  const fullBody = `${marker}\n${chosen.body}`

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

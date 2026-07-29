/**
 * Tests for src/main.ts. The GitHub toolkit is mocked; the action scans the
 * real __fixtures__/plans-dir (the same path CI runs) so analysis runs for real.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const context = {
  repo: { owner: 'MewsSystems', repo: 'tf-domain-foundations' },
  sha: 'abcdef1234567',
  runId: 42,
  serverUrl: 'https://github.com',
  payload: {} as Record<string, unknown>
}
const upsertComment = jest.fn(async () => 999)

jest.unstable_mockModule('@actions/github', () => ({
  context,
  getOctokit: jest.fn()
}))
jest.unstable_mockModule('../src/comment.js', () => ({ upsertComment }))

const { run } = await import('../src/main.js')

describe('run', () => {
  beforeEach(() => {
    context.payload = {}
    core.getInput.mockImplementation((name: string) => {
      const values: Record<string, string> = {
        'plans-dir': '__fixtures__/plans-dir',
        show: 'summary,plan,warnings,errors',
        'github-token': 'tok',
        'comment-marker': '<!-- tf-plan-report -->'
      }
      return values[name] ?? ''
    })
    core.summary.addRaw.mockImplementation(() => core.summary)
    core.summary.write.mockImplementation(async () => core.summary)
    upsertComment.mockImplementation(async () => 999)
  })

  afterEach(() => jest.resetAllMocks())

  it('scans plans-dir, writes the job summary and sets outputs without a PR', async () => {
    await run()

    expect(core.summary.addRaw).toHaveBeenCalledTimes(1)
    expect(core.summary.write).toHaveBeenCalledTimes(1)
    expect(core.setOutput).toHaveBeenCalledWith(
      'summary-url',
      'https://github.com/MewsSystems/tf-domain-foundations/actions/runs/42'
    )
    // __fixtures__/plans-dir: monolith-dev (add/change/destroy/replace) + monolith-prod (no changes)
    expect(core.setOutput).toHaveBeenCalledWith('failed-stacks', '0')
    expect(core.setOutput).toHaveBeenCalledWith('has-destroys', 'true')
    expect(core.setOutput).toHaveBeenCalledWith('has-replaces', 'true')
    expect(upsertComment).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('upserts the sticky comment when run on a pull request', async () => {
    context.payload = {
      pull_request: { number: 13, head: { sha: 'deadbeef000' } }
    }

    await run()

    expect(upsertComment).toHaveBeenCalledTimes(1)
    expect(upsertComment).toHaveBeenCalledWith(
      'tok',
      13,
      '<!-- tf-plan-report -->',
      expect.stringContaining('Terraform Plan'),
      expect.stringContaining('too large to render as a PR comment')
    )
    expect(core.setOutput).toHaveBeenCalledWith('comment-id', '999')
  })

  it('renders custom sections when sections-dir is set', async () => {
    core.getInput.mockImplementation((name: string) => {
      const values: Record<string, string> = {
        'plans-dir': '__fixtures__/plans-dir',
        'sections-dir': '__fixtures__/sections',
        show: 'summary,plan,warnings,errors'
      }
      return values[name] ?? ''
    })

    await run()

    const report = core.summary.addRaw.mock.calls[0][0] as string
    expect(report).toContain('## Checks')
    expect(report).toContain('| Stack | Tags | Cost |')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails with a clear message when plans-dir is missing', async () => {
    core.getInput.mockImplementation((name: string) =>
      name === 'plans-dir' ? '__fixtures__/does-not-exist' : ''
    )

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('plans-dir not found')
    )
  })
})

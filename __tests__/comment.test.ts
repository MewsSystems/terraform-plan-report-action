import { jest } from '@jest/globals'

const listComments =
  jest.fn<
    (args: unknown) => Promise<{ data: { id: number; body: string }[] }>
  >()
const updateComment = jest.fn(async () => ({ data: {} }))
const createComment = jest.fn(async () => ({ data: { id: 555 } }))

const context = {
  repo: { owner: 'MewsSystems', repo: 'tf-domain-foundations' }
}
const getOctokit = jest.fn(() => ({
  rest: { issues: { listComments, updateComment, createComment } }
}))

const warning = jest.fn()

jest.unstable_mockModule('@actions/github', () => ({ context, getOctokit }))
jest.unstable_mockModule('@actions/core', () => ({ warning }))

const { upsertComment, chooseCommentBody, MAX_COMMENT_LENGTH } =
  await import('../src/comment.js')

const MARKER = '<!-- tf-plan-report -->'

describe('chooseCommentBody', () => {
  it('keeps the body when it fits', () => {
    expect(chooseCommentBody(MARKER, 'small', 'fallback')).toEqual({
      body: 'small',
      truncated: false
    })
  })

  it('swaps to the fallback when marker + body exceeds the cap', () => {
    const huge = 'x'.repeat(MAX_COMMENT_LENGTH + 1)
    expect(chooseCommentBody(MARKER, huge, 'fallback')).toEqual({
      body: 'fallback',
      truncated: true
    })
  })

  it('counts the marker toward the cap', () => {
    // body alone fits; marker + newline tips it over.
    const body = 'x'.repeat(MAX_COMMENT_LENGTH)
    expect(chooseCommentBody(MARKER, body, 'fallback').truncated).toBe(true)
  })

  it('keeps the oversized body when no fallback is given', () => {
    const huge = 'x'.repeat(MAX_COMMENT_LENGTH + 1)
    expect(chooseCommentBody(MARKER, huge)).toEqual({
      body: huge,
      truncated: false
    })
  })
})

describe('upsertComment', () => {
  afterEach(() => jest.clearAllMocks())

  it('updates the existing comment found by marker', async () => {
    listComments.mockResolvedValueOnce({
      data: [{ id: 7, body: `${MARKER}\nold report` }]
    })

    const id = await upsertComment('tok', 13, MARKER, 'new report')

    expect(id).toBe(7)
    expect(updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 7, body: `${MARKER}\nnew report` })
    )
    expect(createComment).not.toHaveBeenCalled()
  })

  it('creates a comment when no marker is found', async () => {
    listComments.mockResolvedValueOnce({
      data: [{ id: 1, body: 'unrelated' }]
    })

    const id = await upsertComment('tok', 13, MARKER, 'report')

    expect(id).toBe(555)
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 13, body: `${MARKER}\nreport` })
    )
    expect(updateComment).not.toHaveBeenCalled()
  })

  it('swaps in the fallback body when the report exceeds the cap', async () => {
    listComments.mockResolvedValueOnce({ data: [] })
    const huge = 'x'.repeat(MAX_COMMENT_LENGTH + 1)

    await upsertComment('tok', 13, MARKER, huge, 'too big, see summary')

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: `${MARKER}\ntoo big, see summary` })
    )
    expect(warning).toHaveBeenCalled()
  })

  it('posts the full body when it fits, even with a fallback available', async () => {
    listComments.mockResolvedValueOnce({ data: [] })

    await upsertComment('tok', 13, MARKER, 'small report', 'fallback')

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: `${MARKER}\nsmall report` })
    )
    expect(warning).not.toHaveBeenCalled()
  })

  it('posts the oversized body unchanged when no fallback is given', async () => {
    listComments.mockResolvedValueOnce({ data: [] })
    const huge = 'x'.repeat(MAX_COMMENT_LENGTH + 1)

    await upsertComment('tok', 13, MARKER, huge)

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: `${MARKER}\n${huge}` })
    )
  })
})

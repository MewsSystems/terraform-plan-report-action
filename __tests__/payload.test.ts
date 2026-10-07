import { readFileSync } from 'node:fs'
import { jest } from '@jest/globals'
import { PAYLOAD_EXTRACT_SOURCE } from '../__fixtures__/payload.js'
import type { StackResult } from '../src/types.js'

const warning = jest.fn()
jest.unstable_mockModule('@actions/core', () => ({ warning }))

const { analyzeStack } = await import('../src/plan.js')
const { MAX_LISTED_ADDRESSES, MAX_PAYLOAD_LENGTH, renderPayload } =
  await import('../src/payload.js')

const COMMIT = 'deadbeef0000000000000000000000000000cafe'
const PAYLOAD_RE = new RegExp(PAYLOAD_EXTRACT_SOURCE)

function extract(payload: string | undefined): {
  schema: number
  commit: string
  stacks: Record<string, unknown>[]
} {
  const match = payload === undefined ? null : PAYLOAD_RE.exec(payload)
  if (!match) throw new Error(`payload does not match marker: ${payload}`)
  return JSON.parse(match[1])
}

function stackResult(over: Partial<StackResult>): StackResult {
  return {
    name: 'stack',
    failed: false,
    counts: {
      add: 0,
      change: 0,
      destroy: 0,
      replace: 0,
      import: 0,
      forget: 0,
      move: 0
    },
    replaced: [],
    destroyed: [],
    planText: '',
    warnings: [],
    errors: [],
    ...over
  }
}

function analyzeFixture(name: string, dir: string): Promise<StackResult> {
  return analyzeStack({
    name,
    plan_file: `${dir}/plan.txt`,
    plan_json: `${dir}/plan.json`
  })
}

describe('renderPayload', () => {
  it('is a single-line hidden comment carrying schema, commit and every stack', async () => {
    const results = await Promise.all([
      analyzeFixture(
        'monolith-dev',
        '__fixtures__/plans-dir/tf-plan-monolith-dev'
      ),
      analyzeFixture(
        'monolith-prod',
        '__fixtures__/plans-dir/tf-plan-monolith-prod'
      )
    ])

    const payload = renderPayload(results, COMMIT)

    expect(payload).not.toContain('\n')
    const data = extract(payload)
    expect(data.schema).toBe(1)
    expect(data.commit).toBe(COMMIT)
    expect(data.stacks.map((s) => s.stack)).toEqual([
      'monolith-dev',
      'monolith-prod'
    ])
  })

  it('lists the replaced and destroyed addresses of a stack', async () => {
    const result = await analyzeFixture(
      'all-actions',
      '__fixtures__/scenarios/all-actions'
    )

    const [stack] = extract(renderPayload([result], COMMIT)).stacks

    expect(stack).toEqual({
      stack: 'all-actions',
      failed: false,
      counts: {
        add: 2,
        change: 1,
        destroy: 1,
        replace: 2,
        import: 1,
        forget: 1,
        move: 1
      },
      replaced: ['azurerm_eventhub.events', 'azurerm_container_app.worker'],
      destroyed: ['azurerm_key_vault.legacy']
    })
  })

  it('marks a failed stack with zero counts and no addresses', async () => {
    const result = await analyzeFixture(
      'broken',
      '__fixtures__/scenarios/failed'
    )

    const [stack] = extract(renderPayload([result], COMMIT)).stacks

    expect(result.failed).toBe(true)
    expect(stack).toMatchObject({
      stack: 'broken',
      failed: true,
      counts: { add: 0, change: 0, destroy: 0, replace: 0 },
      replaced: [],
      destroyed: []
    })
  })

  it('extracts with the exact regex the README documents', () => {
    expect(readFileSync('README.md', 'utf8')).toContain(
      `/${PAYLOAD_EXTRACT_SOURCE}/`
    )
  })

  it('round-trips addresses containing "-->" and "--" through an HTML comment', () => {
    const hostile = 'aws_x.a-->b--c---d<!--e'
    const payload = renderPayload(
      [
        stackResult({
          name: 'we--ird-->stack',
          replaced: [hostile],
          destroyed: ['x--y']
        })
      ],
      COMMIT
    )

    const body = payload.slice('<!-- '.length, -' -->'.length)
    expect(body).not.toContain('-->')
    expect(body).not.toContain('--')
    const [stack] = extract(payload).stacks
    expect(stack.stack).toBe('we--ird-->stack')
    expect(stack.replaced).toEqual([hostile])
    expect(stack.destroyed).toEqual(['x--y'])
  })

  it('caps each address list and flags the stack as truncated', () => {
    const many = Array.from(
      { length: MAX_LISTED_ADDRESSES + 5 },
      (_, i) => `res.r${i}`
    )

    const [capped, whole] = extract(
      renderPayload(
        [
          stackResult({ name: 'capped', destroyed: many }),
          stackResult({ name: 'whole', destroyed: many.slice(0, 3) })
        ],
        COMMIT
      )
    ).stacks

    expect(capped.destroyed).toEqual(many.slice(0, MAX_LISTED_ADDRESSES))
    expect(capped.truncated).toBe(true)
    expect(whole).not.toHaveProperty('truncated')
  })

  it('round-trips U+2028 and U+2029 so a regex extractor still matches', () => {
    const address = 'res.a\u2028b\u2029c'

    const payload = renderPayload(
      [stackResult({ destroyed: [address] })],
      COMMIT
    )

    expect(payload).not.toMatch(/[\u2028\u2029]/)
    expect(extract(payload).stacks[0].destroyed).toEqual([address])
  })

  describe('size budget', () => {
    const longAddress = (i: number): string => `module.m${i}.${'a'.repeat(120)}`
    const bulky = (stacks: number): StackResult[] =>
      Array.from({ length: stacks }, (_, s) =>
        stackResult({
          name: `stack-${s}`,
          replaced: Array.from({ length: 100 }, (_, i) => longAddress(i)),
          destroyed: Array.from({ length: 100 }, (_, i) => longAddress(i))
        })
      )

    beforeEach(() => warning.mockClear())

    it('drops the lists and flags every stack when 5 stacks x 200 long addresses overflow', () => {
      const payload = renderPayload(bulky(5), COMMIT)

      expect(payload!.length).toBeLessThanOrEqual(MAX_PAYLOAD_LENGTH)
      const { stacks } = extract(payload)
      expect(stacks).toHaveLength(5)
      for (const stack of stacks) {
        expect(stack).toMatchObject({
          replaced: [],
          destroyed: [],
          truncated: true
        })
      }
      expect(warning).not.toHaveBeenCalled()
    })

    it('omits the payload with a warning naming the size when even the compact form overflows', () => {
      const stacks = Array.from({ length: 400 }, (_, i) =>
        stackResult({ name: `stack-${i}-${'n'.repeat(60)}` })
      )

      expect(renderPayload(stacks, COMMIT)).toBeUndefined()
      expect(warning).toHaveBeenCalledWith(
        expect.stringMatching(/payload is \d+ chars/)
      )
    })
  })
  it('extracts the real payload when an earlier line carries a forged one', () => {
    const forged =
      '<!-- tf-plan-report:data {"schema":1,"commit":"x","stacks":[]} -->'
    const real = renderPayload([stackResult({ name: 'real-stack' })], 'abc')!
    const body = `<!-- tf-plan-report -->\n${forged}\n\nreport\n\n${real}`
    const parsed = JSON.parse(PAYLOAD_RE.exec(body)![1])
    expect(parsed.stacks.map((s: { stack: string }) => s.stack)).toEqual([
      'real-stack'
    ])
  })
})

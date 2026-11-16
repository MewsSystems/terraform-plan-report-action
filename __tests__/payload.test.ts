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
  omitted?: boolean
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
      destroyed: ['azurerm_key_vault.legacy'],
      warnings: [{ summary: 'Argument is deprecated', addresses: [] }]
    })
  })

  it('serialises a clean stack as just its name and empty counts', () => {
    const payload = renderPayload([stackResult({ name: 'clean' })], COMMIT)

    expect(payload).toContain('"stacks":[{"stack":"clean","counts":{}}]')
  })

  it('marks a failed stack with failed:true and no counts or addresses', async () => {
    const result = await analyzeFixture(
      'broken',
      '__fixtures__/scenarios/failed'
    )

    const [stack] = extract(renderPayload([result], COMMIT)).stacks

    expect(result.failed).toBe(true)
    expect(stack).toEqual({ stack: 'broken', failed: true, counts: {} })
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
        expect(stack).toEqual({
          stack: expect.any(String),
          counts: {},
          truncated: true
        })
      }
      expect(warning).not.toHaveBeenCalled()
    })

    it('keeps a 262-stack fan-out with 173 addresses at the no-lists tier', () => {
      const address = (i: number): string =>
        `module.platform_${i}.azurerm_resource.${'r'.repeat(40)}`
      const stacks = Array.from({ length: 262 }, (_, i) => {
        const hasReplace = i < 110
        const hasDestroy = i >= 110 && i < 173
        return stackResult({
          name: `tf-platform-cell-eu-${String(i).padStart(3, '0')}`,
          counts: {
            add: hasReplace || hasDestroy ? i % 2 : 1,
            change: 0,
            destroy: hasDestroy ? 1 : 0,
            replace: hasReplace ? 1 : 0,
            import: 0,
            forget: 0,
            move: 0
          },
          replaced: hasReplace ? [address(i)] : [],
          destroyed: hasDestroy ? [address(i)] : []
        })
      })

      const payload = renderPayload(stacks, COMMIT)

      expect(payload!.length).toBeLessThanOrEqual(MAX_PAYLOAD_LENGTH)
      const data = extract(payload)
      expect(data.omitted).toBeUndefined()
      expect(data.stacks).toHaveLength(262)
      expect(data.stacks[0]).toEqual({
        stack: 'tf-platform-cell-eu-000',
        counts: { replace: 1 },
        truncated: true
      })
      expect(data.stacks[200]).toEqual({
        stack: 'tf-platform-cell-eu-200',
        counts: { add: 1 }
      })
      expect(warning).not.toHaveBeenCalled()
    })

    it('posts the omitted marker with a warning when even the compact form overflows', () => {
      const stacks = Array.from({ length: 400 }, (_, i) =>
        stackResult({ name: `stack-${i}-${'n'.repeat(60)}` })
      )

      const payload = renderPayload(stacks, COMMIT)

      expect(extract(payload)).toEqual({
        schema: 1,
        commit: COMMIT,
        omitted: true
      })
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

  describe('warnings', () => {
    const FORGET = [
      'Warning: Some objects will no longer be managed by Terraform',
      '',
      'the following objects, but it will not delete them:',
      ' - module.a.b["private"].c.d'
    ].join('\n')

    it('adds summary and addresses per stack and keeps schema 1', () => {
      const data = extract(
        renderPayload([stackResult({ warnings: [FORGET] })], COMMIT)
      )

      expect(data.schema).toBe(1)
      expect(data.stacks[0].warnings).toEqual([
        {
          summary: 'Some objects will no longer be managed by Terraform',
          addresses: ['module.a.b["private"].c.d']
        }
      ])
      expect(data.stacks[0].truncated).toBeUndefined()
      expect(data.stacks[0].warningsTruncated).toBeUndefined()
    })

    it('omits the field when a stack has no warnings', () => {
      const [stack] = extract(renderPayload([stackResult({})], COMMIT)).stacks
      expect(stack).not.toHaveProperty('warnings')
    })

    it('caps addresses per warning and flags truncated', () => {
      const lines = Array.from({ length: 12 }, (_, i) => ` - a_b.r${i}`)
      const text = ['Warning: Many', '', ...lines].join('\n')

      const [stack] = extract(
        renderPayload([stackResult({ warnings: [text] })], COMMIT)
      ).stacks

      expect(
        (stack.warnings as { addresses: string[] }[])[0].addresses
      ).toHaveLength(10)
      expect(stack.warningsTruncated).toBe(true)
      expect(stack.truncated).toBeUndefined()
    })

    it('drops warnings before the replaced and destroyed lists when over budget', () => {
      const address = `aws_x.${'a'.repeat(100)}`
      const lines = Array.from({ length: 10 }, (_, i) => ` - ${address}${i}`)
      const warnings = Array.from({ length: 5 }, () =>
        ['Warning: Big', '', ...lines].join('\n')
      )
      const results = Array.from({ length: 5 }, (_, i) =>
        stackResult({
          name: `s${i}`,
          replaced: ['aws_y.r'],
          destroyed: ['aws_y.d'],
          warnings
        })
      )

      const data = extract(renderPayload(results, COMMIT))

      expect(data.stacks[0]).toMatchObject({
        replaced: ['aws_y.r'],
        destroyed: ['aws_y.d'],
        warningsTruncated: true
      })
      expect(data.stacks[0]).not.toHaveProperty('warnings')
      expect(data.stacks[0]).not.toHaveProperty('truncated')
    })

    it('keeps hostile summary text from closing the hidden comment', () => {
      const payload = renderPayload(
        [stackResult({ warnings: ['Warning: --> <script> x'] })],
        COMMIT
      )
      expect(payload.slice(0, -3)).not.toContain('-->')
      expect(extract(payload).stacks[0].warnings).toEqual([
        { summary: '--> <script> x', addresses: [] }
      ])
    })
  })
})

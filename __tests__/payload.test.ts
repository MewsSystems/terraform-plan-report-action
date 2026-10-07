import { analyzeStack } from '../src/plan.js'
import {
  MAX_LISTED_ADDRESSES,
  PAYLOAD_MARKER,
  renderPayload
} from '../src/payload.js'
import type { StackResult } from '../src/types.js'

const COMMIT = 'deadbeef0000000000000000000000000000cafe'
const PAYLOAD_RE = new RegExp(`^<!-- ${PAYLOAD_MARKER} (\\{.*\\}) -->$`)

function extract(payload: string): {
  schema: number
  commit: string
  stacks: Record<string, unknown>[]
} {
  const match = PAYLOAD_RE.exec(payload)
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
})

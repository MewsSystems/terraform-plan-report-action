import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseShow,
  sectionsFromDir,
  stacksFromPlansDir
} from '../src/inputs.js'

// A section file with every required field present and valid. Tests clone this
// and remove/replace one field at a time to prove each is enforced.
const VALID_SECTION: Record<string, unknown> = {
  section: 'tags',
  title: 'Tags',
  order: 10,
  stack: 'dev',
  legend: { pass: 'tags present', fail: 'missing tags' },
  markdown: 'All good.'
}

describe('stacksFromPlansDir', () => {
  it('derives one stack per subdirectory, named from meta.json, sorted', async () => {
    const stacks = await stacksFromPlansDir('__fixtures__/plans-dir')

    expect(stacks).toEqual([
      {
        name: 'monolith-dev',
        plan_file: '__fixtures__/plans-dir/tf-plan-monolith-dev/plan.txt',
        plan_json: '__fixtures__/plans-dir/tf-plan-monolith-dev/plan.json'
      },
      {
        name: 'monolith-prod',
        plan_file: '__fixtures__/plans-dir/tf-plan-monolith-prod/plan.txt',
        plan_json: '__fixtures__/plans-dir/tf-plan-monolith-prod/plan.json'
      }
    ])
  })

  // The meta.json contract is the only hard requirement per subdir. plan.txt /
  // plan.json are intentionally NOT enforced here — a leg that failed to plan
  // has no plan.json, and analyzeStack records it as a failed stack so it still
  // appears in the report.
  it('requires only meta.json — a leg with no plan files still yields a stack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plans-dir-'))
    try {
      await mkdir(join(dir, 'tf-plan-x'))
      await writeFile(
        join(dir, 'tf-plan-x', 'meta.json'),
        JSON.stringify({ stack: 'x' })
      )
      const stacks = await stacksFromPlansDir(dir)
      expect(stacks).toEqual([
        {
          name: 'x',
          plan_file: join(dir, 'tf-plan-x', 'plan.txt'),
          plan_json: join(dir, 'tf-plan-x', 'plan.json')
        }
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe('fail-fast validation', () => {
    let dir: string
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'plans-dir-'))
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('throws when the directory does not exist', async () => {
      await expect(stacksFromPlansDir(join(dir, 'nope'))).rejects.toThrow(
        /plans-dir not found/
      )
    })

    it('throws when there are no subdirectories', async () => {
      await expect(stacksFromPlansDir(dir)).rejects.toThrow(/no plan artifacts/)
    })

    it('throws when a subdirectory is missing meta.json', async () => {
      await mkdir(join(dir, 'stack-a'))
      await expect(stacksFromPlansDir(dir)).rejects.toThrow(/Missing meta.json/)
    })

    it('throws when meta.json is not valid JSON', async () => {
      await mkdir(join(dir, 'stack-a'))
      await writeFile(join(dir, 'stack-a', 'meta.json'), '{ not json')
      await expect(stacksFromPlansDir(dir)).rejects.toThrow(/Invalid JSON/)
    })

    // meta.json.stack is required and must be a non-empty string.
    it.each([
      ['the stack key is absent', {}],
      ['stack is an empty string', { stack: '' }],
      ['stack is whitespace only', { stack: '   ' }],
      ['stack is not a string', { stack: 42 }]
    ])('throws when %s', async (_label, meta) => {
      await mkdir(join(dir, 'stack-a'))
      await writeFile(join(dir, 'stack-a', 'meta.json'), JSON.stringify(meta))
      await expect(stacksFromPlansDir(dir)).rejects.toThrow(
        /non-empty string "stack" field/
      )
    })
  })
})

describe('sectionsFromDir', () => {
  it('parses the fixture sections and applies defaults', async () => {
    const sections = await sectionsFromDir('__fixtures__/sections')
    expect(sections).toHaveLength(5)

    const cost = sections.find(
      (s) => s.section === 'cost' && s.stack === 'monolith-dev'
    )
    expect(cost).toMatchObject({
      title: 'Cost',
      order: 20,
      status: 'warn',
      label: '$340/mo',
      table_column: true
    })

    // drift declares table_column:false — the default is otherwise true
    const drift = sections.find((s) => s.section === 'drift')
    expect(drift?.table_column).toBe(false)
    const tagsProd = sections.find(
      (s) => s.section === 'tags' && s.stack === 'monolith-prod'
    )
    expect(tagsProd?.table_column).toBe(true) // defaulted
    expect(tagsProd?.status).toBe('pass')
  })

  it('returns an empty list for a directory with no JSON files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sections-'))
    try {
      await expect(sectionsFromDir(dir)).resolves.toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('applies defaults for optional fields (status=pass, escalate=warn, table_column=true)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sections-'))
    try {
      await writeFile(join(dir, 'a.json'), JSON.stringify(VALID_SECTION))
      const [s] = await sectionsFromDir(dir)
      expect(s).toEqual({
        section: 'tags',
        title: 'Tags',
        order: 10,
        stack: 'dev',
        status: 'pass',
        escalate: 'warn',
        label: undefined,
        legend: { pass: 'tags present', fail: 'missing tags' },
        table_column: true,
        markdown: 'All good.'
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws when escalate is not a known value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sections-'))
    try {
      await writeFile(
        join(dir, 'a.json'),
        JSON.stringify({ ...VALID_SECTION, escalate: 'always' })
      )
      await expect(sectionsFromDir(dir)).rejects.toThrow(
        /`escalate` must be one of/
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe('fail-fast validation', () => {
    let dir: string
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'sections-'))
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('throws when the directory does not exist', async () => {
      await expect(sectionsFromDir(join(dir, 'nope'))).rejects.toThrow(
        /sections-dir not found/
      )
    })

    it('throws on invalid JSON', async () => {
      await writeFile(join(dir, 'a.json'), '{ not json')
      await expect(sectionsFromDir(dir)).rejects.toThrow(/Invalid JSON/)
    })

    // Every required string field, absent → error naming that field.
    it.each(['section', 'title', 'stack', 'markdown'])(
      'throws when required field `%s` is missing',
      async (field) => {
        const obj = { ...VALID_SECTION }
        delete obj[field]
        await writeFile(join(dir, 'a.json'), JSON.stringify(obj))
        await expect(sectionsFromDir(dir)).rejects.toThrow(`\`${field}\``)
      }
    )

    // ...and present but empty/whitespace → same error.
    it.each(['section', 'title', 'stack', 'markdown'])(
      'throws when required field `%s` is blank',
      async (field) => {
        await writeFile(
          join(dir, 'a.json'),
          JSON.stringify({ ...VALID_SECTION, [field]: '   ' })
        )
        await expect(sectionsFromDir(dir)).rejects.toThrow(`\`${field}\``)
      }
    )

    it('throws when required field `order` is missing', async () => {
      const obj = { ...VALID_SECTION }
      delete obj.order
      await writeFile(join(dir, 'a.json'), JSON.stringify(obj))
      await expect(sectionsFromDir(dir)).rejects.toThrow(
        /`order` must be a number/
      )
    })

    it('throws when `legend` is missing or not an object', async () => {
      for (const legend of [undefined, 'a string', ['x'], 42]) {
        const obj = { ...VALID_SECTION, legend }
        if (legend === undefined) delete obj.legend
        await writeFile(join(dir, 'a.json'), JSON.stringify(obj))
        await expect(sectionsFromDir(dir)).rejects.toThrow(
          /`legend` must be an object/
        )
      }
    })

    it('throws when `legend` has an unknown key', async () => {
      await writeFile(
        join(dir, 'a.json'),
        JSON.stringify({ ...VALID_SECTION, legend: { ok: 'x' } })
      )
      await expect(sectionsFromDir(dir)).rejects.toThrow(
        /`legend` has unknown key "ok"/
      )
    })

    it('throws when a `legend` value is blank', async () => {
      await writeFile(
        join(dir, 'a.json'),
        JSON.stringify({ ...VALID_SECTION, legend: { pass: '   ' } })
      )
      await expect(sectionsFromDir(dir)).rejects.toThrow(
        /`legend.pass` must be a non-empty string/
      )
    })

    it('throws when `legend` lacks an entry for the section status', async () => {
      // status defaults to pass; a legend without `pass` fails fast
      await writeFile(
        join(dir, 'a.json'),
        JSON.stringify({ ...VALID_SECTION, legend: { fail: 'boom' } })
      )
      await expect(sectionsFromDir(dir)).rejects.toThrow(
        /must include an entry for its own status "pass"/
      )
    })

    it('throws when `order` is not a number', async () => {
      await writeFile(
        join(dir, 'a.json'),
        JSON.stringify({ ...VALID_SECTION, order: 'first' })
      )
      await expect(sectionsFromDir(dir)).rejects.toThrow(
        /`order` must be a number/
      )
    })

    it('throws when `status` is not a known value', async () => {
      await writeFile(
        join(dir, 'a.json'),
        JSON.stringify({ ...VALID_SECTION, status: 'bogus' })
      )
      await expect(sectionsFromDir(dir)).rejects.toThrow(
        /`status` must be one of/
      )
    })
  })
})

describe('parseShow', () => {
  it('rejects unknown sections', () => {
    expect(() => parseShow('summary,bogus')).toThrow(/unknown section/)
  })
})

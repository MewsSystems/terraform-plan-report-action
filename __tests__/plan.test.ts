import {
  analyzeStack,
  cleanPlanText,
  countsFromPlanJson,
  extractDiagnostics
} from '../src/plan.js'

const zeroCounts = {
  add: 0,
  change: 0,
  destroy: 0,
  replace: 0,
  import: 0,
  forget: 0,
  move: 0
}

describe('countsFromPlanJson', () => {
  it('counts add, change, destroy and replace from resource_changes', () => {
    const json = JSON.stringify({
      resource_changes: [
        { change: { actions: ['create'] } },
        { change: { actions: ['update'] } },
        { change: { actions: ['delete'] } },
        { change: { actions: ['delete', 'create'] } },
        { change: { actions: ['no-op'] } },
        { change: { actions: ['read'] } }
      ]
    })
    expect(countsFromPlanJson(json)).toEqual({
      ...zeroCounts,
      add: 1,
      change: 1,
      destroy: 1,
      replace: 1
    })
  })

  it('counts create_before_destroy replace (["create","delete"])', () => {
    const json = JSON.stringify({
      resource_changes: [{ change: { actions: ['create', 'delete'] } }]
    })
    expect(countsFromPlanJson(json)).toEqual({ ...zeroCounts, replace: 1 })
  })

  it('counts import when importing marker present with no-op (resource matches config)', () => {
    const json = JSON.stringify({
      resource_changes: [
        { change: { actions: ['no-op'], importing: { id: 'existing-id' } } }
      ]
    })
    expect(countsFromPlanJson(json)).toEqual({ ...zeroCounts, import: 1 })
  })

  it('counts import when importing marker present with update (config diff)', () => {
    const json = JSON.stringify({
      resource_changes: [
        { change: { actions: ['update'], importing: { id: 'existing-id' } } }
      ]
    })
    expect(countsFromPlanJson(json)).toEqual({ ...zeroCounts, import: 1 })
  })

  it('counts forget actions (TF 1.7+ removed with destroy=false)', () => {
    const json = JSON.stringify({
      resource_changes: [{ change: { actions: ['forget'] } }]
    })
    expect(countsFromPlanJson(json)).toEqual({ ...zeroCounts, forget: 1 })
  })

  it('counts moved blocks via previous_address in resource_changes (TF 1.1+)', () => {
    const json = JSON.stringify({
      resource_changes: [
        {
          address: 'module.b.resource.x',
          previous_address: 'module.a.resource.x',
          change: { actions: ['no-op'] }
        }
      ]
    })
    expect(countsFromPlanJson(json)).toEqual({ ...zeroCounts, move: 1 })
  })

  it('does not count no-op or read as changes', () => {
    const json = JSON.stringify({
      resource_changes: [
        { change: { actions: ['no-op'] } },
        { change: { actions: ['read'] } }
      ]
    })
    expect(countsFromPlanJson(json)).toEqual(zeroCounts)
  })

  it('returns zeros for an empty plan', () => {
    expect(countsFromPlanJson('{}')).toEqual(zeroCounts)
  })
})

describe('extractDiagnostics', () => {
  it('separates warnings from errors and strips the framing', () => {
    const text = [
      '╷',
      '│ Warning: Argument is deprecated',
      '│',
      '│ namespace_name has been deprecated',
      '╵',
      '╷',
      '│ Error: Invalid resource type',
      '│',
      '│ unsupported type',
      '╵'
    ].join('\n')

    const { warnings, errors } = extractDiagnostics(text)
    expect(warnings).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(warnings[0]).toMatch(/^Warning: Argument is deprecated/)
    expect(warnings[0]).not.toContain('│')
  })

  it('extracts check-block warnings (unframed, no ╷…╵)', () => {
    const text = [
      'No changes.',
      '',
      'Warning: Check block assertion failed',
      '',
      '  on main.tf line 1, in check "foo":',
      '  1:     condition = false',
      '    ├────────────────',
      '    │ some_var = "value"',
      '',
      'Human-readable description.',
      '',
      'Warning: Check block assertion failed',
      '',
      '  on main.tf line 2, in check "bar":',
      '  2:     condition = false',
      '',
      'Second description.'
    ].join('\n')

    const { warnings, errors } = extractDiagnostics(text)
    expect(warnings).toHaveLength(2)
    expect(errors).toHaveLength(0)
    expect(warnings[0]).toMatch(/^Warning: Check block assertion failed/)
    expect(warnings[0]).toContain('Human-readable description.')
    expect(warnings[1]).toMatch(/^Warning: Check block assertion failed/)
    expect(warnings[1]).toContain('Second description.')
  })

  it('extracts unframed data-source errors (AzureRM provider format)', () => {
    const text = [
      'Planning failed. Terraform encountered an error while generating this plan.',
      '',
      'Error: \'Resource Group\' "rg-does-not-exist-anywhere" was not found',
      '',
      '  with data.azurerm_resource_group.external,',
      '  on main.tf line 21, in data "azurerm_resource_group" "external":',
      '  21: data "azurerm_resource_group" "external" {'
    ].join('\n')

    const { warnings, errors } = extractDiagnostics(text)
    expect(errors).toHaveLength(1)
    expect(warnings).toHaveLength(0)
    expect(errors[0]).toMatch(/^Error: 'Resource Group'/)
    expect(errors[0]).toContain('rg-does-not-exist-anywhere')
  })

  it('does not double-count framed warnings that also contain Warning: text', () => {
    const text = [
      '╷',
      '│ Warning: Argument is deprecated',
      '│',
      '│ namespace_name has been deprecated',
      '╵'
    ].join('\n')

    const { warnings } = extractDiagnostics(text)
    expect(warnings).toHaveLength(1)
  })

  it('finds nothing in clean plan output', () => {
    expect(extractDiagnostics('No changes.')).toEqual({
      warnings: [],
      errors: []
    })
  })
})

describe('countsFromPlanJson — real Terraform plan fixtures', () => {
  it('counts all 7 operations from the all-actions scenario fixture', async () => {
    const r = await analyzeStack({
      name: 'all-actions',
      plan_file: '__fixtures__/scenarios/all-actions/plan.txt',
      plan_json: '__fixtures__/scenarios/all-actions/plan.json'
    })
    expect(r.failed).toBe(false)
    expect(r.counts).toEqual({
      add: 2,
      change: 1,
      destroy: 1,
      replace: 2,
      import: 1,
      forget: 1,
      move: 1
    })
    expect(r.warnings).toHaveLength(1)
  })
})

describe('cleanPlanText', () => {
  // A realistic slice: refresh chatter (the bulk on a big stack), then the
  // actual execution plan and the Plan: summary line.
  const raw = [
    'module.cae.random_string.suffix: Refreshing state... [id=q1]',
    'module.cae.azurerm_role_assignment.this["east"]: Refreshing state... [id=/x]',
    'module.cae.data.azurerm_client_config.current: Reading...',
    'module.networking.azurerm_virtual_network.this: Refreshing state... [id=/subscriptions/abc/resourceGroups/x/providers/Microsoft.Network/virtualNetworks/y]',
    'module.cae.data.azurerm_client_config.current: Read complete after 0s [id=Y2xpZW50Q29uZmln]',
    'module.slow.data.azurerm_thing.this: Still reading... [10s elapsed]',
    '',
    'Terraform will perform the following actions:',
    '',
    '  # azurerm_resource_group.this will be created',
    '  + resource "azurerm_resource_group" "this" {',
    '      + name = "my-rg"',
    '    }',
    '',
    'Plan: 1 to add, 0 to change, 0 to destroy.'
  ].join('\n')

  it('drops refresh/read chatter and keeps the diff and summary', () => {
    const cleaned = cleanPlanText(raw)
    expect(cleaned).not.toMatch(/Refreshing state/)
    expect(cleaned).not.toMatch(/Reading\.\.\./)
    expect(cleaned).not.toMatch(/Read complete/)
    expect(cleaned).not.toMatch(/Still reading/)
    expect(cleaned).toContain('Terraform will perform the following actions:')
    expect(cleaned).toContain('# azurerm_resource_group.this will be created')
    expect(cleaned).toContain('Plan: 1 to add, 0 to change, 0 to destroy.')
  })

  it('cuts the bulk when refresh lines dominate', () => {
    // 500 refresh lines + a two-line diff: cleaned text is a tiny fraction.
    const noise = Array.from(
      { length: 500 },
      (_, i) =>
        `module.m.res_${i}: Refreshing state... [id=/subscriptions/s/resourceGroups/rg/providers/p/things/thing-${i}]`
    ).join('\n')
    const diff = 'Plan: 0 to add, 0 to change, 0 to destroy.'
    const cleaned = cleanPlanText(`${noise}\n\n${diff}`)
    expect(cleaned).toBe(diff)
    expect(cleaned.length).toBeLessThan(noise.length / 50)
  })

  it('leaves a diff with no refresh lines untouched (aside from trim)', () => {
    const plan = 'No changes. Your infrastructure matches the configuration.'
    expect(cleanPlanText(plan)).toBe(plan)
  })

  // Plan values are PR-author controlled: a value crafted to look like refresh
  // chatter must not be able to hide its own line from the displayed diff.
  it('keeps indented diff lines whose values mimic refresh chatter', () => {
    const plan = [
      'Terraform will perform the following actions:',
      '',
      '  # azurerm_storage_account.this will be updated in-place',
      '  ~ resource "azurerm_storage_account" "this" {',
      '      ~ tags = {',
      '          + "note" = "status: Refreshing state... do not trust this"',
      '          + "also" = "x: Reading... y: Read complete after 1s"',
      '        }',
      '    }',
      '',
      'Plan: 0 to add, 1 to change, 0 to destroy.'
    ].join('\n')
    expect(cleanPlanText(plan)).toBe(plan)
  })
})

describe('analyzeStack', () => {
  it('reads plan text, exact counts and warnings (framed format)', async () => {
    const r = await analyzeStack({
      name: 'monolith (dev)',
      plan_file: '__fixtures__/plans/warnings.txt',
      plan_json: '__fixtures__/plans/nochange.json'
    })
    expect(r.failed).toBe(false)
    expect(r.counts).toEqual(zeroCounts)
    expect(r.warnings).toHaveLength(1)
  })

  it('reads check-block warnings (unframed format, TF 1.5+)', async () => {
    const r = await analyzeStack({
      name: 'tf-test (test)',
      plan_file: '__fixtures__/plans/check-warnings.txt',
      plan_json: '__fixtures__/plans/nochange.json'
    })
    expect(r.failed).toBe(false)
    expect(r.warnings).toHaveLength(2)
    expect(r.errors).toHaveLength(0)
    expect(r.warnings[0]).toMatch(/owner_tag_required/)
    expect(r.warnings[1]).toMatch(/environment_tag_required/)
  })

  it('marks a stack failed when the plan file is missing', async () => {
    const r = await analyzeStack({
      name: 'gone',
      plan_file: '__fixtures__/plans/does-not-exist.txt',
      plan_json: '__fixtures__/plans/nochange.json'
    })
    expect(r.failed).toBe(true)
    expect(r.counts).toBeNull()
    expect(r.errorExcerpt).toMatch(/Plan file not found/)
  })

  it('marks a stack failed when the plan text contains an error', async () => {
    const r = await analyzeStack({
      name: 'broken',
      plan_file: '__fixtures__/plans/error.txt',
      plan_json: '__fixtures__/plans/nochange.json'
    })
    expect(r.failed).toBe(true)
    expect(r.errors).toHaveLength(1)
  })

  it('marks a stack failed when plan_json is missing', async () => {
    const r = await analyzeStack({
      name: 'missing-json',
      plan_file: '__fixtures__/plans/nochange.txt',
      plan_json: '__fixtures__/plans/does-not-exist.json'
    })
    expect(r.failed).toBe(true)
    expect(r.counts).toBeNull()
    expect(r.errorExcerpt).toMatch(/Plan JSON not found or invalid/)
  })
})

import {
  MAX_ADDRESS_LENGTH,
  MAX_WARNINGS_PER_STACK,
  MAX_WARNING_ADDRESSES,
  MAX_WARNING_SUMMARY_LENGTH,
  escapeMarkdown,
  inlineCode,
  parseWarning,
  payloadWarnings,
  renderStackWarnings
} from '../src/warnings.js'
import { analyzeStack, extractDiagnostics } from '../src/plan.js'

const ADDR_PRIVATE =
  'module.allowances_demo.module.container_app["private"].module.this.azapi_resource_action.post_creation_update'
const ADDR_KEEPER =
  'module.allowances_demo.module.container_app["private"].module.this.terraform_data.update_keeper'

const FORGET_WARNING = [
  'Warning: Some objects will no longer be managed by Terraform',
  '',
  'If you apply this plan, Terraform will discard its tracking information for',
  'the following objects, but it will not delete them:',
  ` - ${ADDR_PRIVATE}`,
  ` - ${ADDR_KEEPER}`
].join('\n')

function withBullets(...bullets: string[]): string {
  return ['Warning: Heads up', '', ...bullets.map((b) => ` - ${b}`)].join('\n')
}

describe('parseWarning', () => {
  it('reads the summary and listed addresses', () => {
    expect(parseWarning(FORGET_WARNING)).toEqual({
      summary: 'Some objects will no longer be managed by Terraform',
      addresses: [ADDR_PRIVATE, ADDR_KEEPER],
      omittedAddresses: 0
    })
  })

  it('parses a framed block as extracted from plan output', () => {
    const framed = [
      '╷',
      '│ Warning: Some objects will no longer be managed by Terraform',
      '│',
      '│ the following objects, but it will not delete them:',
      `│  - ${ADDR_KEEPER}`,
      '╵'
    ].join('\n')
    const { warnings } = extractDiagnostics(framed)
    expect(parseWarning(warnings[0])).toEqual({
      summary: 'Some objects will no longer be managed by Terraform',
      addresses: [ADDR_KEEPER],
      omittedAddresses: 0
    })
  })

  it('parses an unframed check-block warning with no addresses', () => {
    const { warnings } = extractDiagnostics(
      'Warning: Check block assertion failed\n\n  on main.tf line 3:\n  ├ x'
    )
    expect(parseWarning(warnings[0])).toEqual({
      summary: 'Check block assertion failed',
      addresses: [],
      omittedAddresses: 0
    })
  })

  it('accepts data sources, numeric indexes and keys with spaces', () => {
    const addresses = [
      'data.azurerm_client_config.current',
      'aws_instance.web[0]',
      'azurerm_x.y["a key with spaces"]',
      'module.m["k"].aws_s3_bucket.b'
    ]
    expect(parseWarning(withBullets(...addresses)).addresses).toEqual(addresses)
  })

  it('rejects file names and prose that merely contain a dot', () => {
    const w = withBullets(
      'main.tf',
      'terraform.tfvars',
      'e.g. see the docs',
      'run terraform fmt.',
      'Foo.bar'
    )
    expect(parseWarning(w)).toMatchObject({
      addresses: [],
      omittedAddresses: 0
    })
  })

  it('accepts addresses whose last segment looks like a file extension', () => {
    const addresses = [
      'aws_s3_bucket.tf',
      'terraform_data.json',
      'module.worker.aws_instance.txt'
    ]
    expect(parseWarning(withBullets(...addresses)).addresses).toEqual(addresses)
  })

  it('accepts an index key containing a closing bracket', () => {
    const address = 'aws_instance.web["prod]blue"]'
    expect(parseWarning(withBullets(address)).addresses).toEqual([address])
  })

  it('counts address-like bullets it rejects instead of dropping them silently', () => {
    const w = withBullets(
      'aws_x.ok',
      'aws_x.y["a\u200Bb"]',
      'aws_x.y["<b>"]',
      `aws_x.${'b'.repeat(500)}`
    )
    expect(parseWarning(w)).toMatchObject({
      addresses: ['aws_x.ok'],
      omittedAddresses: 3
    })
  })

  it('counts a bullet whose address root is interrupted by an invisible character', () => {
    for (const bullet of ['aws_x\u200B.y', 'module\u200B.a.b']) {
      const w = withBullets(bullet)
      expect(parseWarning(w)).toMatchObject({
        addresses: [],
        omittedAddresses: 1
      })
      expect(payloadWarnings([w]).truncated).toBe(true)
    }
  })

  it('does not rewrite a format character into a different valid address', () => {
    const parsed = parseWarning(withBullets('aws_instance.web["a\u200Bb"]'))
    expect(parsed.addresses).toEqual([])
    expect(parsed.omittedAddresses).toBe(1)
  })

  it('handles CRLF line endings', () => {
    const crlf = FORGET_WARNING.replace(/\n/g, '\r\n')
    expect(parseWarning(crlf)).toEqual(parseWarning(FORGET_WARNING))
  })

  it('captures how many similar warnings Terraform left out', () => {
    const w = `${withBullets('a_b.c')}\n\n(and 3 more similar warnings elsewhere)`
    expect(parseWarning(w).moreSimilar).toBe(3)
    expect(
      parseWarning('Warning: x\n(and one more similar warning elsewhere)')
        .moreSimilar
    ).toBe(1)
  })
})

describe('hostile input', () => {
  it('matches a pathological address line in linear time', () => {
    const started = Date.now()
    parseWarning(withBullets(`${'a_'.repeat(80000)}!`))
    parseWarning(withBullets(`${'a_'.repeat(150)}!`))
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('matches pathological quoted index keys quickly', () => {
    const started = Date.now()
    parseWarning(
      withBullets(
        `a_b.c["${'\\'.repeat(190)}`,
        `a_b.c["${'"'.repeat(380)}`,
        `a_b.c["${'\\"'.repeat(190)}x`,
        `a_b.c${'["a"]'.repeat(75)}!`,
        `a_b.c[${'"'.repeat(385)}`
      )
    )
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('rejects addresses that could carry HTML or a forged marker', () => {
    const w = withBullets(
      'a_b.c["<!-- tf-plan-report:data {} -->"]',
      'a_b.c["x`y"]',
      'a_b.c["</details>"]'
    )
    const md = renderStackWarnings([w])
    expect(parseWarning(w).addresses).toEqual([])
    expect(md).not.toContain('tf-plan-report')
  })

  it('flags warningsTruncated when an address line was omitted', () => {
    expect(
      payloadWarnings([withBullets('aws_x.y["a\u200Bb"]', 'aws_x.ok')])
    ).toMatchObject({
      truncated: true,
      warnings: [{ addresses: ['aws_x.ok'] }]
    })
  })

  it('does not set moreSimilar from an overflowing count', () => {
    const w = `Warning: x\n(and ${'9'.repeat(400)} more similar warnings elsewhere)`
    expect(parseWarning(w).moreSimilar).toBeUndefined()
  })

  it('strips bidi and other invisible characters from summaries and addresses', () => {
    const w = 'Warning: safe\u202Etext\u200Bhere\n\n - a_b.c\u202Ed'
    const parsed = parseWarning(w)
    expect(parsed.summary).not.toMatch(/[\u202E\u200B]/)
    expect(parsed.addresses).toEqual([])
    expect(renderStackWarnings([w])).not.toMatch(/[\u202E]/)
  })
})

describe('real Terraform output', () => {
  it('yields the forget warning summary and addresses through analyzeStack', async () => {
    const dir = '__fixtures__/scenarios/forget-warning'
    const stack = await analyzeStack({
      name: 'forget-warning',
      plan_file: `${dir}/plan.txt`,
      plan_json: `${dir}/plan.json`
    })

    expect(stack.counts?.forget).toBe(2)
    expect(stack.warnings).toHaveLength(1)
    expect(parseWarning(stack.warnings[0])).toEqual({
      summary: 'Some objects will no longer be managed by Terraform',
      addresses: [
        'module.container_app.terraform_data.update_keeper',
        'module.container_app.terraform_data.post_creation_update'
      ],
      omittedAddresses: 0
    })
  })
})

describe('payloadWarnings', () => {
  it('caps addresses per warning and flags truncation', () => {
    const lines = Array.from({ length: 13 }, (_, i) => `aws_x.r${i}`)
    const { warnings, truncated } = payloadWarnings([withBullets(...lines)])
    expect(warnings[0].addresses).toHaveLength(MAX_WARNING_ADDRESSES)
    expect(truncated).toBe(true)
  })

  it('caps warnings per stack and flags truncation', () => {
    const texts = Array.from(
      { length: MAX_WARNINGS_PER_STACK + 2 },
      (_, i) => `Warning: w${i}`
    )
    const { warnings, truncated } = payloadWarnings(texts)
    expect(warnings).toHaveLength(MAX_WARNINGS_PER_STACK)
    expect(truncated).toBe(true)
  })

  it('drops an over-long address instead of clipping it', () => {
    const long = `aws_x.${'b'.repeat(MAX_ADDRESS_LENGTH)}`
    const { warnings, truncated } = payloadWarnings([
      withBullets(long, 'aws_x.ok')
    ])
    expect(warnings[0].addresses).toEqual(['aws_x.ok'])
    expect(truncated).toBe(true)
  })

  it('clips an over-long summary and flags truncation', () => {
    const { warnings, truncated } = payloadWarnings([
      `Warning: ${'x'.repeat(500)}`
    ])
    expect(warnings[0].summary).toHaveLength(MAX_WARNING_SUMMARY_LENGTH)
    expect(truncated).toBe(true)
  })

  it('does not split a surrogate pair when clipping', () => {
    const { warnings } = payloadWarnings([
      `Warning: ${'😀'.repeat(MAX_WARNING_SUMMARY_LENGTH + 5)}`
    ])
    expect(warnings[0].summary).toBe(
      `${'😀'.repeat(MAX_WARNING_SUMMARY_LENGTH - 1)}…`
    )
  })

  it('carries moreSimilar and is not truncated within the caps', () => {
    const { warnings, truncated } = payloadWarnings([
      `${FORGET_WARNING}\n(and 2 more similar warnings elsewhere)`
    ])
    expect(warnings[0].moreSimilar).toBe(2)
    expect(truncated).toBe(false)
  })
})

describe('escaping', () => {
  it('backslash-escapes the characters that would start markdown or HTML', () => {
    const out = escapeMarkdown('`x` </details> | [a](b) *c* #1')
    for (const raw of ['`', '<', '>', '|', '[', ']', '*', '#']) {
      expect(out.replace(/\\./g, '')).not.toContain(raw)
    }
  })

  it('puts a zero-width space after @ so a mention cannot ping', () => {
    expect(escapeMarkdown('ping @octocat')).toBe('ping @​octocat')
  })

  it('fences inline code longer than any backtick run inside', () => {
    expect(inlineCode('a["``"]')).toMatch(/^``` .* ```$/)
  })
})

describe('renderStackWarnings', () => {
  it('shows the summary in bold and each address in a code span', () => {
    const md = renderStackWarnings([FORGET_WARNING])
    expect(md).toContain(
      '**Some objects will no longer be managed by Terraform**'
    )
    expect(md).toContain(`\` ${ADDR_PRIVATE} \``)
    expect(md).toContain(`\` ${ADDR_KEEPER} \``)
  })

  it('keeps hostile summary and address text inside bold and code', () => {
    const md = renderStackWarnings([
      'Warning: </details> @user `x` | y\n\n - a_b.c["it\'s | a*b"]'
    ])
    const [summaryLine, addressLine] = md.split('\n')
    expect(summaryLine).toMatch(/^- \*\*.*\*\*$/)
    expect(summaryLine).not.toMatch(/(^|[^\\])[<>`|]/)
    expect(summaryLine).toContain('@​user')
    expect(addressLine).toBe('  - ` a_b.c["it\'s | a*b"] `')
  })

  it('says how many addresses, similar warnings and warnings were left out', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `a_b.r${i}`)
    const texts = [
      `${withBullets(...lines)}\n(and 4 more similar warnings elsewhere)`,
      ...Array.from({ length: MAX_WARNINGS_PER_STACK }, () => 'Warning: more')
    ]
    const md = renderStackWarnings(texts)
    expect(md).toContain('and 2 more')
    expect(md).toContain('and 4 more similar')
    expect(md).toContain('- and 1 more warning')
  })

  it('counts omitted address lines in "and N more"', () => {
    const md = renderStackWarnings([
      withBullets('aws_x.ok', 'aws_x.y["a\u200Bb"]', 'aws_x.y["<b>"]')
    ])
    expect(md).toContain('and 2 more')
  })

  it('omits addresses when asked for summaries only', () => {
    const md = renderStackWarnings([FORGET_WARNING], false)
    expect(md).toContain('Some objects will no longer')
    expect(md).not.toContain('module.allowances_demo')
  })
})

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as core from '@actions/core'
import type {
  PlanMeta,
  Section,
  SectionEscalation,
  SectionLegend,
  SectionStatus,
  StackInput
} from './types.js'

const NATIVE_SECTIONS = ['summary', 'plan', 'warnings', 'errors'] as const
export type NativeSection = (typeof NATIVE_SECTIONS)[number]

const SECTION_STATUSES: readonly SectionStatus[] = ['pass', 'warn', 'fail']
const SECTION_ESCALATIONS: readonly SectionEscalation[] = ['warn', 'fail']

export interface Inputs {
  stacks: StackInput[]
  sections: Section[]
  show: NativeSection[]
  githubToken: string
  commentMarker: string
}

export async function getInputs(): Promise<Inputs> {
  const plansDir = core.getInput('plans-dir', { required: true })
  const sectionsDir = core.getInput('sections-dir')

  return {
    stacks: await stacksFromPlansDir(plansDir),
    sections: sectionsDir ? await sectionsFromDir(sectionsDir) : [],
    show: parseShow(core.getInput('show') || 'summary,plan,warnings,errors'),
    githubToken: core.getInput('github-token'),
    commentMarker: core.getInput('comment-marker') || '<!-- tf-plan-report -->'
  }
}

/**
 * Parse custom-section JSON files from a directory (recursively — the layout
 * actions/download-artifact produces has one subdir per artifact). Each file is
 * one section; `markdown` is later rendered verbatim. Fails fast on a malformed
 * file: a broken section file is a broken producer, not a run outcome.
 */
export async function sectionsFromDir(dir: string): Promise<Section[]> {
  let files: string[]
  try {
    files = await jsonFilesIn(dir)
  } catch {
    throw new Error(
      `sections-dir not found: ${dir}. Did the actions/download-artifact step run before this action?`
    )
  }

  const sections: Section[] = []
  for (const file of files.sort()) {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      throw new Error(`Could not read section file ${file}.`)
    }

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error(`Invalid JSON in section file ${file}.`)
    }

    sections.push(parseSection(obj, file))
  }
  return sections
}

function parseSection(obj: Record<string, unknown>, file: string): Section {
  const str = (k: string): string => {
    const v = obj[k]
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(
        `Section file ${file}: \`${k}\` must be a non-empty string`
      )
    }
    return v
  }

  const section = str('section')
  const title = str('title')
  const stack = str('stack')
  const markdown = str('markdown')

  if (typeof obj.order !== 'number') {
    throw new Error(`Section file ${file}: \`order\` must be a number`)
  }

  const status = (obj.status ?? 'pass') as SectionStatus
  if (!SECTION_STATUSES.includes(status)) {
    throw new Error(
      `Section file ${file}: \`status\` must be one of ${SECTION_STATUSES.join(', ')}`
    )
  }

  const legend = parseLegend(obj.legend, file)
  if (!legend[status]) {
    throw new Error(
      `Section file ${file}: \`legend\` must include an entry for its own status "${status}"`
    )
  }

  const escalate = (obj.escalate ?? 'warn') as SectionEscalation
  if (!SECTION_ESCALATIONS.includes(escalate)) {
    throw new Error(
      `Section file ${file}: \`escalate\` must be one of ${SECTION_ESCALATIONS.join(', ')}`
    )
  }

  return {
    section,
    title,
    order: obj.order,
    stack,
    status,
    escalate,
    label: typeof obj.label === 'string' ? obj.label : undefined,
    legend,
    table_column:
      obj.table_column === undefined ? true : obj.table_column === true,
    markdown
  }
}

/**
 * Validate the `legend` map: an object keyed by status (`pass`/`warn`/`fail`),
 * each value a non-empty string, at least one entry. Rejects unknown keys and
 * non-objects so a malformed legend fails loudly rather than silently dropping
 * the per-status meaning.
 */
function parseLegend(v: unknown, file: string): SectionLegend {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(
      `Section file ${file}: \`legend\` must be an object mapping status to meaning, e.g. {"pass":"…","fail":"…"}`
    )
  }
  const legend: SectionLegend = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!SECTION_STATUSES.includes(k as SectionStatus)) {
      throw new Error(
        `Section file ${file}: \`legend\` has unknown key "${k}" (allowed: ${SECTION_STATUSES.join(', ')})`
      )
    }
    if (typeof val !== 'string' || val.trim() === '') {
      throw new Error(
        `Section file ${file}: \`legend.${k}\` must be a non-empty string`
      )
    }
    legend[k as SectionStatus] = val
  }
  if (Object.keys(legend).length === 0) {
    throw new Error(
      `Section file ${file}: \`legend\` must define at least one of ${SECTION_STATUSES.join(', ')}`
    )
  }
  return legend
}

/** All *.json files under dir, recursively. */
async function jsonFilesIn(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await jsonFilesIn(full)))
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full)
  }
  return out
}

/**
 * Build the stack list from a directory of downloaded plan artifacts, one
 * subdirectory per stack (the layout actions/download-artifact produces). Each
 * subdirectory must contain meta.json (which names the stack), plan.txt, and
 * plan.json. This is the only way stacks enter the action — the same path CI
 * runs, so tests and fixtures exercise it directly.
 *
 * Fails fast on structural problems — a missing directory or meta.json means a
 * broken pipeline, not a run outcome. Missing or partial plan files are left to
 * analyzeStack, which records them as a failed stack so a leg that failed to
 * plan still appears in the report.
 */
export async function stacksFromPlansDir(dir: string): Promise<StackInput[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    throw new Error(
      `plans-dir not found: ${dir}. Did the actions/download-artifact step run before this action?`
    )
  }

  const subdirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  if (subdirs.length === 0) {
    throw new Error(
      `plans-dir "${dir}" has no plan artifacts. Expected one subdirectory per stack from actions/download-artifact.`
    )
  }

  const stacks: StackInput[] = []
  for (const name of subdirs) {
    const base = join(dir, name)
    const metaPath = join(base, 'meta.json')

    let raw: string
    try {
      raw = await readFile(metaPath, 'utf8')
    } catch {
      throw new Error(
        `Missing meta.json in ${base}. Every plan artifact must include meta.json with a string "stack" field.`
      )
    }

    let meta: Partial<PlanMeta>
    try {
      meta = JSON.parse(raw) as Partial<PlanMeta>
    } catch {
      throw new Error(`Invalid JSON in ${metaPath}.`)
    }

    if (typeof meta.stack !== 'string' || meta.stack.trim() === '') {
      throw new Error(
        `${metaPath} must contain a non-empty string "stack" field.`
      )
    }

    stacks.push({
      name: meta.stack,
      plan_file: join(base, 'plan.txt'),
      plan_json: join(base, 'plan.json')
    })
  }

  return stacks
}

export function parseShow(raw: string): NativeSection[] {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

  const invalid = parts.filter(
    (p) => !NATIVE_SECTIONS.includes(p as NativeSection)
  )
  if (invalid.length > 0) {
    throw new Error(
      `unknown section(s) in \`show\`: ${invalid.join(', ')}. ` +
        `Valid sections: ${NATIVE_SECTIONS.join(', ')}`
    )
  }
  return parts as NativeSection[]
}

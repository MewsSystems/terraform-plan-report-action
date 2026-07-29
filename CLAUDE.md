# CLAUDE.md

Working instructions for this repo. Read before changing code.

## What this is

A **fan-in GitHub Action** that aggregates N Terraform matrix plan legs into one
PR comment + job summary report. Plan legs upload artifacts and post nothing;
this action downloads them, renders one report, and upserts a single sticky
comment. See [`README.md`](./README.md) for the user-facing contract.

Core principles:

**Plan-derived and deterministic.** The same plans must render the same report.
Every count, status, label, and column is read from `plan.txt` (diagnostics) or
`plan.json` (`resource_changes[].change.actions`, `importing`, `moved`). Nothing
is inferred, guessed, or hard-coded. The AI block is the only non-deterministic
part: labelled advisory, appended last, zero authority over any reported fact.

**Use plain verbs, no operator symbols.** Count + verb only: `1 add`,
`2 change`, `1 destroy`, `1 replace (destroy+create)`, `1 import`, `1 remove`,
`1 move`. Never prefix with `+`, `-`, `~`, `±`, or any other operator symbol —
the verb already carries the meaning, symbols add noise and mislead skimmers.
Use `·` (middle dot) as the separator between counts, never `-` (which reads as
subtraction). Bold `destroy` and `replace` counts to surface destructive
operations; leave the rest plain. Use `replace (destroy+create)` rather than
bare `replace` — the parenthetical clarifies that recreation happens, which
"replace" alone obscures for non-Terraform practitioners.

**Render as a senior UX designer.** The report is read by engineers under time
pressure during code review, many not fluent in Terraform. Approach every
display decision that way — clarity for the skimmer first. Rules:

- Emoji as status signal only (`⚠️` warnings, `❌` failures). Never decorative.
- Show only what has signal: omit zero-count columns from the matrix table, omit
  a callout when there is nothing to call out.
- **Grids are icon-only; the meaning goes where there's room for text.** Cells
  show the icon (+ a count where it's real info), never the status word. What an
  icon _means_ is spelled out in plain English elsewhere — inline in the
  summary's per-stack detail rows (`stack · ❌ missing or invalid tags`) and as
  a one-line "what each check means" list in the comment — sourced from each
  section's `legend` (and, for plan status, the operations context).
- **Explain an icon exactly once.** Never leave an icon unexplained where
  there's room to explain it, and never explain it twice (once generically, once
  specifically). Don't restate what an adjacent legend already says: `❌`, not
  `❌ Plan failed`, when a legend sits right beside the table.
- **Never explain an icon that isn't shown.** Legends list only the statuses
  actually present in the table they explain — an all-green Checks column gets
  just its ✅ phrase, and a legend line with nothing visible to explain is
  omitted entirely (e.g. the plan-result line when every Status cell is a plain
  count rollup).
- One call to action: a single **Full report →** link (folded into the footer),
  not a third alert box competing with the CAUTION/IMPORTANT callouts.
- Plain section headings, no emoji in headings.
- Footer is a single line: the comment leads with the **Full report →** link,
  then commit SHA + usage docs; the summary is commit SHA + usage docs.
- **Never repeat information across columns.** The job-summary operations table
  shows per-op count columns + a plain plan-health icon (`Plan`), not a rollup
  that restates the columns. The verbose per-stack rollup lives only in the
  comment (its `Status` column), where the counts aren't otherwise shown.

**Custom sections are opaque add-ons.** Tags, policy, cost, drift are not built
in — upstream jobs drop self-describing JSON (`sections-dir`) and the action
groups/orders/renders them without interpreting content. Keep the two concerns
separate: Terraform operations (which the action understands) render in their
own table; custom sections render in a distinct **Checks** table (one column per
`table_column` section, joined to stacks by the mandatory `stack` field) plus
per-section detail blocks (Checks cells are icon-only: ✅ `pass`, ⚠️ `warn`, ❌
`fail`, `—` = no result for that stack). `status` is one of exactly three
(`pass|warn|fail`, default `pass`); `escalate` (`warn|fail`, default `warn`) is
the per-section threshold that fires the callout, so each section owns its own
attention policy without the action knowing what it means. The mandatory
`legend` map (`{pass,warn,fail}` → plain English) is what the action shows for
the icon's meaning — inline per stack in the summary detail, and as a one-line
list in the comment. `label` is a legacy free-form value, superseded by `legend`
and kept only as a fallback. Do not teach the action what any specific section
_means_ — that coupling is the whole thing this design avoids.

## Stack

- **TypeScript** action on the
  [`actions/typescript-action`](https://github.com/actions/typescript-action)
  template. Node 24, ESM (`"type": "module"`, `.js` import specifiers).
- Bundled with **rollup** into `dist/index.js` — this is what GitHub runs.
- **Jest** + `ts-jest` for tests. ESLint + Prettier for style.
- Entry: `src/index.ts` -> `src/main.ts#run()`. Keep `index.ts` a thin entry;
  put logic in `main.ts` and focused modules it calls.

## Action best practices

- **`action.yml` is the contract.** Every input needs a `description`; mark
  `required` honestly and give safe `default`s. Don't rename or remove
  inputs/outputs without a major version bump — callers pin to tags.
- **Inputs/outputs via the toolkit.** Read with `core.getInput`, write with
  `core.setOutput`. Never parse `process.argv`. Booleans via
  `core.getBooleanInput`.
- **Fail loud and clear.** On error call `core.setFailed(message)` with an
  actionable message (e.g. "`plans-dir` not found" or "section file X: `legend`
  must be an object"). Don't throw raw stack traces at users.
- **Least privilege.** Document required `permissions` (`pull-requests: write`
  to comment, `contents: read`). Never request more.
- **Secrets never logged.** `core.setSecret` anything sensitive; keep API keys
  out of logs and out of the rendered report.
- **`if: always()` semantics.** This action runs on failed legs too. Handle
  missing / partial / failed-plan artifacts gracefully — a failed plan must
  still appear in the report, never crash it.
- **Treat plan content as untrusted.** Resource names, tags, and values are
  PR-author controlled. Don't `eval`, don't interpolate into shell, sanitize
  before sending anything to the AI (keep address + action + replace-forcing
  attr names, drop values).
- **Idempotent comment.** Find by `comment-marker` and PATCH; only POST when
  absent. One report job, no concurrency, no races.
- **Respect GitHub limits.** PR comment cap is 64 KiB; job summary is 1 MiB.
  Full per-stack plans live in the summary, the comment links to it.
- **Pin third-party uses by SHA** in our own workflows.

## dist/ must stay in sync

`dist/index.js` is committed and is what runs. After any `src/` or dependency
change:

```bash
npm run package   # or: npm run all
git add dist
```

The `check-dist` workflow rebuilds and fails the PR if `dist/` is stale. This is
the most common CI failure — do it before pushing.

## Tests

- **Always ship with test coverage.** Every change to shipped behaviour lands in
  the same commit as tests that cover it. No "tests later." A feature or fix
  without tests is not done.
- **Test the path you ship, not a parallel one.** Tests must exercise the real
  code path production runs. Stacks enter the action through exactly one door —
  `plans-dir` (scan a directory of downloaded artifacts, one subdir per stack,
  each with `meta.json` + `plan.txt` + `plan.json`); the stack name comes only
  from `meta.json`. There is no `stacks` input and no second ingestion path to
  drift out of sync. Do not reintroduce a convenience input that tests use but
  CI does not.
- **Fixtures are the documentation.** Test fixtures live in the canonical
  artifact layout (`__fixtures__/plans-dir/`, `__fixtures__/scenarios/`) so they
  double as a worked example of what a plan leg must upload. Keep them real:
  generate from actual plans, never hand-craft `plan.json` (see below).
- Co-locate under `__tests__/`, one `*.test.ts` per source module.
- **Unit-first and deterministic.** Mock the GitHub toolkit and any network.
  Stub `@actions/core` (see `__fixtures__/`); assert on `setOutput` /
  `setFailed` calls. No real API calls, no real network — including the AI path
  (mock the client).
- **Cover the rendering core hard.** It's pure (plans in, markdown out): use
  fixture plan files in `__fixtures__/` and snapshot the rendered report. Cover
  exact-count (plan_json) vs regex-fallback (text only), failed plans, empty
  sections, and the 64 KiB compact-view trimming.
- **All 7 operations must be tested end-to-end.** There must always be a test
  that runs `analyzeStack` against `__fixtures__/scenarios/all-actions/` and
  asserts every count (`add`, `change`, `destroy`, `replace`, `import`,
  `forget`, `move`) is non-zero and correct. There must also be render tests
  that assert every operation appears in the operations-table column headers,
  and that the verbose per-stack rollup (with the correct verb and code-font
  format) appears in the **comment's** Status column. If you add or rename an
  operation, update both the fixture and these tests.
- **Never hand-craft `plan.json` fixture files.** The Terraform plan JSON format
  has subtle field placements that are impossible to get right without running a
  real plan (e.g. `importing` lives inside `change{}`, moves use
  `previous_address` in `resource_changes` not a top-level array). Always
  generate fixtures from a real `terraform show -json plan.tfplan` and copy the
  output verbatim. If you cannot run a real plan, state that explicitly and
  leave a `TODO` rather than inventing the format.
- **The AI block is additive.** A test must prove that with AI off, or when the
  AI call fails, the report equals the deterministic step-4 output exactly.
- Keep coverage meaningful, not just green; the badge is regenerated by
  `npm run coverage`.
- Run `npm test` (or `npm run ci-test`) before every push.

## Workflow before pushing

1. `npm run all` — format, lint, test, coverage, package.
1. Confirm `dist/` is staged.
1. Per the repo owner's rule: **draft only.** Don't commit, push, tag, or open a
   PR unless explicitly asked. When work is ready, say so and stop.

## Versioning

Semver tags; callers pin `@v1`. Breaking changes to `action.yml` inputs/outputs
are a major bump. `script/release` tags releases and syncs the moving major tag.

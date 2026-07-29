# terraform-plan-report-action

One PR comment for all Terraform stacks, updated in place.

A fan-in GitHub Action that aggregates N matrix plan legs into a single report:
a compact sticky PR comment (operations table, Checks table, callouts) that
links to the one full report rendered in the run's job summary.

It replaces per-matrix comment sprawl. A matrix that plans N stacks and posts a
comment per section (plan + tags + policy + warnings) floods a PR with dozens of
comments; this action posts one.

## Reading the report

| Count in report                  | Meaning                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `N add`                          | N resources will be **created**                                                                                                |
| `N change`                       | N resources will be **updated in-place** (no recreation)                                                                       |
| **`N destroy`**                  | N resources will be **permanently deleted**                                                                                    |
| **`N replace (destroy+create)`** | N resources will be **deleted then recreated** — triggered by an immutable property change (e.g. resource group location)      |
| `N import`                       | N resources will be **imported** into Terraform state without any Azure change                                                 |
| `N remove`                       | N resources will be **removed from Terraform state** but left untouched in Azure (`removed { lifecycle { destroy = false } }`) |
| `N move`                         | N resources will be **renamed** in Terraform state via a `moved` block — no Azure change                                       |

### Status column

| Status               | Meaning                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅ No changes        | Infrastructure matches the configuration                                                                                                                                 |
| `1 add · 2 change …` | Plan succeeded with the listed changes                                                                                                                                   |
| ⚠️ N                 | Plan succeeded but Terraform raised N warnings (e.g. [check block](https://developer.hashicorp.com/terraform/language/checks) assertions, deprecated provider arguments) |
| ❌                   | Terraform could not produce a plan; expand the **Errors** / **Plan details** section for the cause                                                                       |

Cells are icon-forward (the summary's Plan column is icon-only; the comment's
Status column also carries the change rollup). What each icon means is spelled
out in the report itself, next to the table.

### Destructive changes

**destroy** and **replace (destroy+create)** permanently delete cloud resources.
When a plan contains either, a caution block appears below the summary table —
always expand **Plan details** to confirm which resources are affected before
approving.

## How it works

```text
tf-plan (matrix, per stack):  init -> plan -> show -json -> write meta.json -> upload artifact
        |
tf-report (one job):  needs: [tf-plan]  if: always()
        | download all plan artifacts into plans/  ->  aggregate  ->  one report
        | full report -> job summary  +  compact view -> sticky PR comment
```

Plan legs stay in the matrix and post nothing. Each leg uploads an artifact
holding three files — `plan.txt`, `plan.json`, and `meta.json`. One report job
downloads them all and renders everything. `if: always()` keeps a failing leg in
the report.

### The plan artifact contract

Each plan leg uploads one artifact whose contents are:

| File        | Produced by                        | Purpose                                          |
| ----------- | ---------------------------------- | ------------------------------------------------ |
| `plan.txt`  | `terraform plan … \| tee plan.txt` | Diagnostics (warnings/errors) + full plan detail |
| `plan.json` | `terraform show -json plan.tfplan` | Exact operation counts                           |
| `meta.json` | the leg (`jq`)                     | `{ "stack": "<name>" }` — names the stack        |

`meta.json` is **mandatory** and is the sole source of the stack's display name
— the action never infers it from the artifact or directory name. Extend it
additively (`order`, `priority`, …) later without changing anything else.

> [!IMPORTANT] Capture `plan.txt` from the **live** plan
> (`terraform plan … | tee plan.txt`), not `terraform show -no-color`.
> `terraform show` on a saved plan file silently drops check-block warnings; the
> live output preserves them.

## Content model

1. **Terraform-native core** (opt-in via `show`): `summary`, `plan`, `warnings`,
   `errors`. The only tier that understands Terraform.
1. **Custom sections** (opaque): upstream jobs drop JSON section files; the
   action groups, orders, and renders their markdown verbatim. Tags, policy,
   cost, drift are just sections, not built in.

## Usage

### Producer — the plan leg (matrix)

```yaml
tf-plan:
  strategy:
    matrix:
      env: [dev, demo, prod]
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: hashicorp/setup-terraform@v3

    - name: Plan
      working-directory: ${{ matrix.env }}
      run: |
        set -o pipefail
        terraform init
        terraform plan -no-color -out plan.tfplan 2>&1 | tee plan.txt
        terraform show -json plan.tfplan > plan.json

    - name: Write meta.json
      if: always() # a failed leg still reports, so its meta.json must exist
      working-directory: ${{ matrix.env }}
      run: |
        jq -n --arg stack "${{ vars.SERVICE_NAME }}-${{ matrix.env }}" \
          '{ stack: $stack }' > meta.json

    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: tf-plan-${{ vars.SERVICE_NAME }}-${{ matrix.env }}
        path: |
          ${{ matrix.env }}/plan.txt
          ${{ matrix.env }}/plan.json
          ${{ matrix.env }}/meta.json
        if-no-files-found: warn
```

### Consumer — the report job

```yaml
tf-report:
  needs: [tf-plan]
  if: ${{ always() }}
  runs-on: ubuntu-latest
  permissions: { contents: read, pull-requests: write }
  steps:
    - uses: actions/download-artifact@v4
      with: { pattern: tf-plan-*, path: plans }
    # Optional: download custom-section artifacts (tags, policy, cost, …).
    - uses: actions/download-artifact@v4
      with: { pattern: section-*, path: sections }
    - uses: MewsSystems/terraform-plan-report-action@v1
      with:
        plans-dir: plans
        sections-dir: sections # omit if you have no custom sections
        show: summary,plan,warnings,errors
```

The `pattern` filter matters only to the caller — it keeps `plans/` to plan
artifacts (so future `section-*` artifacts land elsewhere). The action ignores
artifact names entirely; it reads each subdirectory's `meta.json` for the stack
name.

**Fail-fast vs graceful.** The action fails the whole run (with an actionable
message) on structural problems that mean a broken pipeline: `plans-dir`
missing, no subdirectories, a subdirectory with no `meta.json`, or a `meta.json`
without a string `stack`. It stays graceful on run outcomes: a leg that failed
to plan (missing or partial `plan.txt`/`plan.json`) is recorded as a failed
stack and still appears in the report.

### Inputs

| Input            | Required | Default                        | Description                                                                                                                       |
| ---------------- | -------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `plans-dir`      | yes      |                                | Directory of downloaded plan artifacts, one subdir per stack (`meta.json` + `plan.txt` + `plan.json`). The sole source of stacks. |
| `show`           | no       | `summary,plan,warnings,errors` | Native sections to render, in order.                                                                                              |
| `sections-dir`   | no       |                                | Directory of custom-section JSON files (add-ons: tags, policy, cost, drift). Absent = Terraform-native report only.               |
| `github-token`   | no       | `${{ github.token }}`          | Token used to upsert the comment.                                                                                                 |
| `comment-marker` | no       | `<!-- tf-plan-report -->`      | Hidden marker used to find and update the comment.                                                                                |

### Outputs

| Output          | Description                                      |
| --------------- | ------------------------------------------------ |
| `has-destroys`  | true if any stack destroys (plan-derived).       |
| `has-replaces`  | true if any stack replaces (plan-derived).       |
| `failed-stacks` | count of stacks whose plan failed.               |
| `comment-id`    | The upserted comment id.                         |
| `summary-url`   | Link to the run's job summary (the full report). |

### Custom sections (add-ons)

Add-ons — tags, policy, cost, drift — are not built in. Upstream jobs drop one
self-describing JSON file per section (one per stack) into `sections-dir`; the
action groups, orders, and renders them. The action never interprets the
content, which is why each file carries its own metadata.

```json
{
  "section": "cost",
  "title": "Cost",
  "order": 20,
  "stack": "monolith-prod",
  "status": "warn",
  "escalate": "fail",
  "legend": {
    "pass": "no increase",
    "warn": "cost goes up",
    "fail": "large increase"
  },
  "table_column": true,
  "markdown": "| Resource | Monthly |\n|---|---|\n| storage | $340 |"
}
```

Everything is per-stack — one file per (section, stack). There are no global or
cross-stack fields.

| Field          | Required | Default | Role                                                                                                                                                                                                                                               |
| -------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `section`      | yes      |         | Machine id; files sharing it become one **Checks** column.                                                                                                                                                                                         |
| `title`        | yes      |         | Column header + detail heading.                                                                                                                                                                                                                    |
| `order`        | yes      |         | Column + detail order (lower first).                                                                                                                                                                                                               |
| `stack`        | yes      |         | Join key — must match a stack's `meta.json` `stack`.                                                                                                                                                                                               |
| `markdown`     | yes      |         | Full detail, rendered **verbatim** in the job summary.                                                                                                                                                                                             |
| `status`       | no       | `pass`  | `pass` ✅ \| `warn` ⚠️ \| `fail` ❌. The only three states.                                                                                                                                                                                        |
| `legend`       | yes      |         | Per-status meaning map, e.g. `{"pass":"…","warn":"…","fail":"…"}`. Each present value a non-empty string; **must include the status this file reports**. Drives the plain-English meaning shown for the stack (e.g. `❌ missing or invalid tags`). |
| `escalate`     | no       | `warn`  | Lowest status that fires the callout. `warn` = warn+fail escalate; `fail` = only fail (a warn shows but doesn't nag). Per-section policy, e.g. cost `fail`, tags `warn`.                                                                           |
| `label`        | no       |         | Optional free-form value. Superseded by `legend` for the per-stack meaning, so it's only a fallback — most producers omit it.                                                                                                                      |
| `table_column` | no       | `true`  | Promote to a per-stack **Checks** column; `false` = detail-only.                                                                                                                                                                                   |

**How it renders (both surfaces):**

- A **Checks** table — one column per `table_column` section, one row per stack.
  Cells are **icon only**: ✅ `pass`, ⚠️ `warn`, ❌ `fail`, and `—` when the
  section produced no result for that stack. The Terraform operations table
  stays separate.
- The **meaning** of the icons comes from `legend`, shown where there's room for
  it: the comment lists it once under the table (**What each check means**),
  covering only the statuses that actually appear in that check's column — an
  all-green column gets just its ✅ phrase; the job summary spells it out inline
  in each stack's detail row (e.g. `monolith-dev · ❌ missing or invalid tags`).
- An `[!IMPORTANT]` callout naming the sections that need attention, **each
  linked to its detail**. A section escalates per its own `escalate` threshold
  (worst-wins across its stacks).
- The job summary additionally renders a detail block per section (the
  `markdown`, verbatim).

## Development

This is a Node.js (TypeScript) action bundled into `dist/`. See
[`CLAUDE.md`](./CLAUDE.md) for conventions.

### Prerequisites

Node.js `24.4.0` (pinned in [`.node-version`](./.node-version)). With `fnm` or
`nodenv`, `cd` into the repo to switch automatically; otherwise install that
version. Then:

```bash
npm install
```

### Build

```bash
npm run package        # rebuild dist/index.js (the bundled artifact)
npm run package:watch  # rebuild on change
```

> [!IMPORTANT] `dist/index.js` is the artifact GitHub runs. Always
> `npm run package` and commit `dist/` with your source change; the `check-dist`
> workflow fails the PR otherwise.

### Test

```bash
npm test                       # run all unit tests with coverage
npm run ci-test                # same, used in CI
npm test -- plan.test.ts       # run a single test file
npm test -- -u                 # update snapshots after intended render changes
```

Tests live in `__tests__/` (one file per source module). The GitHub toolkit is
mocked via `__fixtures__/`; the action is exercised through the same `plans-dir`
scan CI runs, against real fixture trees in `__fixtures__/plans-dir/` and
`__fixtures__/scenarios/` (each subdir is a stack: `meta.json` + `plan.txt` +
`plan.json`). Those fixtures double as worked examples of the artifact layout.

### Lint and format

```bash
npm run lint           # eslint
npm run format:check   # prettier, check only
npm run format:write   # prettier, write
```

### Run locally

[`@github/local-action`](https://github.com/github/local-action) runs the action
without pushing. Copy `.env.example` to `.env` (already wired to the fixture
`plans-dir`) and run:

```bash
cp .env.example .env
npm run local-action
```

This exercises the job-summary path and writes it to the file set by
`GITHUB_STEP_SUMMARY` in `.env`. The sticky PR comment only posts when the
action runs on a real pull request, so it is skipped locally.

### Preview the report (no Terraform needed)

To see both surfaces — the full report **and** the PR comment — without a pull
request, render them straight to files:

```bash
npm run preview   # writes preview-summary.md and preview-comment.md
```

By default it renders the bundled `__fixtures__/plans-dir` **and**
`__fixtures__/sections`, so you see the whole report — operations table, Checks
table + per-check glossary, and section detail. Open the two files in a Markdown
preview to see exactly what gets posted. Other views:

```bash
PLANS_DIR=__fixtures__/scenarios npm run preview   # full 7-operation spread (no sections)
npm run preview -- monolith-dev                    # only these stacks by name
PLANS_DIR=path SECTIONS_DIR=path npm run preview    # your own downloaded artifacts
```

### Generate real plans

Any Terraform dir produces the three files a plan artifact carries. Lay them out
one directory per stack (`<stack>/plan.txt`, `plan.json`, `meta.json`) and point
`PLANS_DIR` at the parent:

```bash
terraform plan -no-color -out plan.tfplan 2>&1 | tee plan.txt   # live output preserves check-block warnings
terraform show -json plan.tfplan > plan.json                     # exact counts
jq -n --arg stack my-stack '{ stack: $stack }' > meta.json       # names the stack
```

No cloud credentials are required to try it out: a throwaway dir using the
`hashicorp/random` or `hashicorp/null` provider plans real resources offline.

### One-shot

```bash
npm run all   # format:write, lint, test, coverage badge, package
```

Run this before pushing.

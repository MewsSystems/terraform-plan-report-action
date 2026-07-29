# Contributing

Thanks for your interest in improving `terraform-plan-report-action`! 🎉
Contributions — bug reports, docs, tests, and code — are welcome.

This guide covers **how to contribute and how we work**: the fork-and-PR
workflow, testing requirements, commit conventions, and how releases reach the
GitHub Actions Marketplace. For build/test/lint commands see
[README → Development](README.md#development); for architecture and
project-specific invariants see [`CLAUDE.md`](CLAUDE.md).

> **Important — project status & support.** This action is developed and used in
> production at **Mews**, and maintained in the open under
> [Apache-2.0](LICENSE). We welcome external contributions and will make a
> **best-effort** to triage and review them, but we **cannot commit to any SLA**
> on response or review times, and we may decline changes that don't fit the
> project's direction. Opening an issue to discuss non-trivial work first is the
> best way to avoid wasted effort.

## Before you start

- **Search existing [issues](../../issues) and [pull requests](../../pulls)**
  first to avoid duplicate work.
- **Open an issue to discuss** anything non-trivial (new input/output, behavior
  change, rendering change) **before** writing code. Small fixes and docs can go
  straight to a PR.
- By contributing, you agree your changes are licensed under the project's
  [Apache-2.0](LICENSE) license.

## Contribution workflow

External contributors don't have push access, so we use the standard
**fork-and-pull** model:

1. **Fork** this repository to your own account.
1. **Clone** your fork and add this repo as `upstream`:

   ```bash
   git clone https://github.com/<you>/terraform-plan-report-action.git
   cd terraform-plan-report-action
   git remote add upstream https://github.com/MewsSystems/terraform-plan-report-action.git
   ```

1. **Branch** off an up-to-date `main`:

   ```bash
   git fetch upstream && git switch -c my-change upstream/main
   ```

1. **Make your change**, following the conventions below. Keep PRs focused — one
   logical change per PR.
1. **Test locally** (see [Testing](#testing)) and run the
   [pre-PR checklist](#before-you-open-a-pr).
1. **Push** to your fork and **open a PR against `upstream/main`**, filling in
   the PR template.
1. **Iterate** on review feedback. We squash-merge, so your PR title must be a
   valid [Conventional Commit](#conventional-commits-required).

## Testing

Tests must pass before a change is merged, and **every change to shipped
behaviour lands with test coverage in the same PR** — no "tests later."

```bash
npm ci
npm test         # Jest, unit-first and deterministic (no network, no real API)
```

The rendering core is pure (plans in, markdown out) and covered with fixture
plan files under `__fixtures__/` plus snapshots. When you change rendering,
update the snapshots deliberately (`npm test -- -u`) and review the diff. See
[`CLAUDE.md`](CLAUDE.md#tests) for the full testing rules, including the
end-to-end coverage required for all Terraform operations.

## `dist/` must stay in sync

`dist/index.js` is committed and is what GitHub runs. After any `src/` or
dependency change you **must** rebuild and stage it:

```bash
npm run package   # or: npm run all
git add dist
```

The `check-dist` workflow rebuilds and **fails the PR if `dist/` is stale** —
this is the most common CI failure, so do it before pushing.

## Conventional Commits (required)

We follow the
[Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
specification. Because we squash-merge, the **PR title** is the commit that
lands on `main`, and it must conform — it's what drives automated versioning and
the changelog.

```text
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

| Type                            | Use for                     | Appears in changelog         |
| ------------------------------- | --------------------------- | ---------------------------- |
| `feat`                          | New functionality           | **Features**                 |
| `fix`                           | Bug fix                     | **Bug Fixes**                |
| `perf`                          | Performance improvement     | **Performance Improvements** |
| `revert`                        | Reverting a previous commit | **Reverts**                  |
| `docs`                          | Docs / examples             | **Documentation**            |
| `refactor`                      | Behavior-preserving change  | **Code Refactoring**         |
| `test`                          | Tests only                  | hidden                       |
| `build`, `ci`, `chore`, `style` | Tooling / housekeeping      | hidden                       |

A **scope** is optional and goes in parentheses: `feat(render): ...`. Dependency
bumps use `chore(deps): ...` (this is what Dependabot emits).

A **breaking change** is marked either with `!` after the type/scope (`feat!:`)
**or** a `BREAKING CHANGE:` footer. Because callers pin to a major tag, renaming
or removing an `action.yml` input/output is breaking.

The visible/hidden mapping and version rules live in
[`release-please-config.json`](release-please-config.json).

## Before you open a PR

```bash
npm run all       # format, lint, test, coverage, package
git add dist      # confirm dist/ is staged
```

- **Target `upstream/main`** from your fork's branch, and fill in the PR
  template (including the rollback and security-controls sections).
- **Treat plan content as untrusted.** Resource names, tags, and values are
  PR-author controlled — never `eval` or interpolate them into a shell, and
  don't put real UPNs, hostnames, tenant/subscription IDs, or other
  company-specific identifiers into code, comments, tests, or fixtures.

## Review & merge

- A maintainer reviews for correctness, scope, and test coverage.
- Once approved and all checks pass, a maintainer **squash-merges** using a
  Conventional-Commit title. The merge is the only thing that lands on `main`.
- Per the disclaimer above, review is best-effort with no guaranteed timeline.

## Releasing (maintainers)

Releases are automated with
[release-please](https://github.com/googleapis/release-please). **You never tag
by hand.**

1. Merged Conventional-Commit PRs accumulate on `main`.
1. **release-please** (`.github/workflows/release-please.yml`) maintains an open
   **release PR** with the next computed version + generated `CHANGELOG.md`.
1. **Merging the release PR** tags `vX.Y.Z` and creates the GitHub Release, and
   `script/release` syncs the moving major tag (`vX`) callers pin to.
1. **Publish to the Marketplace:** from the GitHub Release, tick _Publish this
   Action to the Marketplace_ and pick a category. Callers then pin `@vX`.

> **Caution —** consumers pin to the moving major tag. **Never** force-push a
> released tag or amend a published release — fix forward with a new version
> instead.

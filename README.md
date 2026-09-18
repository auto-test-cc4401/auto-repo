# auto-repo

[![CI](https://github.com/auto-test-cc4401/auto-repo/actions/workflows/ci.yml/badge.svg)](https://github.com/auto-test-cc4401/auto-repo/actions/workflows/ci.yml)

Creates one GitHub repository and team per student group from a course roster,
and keeps their membership in sync.

Built for CC4401 (Ingeniería de Software, Universidad de Chile), where each
semester some twenty student teams need a private repository in the course
organization. The roster is the source of truth: `auto-repo` compares it against
GitHub and applies the difference.

## Overview

- **Creates repositories and teams.** One private repo per group, named
  `{year}-{semester}-{course}-grupo-{n}`, with a matching GitHub team granted
  `push` on it.
- **Reconciles rather than re-runs.** Every invocation compares the roster to
  GitHub and applies only the difference, so a converged organization produces
  an empty plan. Late enrollments and team changes are ordinary diffs.
- **Reads real spreadsheet exports.** Recognizes Spanish and English headers,
  recovers usernames from pasted profile URLs, and collapses repeat form
  submissions.
- **Validates before writing.** Every username is checked against the API before
  any change is made; accounts that do not exist are reported, not attempted.
- **Records what it did.** Each run and each individual action is written to a
  local SQLite database, alongside a Markdown and CSV report.

## Requirements

- Node 22 or newer
- pnpm (pinned via `packageManager`; `corepack enable` will provide it)
- A GitHub credential able to manage teams and repositories in the organization

## Installation

```bash
git clone https://github.com/auto-test-cc4401/auto-repo.git
cd auto-repo
pnpm install
pnpm build
```

Dependency lifecycle scripts are blocked at install time except for packages
listed under `pnpm.onlyBuiltDependencies` in `package.json` (currently only
`better-sqlite3`, which compiles a native binding). `pnpm.minimumReleaseAge`
additionally refuses package versions published within the last 24 hours.

## Configuration

Copy the example and edit it. `course.config.yaml` is gitignored.

```bash
cp course.config.example.yaml course.config.yaml
```

| Key | Default | Meaning |
| --- | --- | --- |
| `org` | — | GitHub organization that owns the repositories |
| `course` | — | Course code, used in repository names |
| `year` | — | Four-digit year |
| `semester` | — | `1` autumn, `2` spring, `3` summer |
| `sections` | `1` | Number of sections this semester |
| `permission` | `push` | Permission each team receives on its repository |
| `teamSize.min` / `.max` | `4` / `6` | Team sizes outside this range are reported |
| `docentes` | `[]` | Teaching staff logins; never provisioned as students |
| `autoInit` | `true` | Create an initial commit so the repo has a default branch |
| `roster` | `./roster/students.csv` | Default roster path |
| `databasePath` | `./auto-repo.sqlite` | Where run history is stored |
| `reportDir` | `./reports` | Where reports are written |

Credentials come from the environment. Either works; the App takes precedence if
both are set.

```bash
# A fine-grained personal access token
export GITHUB_TOKEN=github_pat_...

# Or an organization-owned GitHub App
export GITHUB_APP_ID=123456
export GITHUB_APP_INSTALLATION_ID=7890123
export GITHUB_APP_PRIVATE_KEY_PATH=./app-private-key.pem
```

A token belongs to one person's account; an App does not, so it keeps working
across staff turnover and is the better choice for anything shared or automated.

## Usage

| Command | Description |
| --- | --- |
| `doctor` | Check Node version, credentials, organization access and rate-limit budget |
| `roster import` | Import and validate the roster, verifying every username against the API |
| `plan` | Print the changes that would be made. Read-only |
| `apply` | Create teams and repositories, and add members |
| `status` | Show teams, members, pending invitations and students with no account |
| `report` | Write a Markdown and CSV report of the current plan |

Global options: `--config <path>`, `--roster <path>`, `--db <path>`.

A typical semester:

```bash
pnpm exec auto-repo doctor
pnpm exec auto-repo roster import --roster roster/2026-2.csv
pnpm exec auto-repo plan
pnpm exec auto-repo apply
pnpm exec auto-repo status
```

`plan` is read-only and safe to run at any time. `apply` exits non-zero if any
action failed, and writes its report either way.

### Removing members

`plan` lists members who are on a team but no longer on the roster. `apply`
skips those removals unless you pass `--allow-removals`:

```bash
pnpm exec auto-repo apply --allow-removals
```

Repositories and teams are never deleted, with or without the flag.

## Roster format

CSV, TSV or JSON. Headers are matched case- and accent-insensitively against a
list of aliases, so a Google Forms export usually works unmodified.

| Field | Matched headers |
| --- | --- |
| Name | `Nombre completo`, `Nombre`, `Name` |
| Email | `Email Address`, `Correo` |
| GitHub username | any header containing `github` |
| Section | `Sección`, `Section` |
| Team | `Equipo`, `Team`, `Grupo` |

Import applies these rules:

- **Profile URLs** are reduced to a bare login: `https://github.com/someone`
  becomes `someone`.
- **Repeat submissions** collapse to the most recent response. People are
  matched on any shared signal — username, email or name — so a student who
  submits twice under different email addresses is still one person.
- **Section labels** such as `1 - Gonzalo` are parsed to their number.
- **Students without a username** stay on the roster and are excluded from
  provisioning. They are listed by `status` and in every report.
- **Nonexistent accounts** are reported and excluded.

Team numbers must be unique across the whole course, not per section. A roster
where one team number appears in two sections is rejected before anything is
applied.

## How it works

The roster is the desired state. `plan` reads the current state of the
organization, diffs the two, and produces a list of actions; `apply` executes
them. The diff itself (`src/core/diff.ts`) is a pure function of
`(desired, actual) => Action[]`.

Actions run in three phases, because they depend on each other: teams and
repositories are created first, then permissions are granted, then memberships
change. Within a phase, work runs concurrently against a bounded pool, with
Octokit's retry and throttling plugins handling primary and secondary rate
limits.

Each action succeeds or fails on its own. A failure is recorded and the run
continues, so one unreachable account does not discard the rest of the results.

A pending invitation counts as membership, so nobody is invited twice; `status`
reports accepted and pending separately.

Run history goes to SQLite (`runs`, `actions`) along with the resolved roster
and team membership (`students`, `teams`, `memberships`).

## Scope

The tool does not:

- create repository contents, labels, milestones or branch protection
- create GitHub Projects
- assign students to teams — teams arrive already assigned
- delete repositories or teams
- send email

## Data and privacy

The roster contains student names, email addresses and usernames.
`course.config.yaml`, `roster/`, `*.csv`, `reports/` and `*.sqlite` are
gitignored so that this repository can be public while course data stays local.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

Tests run without network access. The diff engine and roster normalization are
pure functions and carry most of the coverage; API interaction is tested against
a stubbed client.

## License

MIT — see [LICENSE](LICENSE).

# auto-repo

Creates the CC4401 group repositories on GitHub and provisions student access to
them, idempotently and with a full audit trail.

Rewrite of the original `app.js`. That script added students to **pre-existing**
repos as individual collaborators with `admin`, in a single fire-and-forget pass.
It stopped working entirely when Node removed the `assert { type: 'json' }`
import syntax, and a single mistyped username would reject `Promise.all`, skip
the `.then()`, and destroy the log of everyone who *had* been added.

## What changed

| | v1 | v2 |
| --- | --- | --- |
| Repositories | had to exist already | created by the tool |
| Access | individual collaborators, `admin` | one GitHub team per group, `push` |
| Re-running | unsafe / unclear | idempotent; a converged org is a no-op |
| A bad username | aborts the run, loses the log | reported; the run continues |
| Rate limits | hand-rolled, unreachable branches | Octokit throttling + retry |
| Record | unstructured text file | SQLite audit log + Markdown/CSV report |
| Dropouts, team changes | unhandled | planned, and gated behind a flag |

`push` rather than `admin` is deliberate: `admin` lets any student delete their
group's repository or remove their teammates.

## Requirements

- Node >= 22 (see `.nvmrc`; a `Dockerfile` is provided if you would rather pin it)
- A GitHub credential with permission to manage teams and repos in the org

## Setup

```bash
npm install
npm run build

cp course.config.example.yaml course.config.yaml   # then edit it
```

Credentials, via environment or a `.env` you export — either works:

```bash
# Option A: a fine-grained personal access token
export GITHUB_TOKEN=github_pat_...

# Option B: an org-owned GitHub App (survives staff turnover)
export GITHUB_APP_ID=123456
export GITHUB_APP_INSTALLATION_ID=7890123
export GITHUB_APP_PRIVATE_KEY_PATH=./app-private-key.pem
```

An App is preferable for the shared path: a PAT belongs to whoever is
coordinating this semester and dies when they graduate, which is roughly how the
previous tool ended up unmaintained. Both are supported; the App wins if both
are configured.

Then check everything before touching anything:

```bash
npx auto-repo doctor
```

## Usage

```bash
# 1. Import the roster and verify every GitHub username against the API
npx auto-repo roster import --roster roster/2026-2.csv

# 2. See exactly what would change. Read-only; this is the default posture.
npx auto-repo plan

# 3. Apply it
npx auto-repo apply

# 4. Who has actually accepted their invitation?
npx auto-repo status
```

`apply` never removes anyone unless you ask:

```bash
npx auto-repo apply --allow-removals
```

Removals are always *shown* by `plan`, but skipped by `apply` by default. A
truncated or mis-parsed roster import should not be able to silently cut a
student out of their repo mid-sprint.

## Roster format

Any CSV, TSV or JSON file with recognizable columns. Headers are matched
accent- and case-insensitively, so a raw Google Form export works unmodified,
including the survey's very long GitHub question.

| Field | Recognized headers |
| --- | --- |
| Name | `Nombre completo`, `Nombre`, `Name` |
| Email | `Email Address`, `Correo` |
| GitHub | any header containing `github` |
| Section | `Sección`, `Section` |
| Team | `Equipo`, `Team`, `Grupo` |

The importer handles the things that actually appear in these exports:

- **Profile URLs.** `https://github.com/someone` becomes `someone`.
- **Repeat submissions.** The last response per person wins. People are matched
  on any shared signal — login, email, or name — because students do submit
  twice under two different email addresses.
- **Students with no GitHub account.** A legitimate state, not an error. They
  stay on the roster, are excluded from provisioning, and are listed by
  `status` and in every report so you can email them.
- **Nonexistent accounts.** Every username is checked against the API *before*
  any mutation runs. A typo is a line in a report, not a failed run.

Team numbers must be **globally unique across sections**. The tool refuses to
apply a roster where one team number spans two sections, which is what happens
if you import a per-section numbering by mistake.

## What it deliberately does not do

- **No repository template, labels or milestones.** Repos are created bare, with
  `auto_init` so they have a real default branch to clone and push to. Setting
  up the project is the students' work. There is no switch for this — the
  template machinery is not in the codebase at all.
- **No branch protection or required reviews.** The course rubric grades repo
  access, commits from every member, commit quality, structure, style and
  comments — not pull requests. Enforcing an ungraded workflow would only
  block beginners at a deadline.
- **No Project boards.** The backlog already lives in a spreadsheet with an
  `Encargado/a` column.
- **No team formation.** Teams arrive pre-assigned.
- **No repository or team deletion, ever.** The only destructive action the tool
  can take is removing a person from a team, and that is flag-gated.

## Data and privacy

The roster holds student names, emails and usernames. `course.config.yaml`,
`roster/`, `*.csv`, `reports/` and `*.sqlite` are all gitignored, so this
repository can be public while the course data stays local.

## Development

```bash
npm test          # 52 tests, no network access required
npm run typecheck
```

The diff engine (`src/core/diff.ts`) is a pure function of
`(desired, actual) => Action[]`, so most behaviour is testable without touching
GitHub. Roster normalization is tested against the real defects from the 2026-1
export.

## Roadmap

Phase 2 is dashboards for the teaching team — per-member commits, contribution
balance and sprint activity — reading from the same SQLite database this phase
populates. Also deferred: a Google Sheets importer, integration with the DCC
group-formation tool, and emailing students who never submitted a username.

## Contact

gonzaloalarcon@ug.uchile.cl

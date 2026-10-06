# Periodic site updater

A small GitHub Actions scheduler for a site you own. It sends authenticated HTTPS requests to that site's update endpoints. The site remains responsible for importing its authorized content and enforcing its write lock. Publishing these files does not prove that the scheduler works: verify a real manual Actions run, then a real scheduled run.

## Setup

Copy this package into a dedicated repository root, including `.github/workflows/sync.yml`. On the default branch, add exactly two repository **Actions Secrets** under Settings → Secrets and variables → Actions:

- `SITE_ORIGIN`: an exact HTTPS origin such as `https://example.test`, with no trailing slash, path, query, fragment, or credentials.
- `SYNC_SECRET`: the application's update secret, matching the site's configuration.

Do not add platform service credentials, cookies, `.env` files, or site data. GitHub [encrypts Actions Secrets](https://docs.github.com/en/code-security/reference/secret-security/secret-types). The runner receives them through environment variables, not command arguments or files. Restrict workflow write access to trusted maintainers.

Use Actions → Site news sync → Run workflow for the first live check. Inspect its compact summary and the site's state, then verify a run whose event is `schedule`. Keep only one scheduler active for these writes; this package does not disable others.

## Behavior

The UTC schedule runs at minutes 3, 13, 23, 33, 43, and 53 each hour. It calls `POST /api/sync`, up to five `POST /api/media` requests when needed, and `GET /api/status`. Default maximum: seven requests. The internal budget is 8.5 minutes, a request gets at most four minutes, and the job timeout is ten minutes. Concurrency prevents parallel jobs; the site still needs a write lock. Redirects are refused.

Logs contain counts and fixed status codes. `ok` requires a clean final status; it does not claim the entire archive is copied. RSS remains `partial` because its metadata is incomplete. A recognized source HTTP 403 can permit queued media work while preserving the news failure. Exit codes: 0 for success/busy, 1 for error, 2 for partial results; the latter two produce a failed Actions step. Source access controls and request identity are not changed.

## Cost, scheduling, and visibility

Standard hosted runners in public repositories are free. Private GitHub Free repositories share 2,000 minutes monthly; 144 scheduled runs daily can exceed that allowance depending on duration and other usage. Avoid larger runners and paid plans. [Official billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Scheduled runs may be delayed or dropped. Public-repository schedules disable after 60 days without repository activity. Periodic maintenance is necessary; exact execution times and upstream access are not guaranteed. [Official schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

This public package contains no target-site address or source identity. The repository owner, code, and run counts remain public, so operator anonymity is not guaranteed. Keep identifying addresses and details out of public commits and logs.

No dependency installation is needed. The workflow checks built-in Node 22+, uses `ubuntu-latest`, and pins official checkout v4.2.2 to [11bd71901bbe5b1630ceea73d27597364c9af683](https://github.com/actions/checkout/commit/11bd71901bbe5b1630ceea73d27597364c9af683), with credential persistence disabled.

## Offline validation

```sh
node --test worker.test.mjs workflow.test.mjs
```

Tests use stubbed fetch and never contact a site. Real external CI and scheduled-run verification are still required.

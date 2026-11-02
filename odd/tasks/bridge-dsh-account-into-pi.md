# Bridge the dsh account subscription into Pi

Make Pi use the same DeepSeek account that the dsh web interface uses, so that
changing the account in the dsh web UI changes the account Pi uses too.

This is a separate feature from the installer (`odd/tasks/productize-pi-dsh-bridge.md`).
It builds on the installed CLI rather than replacing it.

Route: new ODD feature, tracked in this document. The public command and flag
contract of the installer (`install`, `doctor`, `verify`, `uninstall`) is frozen
and is not changed by this feature, except that two commands are added and
`doctor`/`verify` gain new checks.

## Specs

S1. Pi must use the DeepSeek account credential that the dsh web interface
    uses, not a separate API key. When the user signs in to a different account
    in the dsh web interface, Pi must use that new account without the user
    re-entering anything in Pi.

S2. The account credential is read fresh at every Pi start. No cached token, no
    stale copy: the `pi-deepseek` launcher resolves the current grant each
    time it starts Pi.

S3. A manual `sync` command exists and performs the same credential wiring
    explicitly, so a user can force a re-sync without restarting their shell.

S4. The bridge replaces the `deepseek` provider rather than adding a second
    one. There is exactly one path for Pi to reach DeepSeek, so "which account
    is Pi using" always has one answer.

S5. The account token never leaves the machine. It is never written into
    `models.json`, never printed, and never copied into a second file. Pi
    resolves it at request time from a command.

S6. The bridge degrades honestly. If the dsh grant is missing, unreadable,
    expired, or the format changed, `doctor` reports exactly what is wrong and
    the API-key path keeps working. A broken bridge never makes Pi unstartable
    and never fails with a cryptic error.

S7. `doctor` distinguishes three states for every credential it checks:
    absent, present-but-unusable, and usable. "Present" is not "working". This
    is the defect that produced the confusion this feature exists to remove:
    a credential with zero balance was reported as healthy.

S8. `uninstall` restores the previous `models.json` exactly, including the
    previous `deepseek` provider entry, and removes every file this feature
    created.

S9. The dsh web launcher must use the account route consistently. The existing
    behaviour emits repeated `403` failures against
    `/auth-api/v0/users/current` while still appearing to work, because the
    model listing succeeds on a different path. The launcher must not present
    a half-broken route as healthy.

S10. `verify` must exercise the same path Pi actually uses (the shared account
    route), not a separate API-key round trip.

S11. Every command that mutates Pi's configuration is journaled and
    reversible, with `--dry-run` support and idempotency, following the rules
    already established by the installer feature.

S12. No new runtime dependencies. The account credential is read with a
    small, strict parser for the specific grant this feature needs.

## Verified facts this feature relies on

These were confirmed against the installed packages, not assumed. They are the
load-bearing parts of the design; if any of them stops holding, the bridge is
disabled and `doctor` says so.

- `@deepseek-ai/dsh@0.2.1-rc.5` stores the account grant in
  `~/.dsh/.credentials.yaml` under the record key
  `deepseek-account-platform/default`, with payload fields `token` and
  `issuer`. The issuer observed is `https://platform.deepseek.com`.
- The dsh web interface uses that grant for inference by sending the header
  `x-dsh-auth-token`, not `Authorization: Bearer`.
- `GET https://api.deepseek.com/models` with `x-dsh-auth-token` returns
  `HTTP 200`; without it, `HTTP 401`. The account token authenticates against
  the regular DeepSeek API host.
- `POST https://api.deepseek.com/chat/completions` with `x-dsh-auth-token`
  and model `deepseek-flash` returns `HTTP 200` with a real `usage` block.
  The account token is therefore usable for completions, which is what Pi
  needs.
- Pi's provider config (`~/.pi/agent/models.json`) accepts per-provider
  `baseUrl`, `api`, `headers`, and `authHeader`. Header values resolve with
  the same rules as `apiKey`: a literal, an environment reference, or a
  `!command` whose stdout is used. `authHeader` defaults to `false`, so no
  `Authorization: Bearer` header is added when the custom header is used.
- A `!command` header value is resolved once per Pi process and cached for
  that process lifetime only. A fresh Pi start therefore reads the current
  token, which satisfies S2 without any extra machinery.
- The dsh account route maps the upstream `QUOTA` error to
  `ACCOUNT_QUOTA_EXCEEDED_CODE`, and the API-key route surfaces the same
  underlying exhaustion as `402 insufficient_balance_error`. Both are the same
  account and the same wallet, reached by two different mechanisms.

## Tasks

| ID | Spec | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S5 S12 — read the dsh account grant (strict, no deps) | inline | done | 596b409 |
| T2 | S1 S4 S5 — write the shared provider into `models.json` | inline | done | 596b409 |
| T3 | S2 — `pi-deepseek` resolves the credential fresh at each start | inline | done | 596b409 |
| T4 | S3 — `sync` command | inline | done | 596b409 |
| T5 | S6 S7 — `doctor`: absent / unusable / usable, per credential | inline | done | 596b409 |
| T6 | S8 S11 — `uninstall` restores the previous `models.json` exactly | inline | done | 596b409 |
| T7 | S9 — dsh launcher uses the account route consistently | inline | done | 596b409 |
| T8 | S10 — `verify` exercises the shared route | inline | done | 596b409 |
| T9 | all — tests over a hermetic sandbox | inline | done | 596b409 |
| T10 | S1 S4 — docs: what the bridge does, how to use it, how it fails | inline | done | fc93605 |

## Delivery

The slice boundary, recorded because the implementation slice is larger than
the usual ~400 authored lines:

| Commit | Slice | Lines | Why it is one unit |
| --- | --- | --- | --- |
| `e5c4956` | the specification | 135 | the contract the work is measured against |
| `596b409` | the implementation | ~1,460 | the provider, the grant parser, `sync`, `install`, `doctor`, `verify`, the two launchers and the tests are one coupled behaviour: splitting them would leave the suite red at the intermediate commits, because `install` writes the provider that `doctor` and `verify` then inspect |
| `fc93605` | the documentation | 310 | reader-facing, reviewable on its own |
| `5fd1c89` | the live-run fixes | 130 | two defects that only a real run could find: the account command composed wrongly, and the dsh launcher booted dsh with an invalid argument order |

If this feature needs a pull request rather than a direct merge, it is a
stacked delivery: the specification and the implementation first, the
documentation and the release preparation second. The risk line for the
implementation slice names item 2 (credentials), so it must be reviewable on
its own: the token is read from the dsh credentials store at request time,
never written to disk by this project, and no diagnostic path prints a
credential value.

## Log

## Log

L1 (verbatim): "Si investiga todo el objetivo es que cuando cambie mi cuenta via
interfaz web tambien en Pi se usen los creditos de esa cuenta nueva."
L2 (decision): credential resolution is fresh at every Pi start (the launcher
resolves the grant each time it starts Pi), and a manual `sync` command exists
for an explicit re-sync. Chosen by the user.
L3 (decision): the bridge replaces the `deepseek` provider instead of adding a
second one, so there is a single path from Pi to DeepSeek. Chosen by the user.
L4 (correction): an earlier analysis of this session claimed the API key and the
dsh account were two separate wallets. That was wrong. The `ACCOUNT_QUOTA`
error the user saw in the dsh web UI and the `402 insufficient_balance_error`
seen in Pi are the same account and the same wallet reached by two mechanisms:
the account route maps the upstream `QUOTA` error to `ACCOUNT_QUOTA`.
L5 (evidence): the `deepseek` API key in `~/.pi/agent/auth.json` has the same
SHA-256 fingerprint in all four backups of that file (25 Oct, 28 Oct, 31 Oct,
and current). It was never created during this session. `GET /user/balance`
with it returns `HTTP 200` with `is_available: false` and a `0.00` balance:
a valid credential on an account with no credit left.
L6 (evidence): `x-dsh-auth-token` against `https://api.deepseek.com/models`
returns `HTTP 200` while the same request without the header returns `401`.
`POST /chat/completions` with that header and model `deepseek-flash` returns
`HTTP 200` with a real `usage` block. The account grant can drive Pi.
L7 (evidence): `resolveConfigValue` in Pi executes a `!command` config value
through the shell, uses its trimmed stdout, and caches it only for the life of
the process (`commandResultCache`). `resolveHeadersOrThrow` applies it to
provider headers. `withConfiguredAuth` adds `Authorization: Bearer` only when
`authHeader` is true; it defaults to false.
L8 (constraint, accepted): `x-dsh-auth-token` is an undocumented DeepSeek
header and `~/.dsh/.credentials.yaml` is an internal dsh format in a release
candidate. The bridge therefore ships with an explicit, tested fallback to the
API-key path, and `doctor` states which path is live.
L9 (evidence): the account grant and the stored API key are the same wallet,
and only one of them has credit. `GET https://api.deepseek.com/user/balance`
with the account token in `x-dsh-auth-token` returns `HTTP 200` with
`is_available: true`, `USD 0.00` and `CNY 5.95`. The same endpoint with the
stored API key as `Authorization: Bearer` returns `HTTP 200` with
`is_available: false` and a `0.00` balance.
L10 (evidence, header contract): the account token is accepted only in
`x-dsh-auth-token`. As `Authorization: Bearer` it is `401`. A valid
`x-dsh-auth-token` wins over `Authorization`; a non-empty but invalid one
fails with `401` and NO fallback; an empty or absent one behaves as absent
and lets `Authorization` carry the request. The token command therefore never
prints a placeholder, and the fallback lives at the configuration level.
L11 (evidence, correction): `authHeader: false` in `models.json` does not stop
the OpenAI-compatible SDK from sending `Authorization` when a stored
credential exists. A stale API key may travel alongside the account token;
DeepSeek ignores it while the account token is valid. The stored key is kept
on purpose: it is the explicit fallback route.
L12 (evidence, end to end): with a sandboxed `PI_CODING_AGENT_DIR`, `sync`,
the real dsh credentials and the real Pi, one prompt was answered `BRIDGE_OK`
through the account route. With the grant file moved away, Pi failed before
sending any request, with `Failed to resolve provider "deepseek" header
"x-dsh-auth-token" from shell command: ...` — the failure names the cause,
and `pi-deepseek` now checks the same thing before Pi starts.
L13 (correction): Pi reads its own configuration from `$PI_CODING_AGENT_DIR`,
not from `$PI_HOME`. A test that assumed `PI_HOME` had written to the real
`~/.pi/agent/models.json`; it was restored by removing only the injected
provider, and `resolveLayout` now prefers the variable Pi itself reads.
L14 (evidence): the repeated `403` against `/auth-api/v0/users/current` are
Cloudflare HTML blocking `platform.deepseek.com` from this machine, not a
credential failure. Restarting `dsh web` stopped the repetition, and the
account route loads its model list afterwards. Inference was never affected.
L15 (decision): the dsh route moved from `deepseek-official` to
`deepseek-account` so that dsh and Pi spend the same wallet. The API-key
route remains available as an explicit fallback and `doctor` says which one
is live.
L16 (incident, worked around): the delegation runtime failed five times with
`invalid_request` before any tool call, at every context size. The work was
done inline instead, and every file the workers would have touched is
committed here.
L17 (decision, by the user): the native RDD review is skipped for this
candidate. `gentle_review assess` was run first (read-only) and rated the
candidate high risk with `reviewDue: true`; the receipt-driven review
lifecycle was then not started, by explicit instruction. The independent
verifier required by the risk tier still runs, because that requirement comes
from the risk classification and not from RDD.
L18 (bug, found by the live run, fixed in `5fd1c89`): the installed helper
added `token --dsh-home <dir>` to the CLI, and the command recorded in
`models.json` added the same arguments again. Pi therefore ran the CLI with a
duplicated subcommand and every request failed with `Failed to resolve
provider "deepseek" header "x-dsh-auth-token" from shell command`. The helper
now passes its arguments through untouched, so the same command works whether
it names the helper or the CLI. A test now runs the exact command Pi runs,
through a shell, and asserts it produces the token: that coverage was the
thing whose absence let the defect through.
L19 (bug, found by the live run, fixed in `5fd1c89`): the dsh launcher passed
`--patch` after the `web` shortcut and then repeated the profile, so dsh
refused to boot (`unknown option '--patch'`, then `too many arguments`).
dsh's grammar is `dsh [--profile] <name> [options] [app-args...]`; the
launcher now names the profile explicitly and puts the app flags after the
global options. dsh web boots again and the account route loads its model
list: `[llm-deepseek-account] model listing from https://api.deepseek.com/models
loaded 2 model(s)`.
L20 (evidence, deployed on the real machine): `install` wired
`~/.pi/agent/models.json`, installed `~/.local/bin/pi-dsh-token` and wrote
the overlay. Real Pi answered `BRIDGE_OK` through the account route, the
`pi-deepseek` launcher answered `LAUNCHER_OK`, and `doctor` reported every
check green except the deliberate warning that a stored API key's balance is
not checked offline. dsh web came back on the account route, with the
Cloudflare block on the account dashboard reported once.

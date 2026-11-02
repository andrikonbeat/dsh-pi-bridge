# Compatibility

`dsh` (`@deepseek-ai/dsh`) is a release candidate published by DeepSeek, not by
this project. This page records what has actually been verified, so that a
failure can be attributed quickly instead of guessed at.

## Verified matrix

| `pi-dsh-bridge` | `@deepseek-ai/dsh` | `pi` | Node | Status |
| --- | --- | --- | --- | --- |
| 0.1.0 | `0.2.1-rc.5` | `1.4.0` | >= 22.19.0 | verified end to end |

`doctor` compares the installed `dsh` against this table. A version outside it
is reported as `warn`, not `fail`: the tooling keeps working and you are told
what was tested.

## What is actually coupled

Only four things about `dsh` matter to this project, and all four are checked
by `doctor`:

1. **The CLI shape**: `dsh --profile web --dump-config` composes the config
   without booting a server, and `--patch <file>` applies an overlay.
2. **The shipped default model**: the `web` profile ships
   `provider: deepseek-official`, `model: deepseek-flash`.
3. **The profile layer location**: `$DSH_HOME/profiles/web/cordis.patch.yml`.
4. **The account credential**: the `deepseek-account-platform/default` record
   in `$DSH_HOME/.credentials.yaml`, holding a `grant` with a `token` and an
   `issuer`.

Nothing else. This project deliberately does **not** edit the profile layer —
see below.

## The account credential is the fragile coupling

`$DSH_HOME/.credentials.yaml` is an internal dsh format with no public API.
The bridge reads exactly one record from it, exactly the two fields it needs,
and refuses to guess at anything else:

```yaml
records:
  deepseek-account-platform/default:
    kind: grant
    payload:
      token: <the account token>
      issuer: https://platform.deepseek.com
```

If dsh changes that shape, the bridge reports **present but unusable** and
says why (`expected "grant"`, `has no token`, and so on) instead of sending a
broken credential to the API and producing a confusing 401. That is the whole
reason the parser is strict and dependency-free.

The token is read at request time and never stored by this project. The only
thing written into Pi's configuration is the *command* that fetches it.

## Verified behaviour on 0.2.1-rc.5

- A fresh `DSH_HOME` composes `agent-default-model` with
  `provider: deepseek-official` and `model: deepseek-flash` from the shipped
  template. The API-key route is the default; no patch is needed.
- `--patch <file>` applies after every bundle and after the user layer, and an
  entry whose `id` already exists **replaces** it rather than conflicting.
- `--from-default-profile web` fails for a shipped profile name
  (`profile "web" names shipped profile "web" and cannot be a custom profile
  target`). Never use it for `web`, `headless`, `tui`, `acp` or `sdk`.

Because of the first two facts, an earlier version of this setup wrote a
`cordis.patch.yml` into the user profile. That was redundant, and mutating a
user's profile layer is exactly the kind of change that is painful to undo, so
it was removed: the overlay is applied at launch time (via `--patch`) and only
when `doctor`'s probe finds the effective default model diverging from the
required route.

The required route is now `deepseek-account` (the account wallet), not
`deepseek-official` (the API-key wallet), so dsh and Pi spend the same money.
The shipped default is still `deepseek-official`, so the overlay is what pins
the account route.

### The `403` on `/auth-api/v0/users/current`

This is not a credential problem. The account *dashboard* host
(`platform.deepseek.com`) answers `403` with Cloudflare HTML from some
networks, while the inference host (`api.deepseek.com`) works fine. The
symptom is a web UI whose account panel does not load while inference does.

Two things were confirmed about it:

- it does not stop inference: requests against `api.deepseek.com` with the
  account token succeed and report a real balance;
- a long-running `dsh web` process can keep polling with a stale session; a
  restart of `dsh web` stopped the repetition.

`start-web.sh` probes the dashboard host once at launch and says so plainly
when it is blocked, instead of leaving a half-broken route looking healthy.

## When a new `dsh` release breaks something

1. Run `npx pi-dsh-bridge doctor --json` and keep the output.
2. Compare: does the probe still compose `agent-default-model`? Does
   `--dump-config` still accept `--patch`? Does `web` still default to
   `deepseek-official`? Does `$DSH_HOME/.credentials.yaml` still carry the
   `deepseek-account-platform/default` record with a `grant` and a `token`?
3. Open an issue with the `doctor --json` output and the `dsh --version` value.
   The matrix above is updated only after a real end-to-end run
   (`pi-dsh-bridge verify --yes`), never on the basis of a changelog entry.

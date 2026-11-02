# Productize dsh-pi-bridge as an npm CLI

Turn a personal setup recipe (4 bash scripts + 1 YAML) into a maintained,
publishable product others can install from GitHub and npm.

Route: option B, chosen by the user — a versioned npm CLI
(`npx pi-dsh-bridge install|doctor|verify|uninstall`), GitHub as home, npm as
channel. Target release: 0.1.0, not yet published.

## Specs

S1. The product is an npm package exposing one CLI with four commands:
    `install`, `doctor`, `verify`, `uninstall`. Command names and flags are the
    public contract and must not change after 0.1.0 without a major bump.

S2. Install mutates user-global state, so every mutation must be reversible and
    provable:
    - `--dry-run` prints every planned change and writes nothing.
    - Running `install` twice in a row changes nothing and succeeds.
    - Unrelated keys in `~/.pi/agent/settings.json` are preserved byte-for-byte
      in meaning: existing `enabledModels`, `packages`, `extensions`, `theme`,
      `deviceId` and any unknown key survive untouched.
    - `uninstall` restores exact prior values recorded at install time, and
      never blanket-restores a file that the user edited afterwards.

S3. Backups and the install journal live outside the repository, under
    `$STATE_DIR` (default `~/.local/state/pi-dsh-bridge`), so a `git pull` in
    the user's clone never lands on top of backups.

S4. Paths are portable: no locale-specific directories. The dsh workspace
    default is `$DSH_HOME/workspace`, not a translated Documents folder.

S5. `dsh` is a release candidate owned by DeepSeek, not by us. The install
    records the observed `dsh` version, `doctor` reports drift against a
    checked-in compatibility matrix, and the dsh integration never edits the
    user's profile layer: it passes `--patch <overlay>` at launch, and only
    when the effective default model actually diverges from the required route.

S6. `doctor` is cheap and offline: versions, presence, writability, effective
    dsh config, credential presence. It must not spend API credit. `verify` is
    the costly end-to-end path, requires `--yes`, and is never implicit.

S7. Private artifacts never reach the public repository or the npm tarball:
    `.atl/`, `backups/`, `.skill-registry.cache.json`, `node_modules/`, logs.

S8. The project ships an MIT `LICENSE`, so others can legally use it.

S9. CI runs the test suite on Linux and macOS with the supported Node versions
    and validates the published file set.

S10. Zero runtime dependencies: `npx` must be instant and auditable.

S11. Existing `./install.sh`, `./verify.sh` and `./uninstall.sh` keep working as
    thin shims delegating to the CLI, so the current muscle memory and README
    instructions do not break.

S12. The npm name `dsh-pi-bridge` is already taken by an unrelated package
    (umnaut / Twofruitsgrape, 0.1.1). This package publishes as
    `pi-dsh-bridge`; the GitHub repository keeps its current name.

## Tasks

| ID | Spec | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S7 S8 — git init, .gitignore, LICENSE, baseline commit | inline | done | 5b36783 |
| T2 | S1 S10 — CLI skeleton, paths/preflight/state libs, RED tests | worker | done | 9018b83 |
| T3 | S2 S3 S4 — install command (dry-run, merge, idempotency) | worker | done | 9018b83 |
| T4 | S2 S3 — uninstall command (exact restore from journal) | worker | done | 9018b83 |
| T5 | S5 S6 — doctor command (offline checks, drift, --json) | worker | done | 9018b83 |
| T6 | S6 — verify command (costly E2E behind --yes) | worker | done | 9018b83 |
| T7 | S5 S4 — dsh overlay + launcher with divergence detection | worker | done | 9018b83 |
| T8 | S11 — shims for install.sh / verify.sh / uninstall.sh | inline | done | 9018b83 |
| T9 | S8 S12 — README as product, CONTRIBUTING, compat matrix | inline | done | bd8c75c |
| T10 | S9 — CI workflow and npm pack validation | inline | done | 8e726e3 |
| T11 | all — full suite, doctor on the real machine, release check | inline | in progress | |

## Log

L1 (verbatim): "Quiero convertir este bridge en un producto para que otros usuarios
lo puedan utilizar desde mi github como lo podemos hacer ??"
L2 (verbatim): "Vamos con B" — accepts option B from the prior proposal: versioned
npm CLI, GitHub repo as home, npm as channel, with option B's command names and
flags treated as the frozen public contract.
L3 (evidence, dsh 0.2.1-rc.5): a fresh `DSH_HOME` composes `agent-default-model`
with `provider: deepseek-official`, `model: deepseek-flash` from the shipped
template. The profile-layer `cordis.patch.yml` written by the old installer is
therefore redundant; it only added `reasoningEffort: high` and a cosmetic
welcome-notice version. Decision: stop patching the user profile layer (S5).
L4 (evidence): `dsh --profile web --patch <file> --dump-config` applies the
overlay after every bundle and the user layer, and a patch entry with a
duplicate `id` replaces rather than conflicts. This makes a non-destructive
overlay safe, and `--dump-config` makes the effective config assertable without
booting a server.
L5 (evidence): `npm view` reports `dsh-pi-bridge@0.1.1` owned by `umnaut`
(repo `Twofruitsgrape/dsh-pi-bridge`), described as a Pi/DSH plugin bridge.
`pi-dsh-bridge` and `deepseek-pi-bridge` return 404 (available). Decision: S12.
L6 (evidence): the machine is not authenticated to npm (`npm whoami` fails), so
`npm publish` and `npm login` remain human steps; the build stops at a
pack-verified tarball.
L7 (evidence, T2-T8): the parent re-ran the suite (45/45, exit 0), confirmed the
inode guard (48599), and checked `install` idempotency against a copy of the
real `~/.pi/agent/settings.json` in a sandbox: the first run only appends
`enabledModels`, leaving key order and every other key byte-identical, and the
second run reports `nothing to do` with one backup batch in total. `doctor`
reports 9/9 ok on the real machine with a live `dsh --dump-config` probe.
L8 (follow-up, cosmetic, not a defect): the install plan's detail line for
`settings.json` lists every managed key (`Object.keys(desired)`), so a machine
that already had the right provider still reads `updated ... defaultProvider,
defaultModel`. The journal and the written bytes are correct; only the summary
text overstates. Fix by diffing `desired` against `current.data` and naming only
the keys that actually change, plus one test that seeds a correct provider and
asserts the detail names only `enabledModels`.

## Public CLI contract (frozen for 0.1.0)

Package `pi-dsh-bridge`, ESM, zero runtime dependencies, `engines.node >= 22.19.0`.

```
pi-dsh-bridge <command> [options]

Commands:
  install     wire DeepSeek into Pi and install the dsh web launcher
  doctor      cheap, offline health check (never spends API credit)
  verify      end-to-end check; requires --yes (spends API credit)
  uninstall   restore exactly what install changed
  help        usage

Options:
  --dry-run            print the planned changes and write nothing
  -y, --yes            do not ask for confirmation
  --json               machine-readable output (doctor, install)
  --pi-home <dir>      default $PI_HOME or ~/.pi/agent
  --dsh-home <dir>     default $DSH_HOME or ~/.dsh
  --bin-dir <dir>      default $BIN_DIR or ~/.local/bin
  --state-dir <dir>    default $STATE_DIR or ~/.local/state/pi-dsh-bridge
  --model <id>         Pi default model, default deepseek-flash
  --provider <id>      Pi provider, default deepseek
  -h, --help           usage
  -V, --version        version

Exit codes: 0 ok, 1 check failed, 2 usage error.
```

### Files it may create or change

| Path | Change | Reversible by |
| --- | --- | --- |
| `$PI_HOME/settings.json` | `defaultProvider`, `defaultModel` (and `enabledModels` only when absent/empty) | journal records the exact prior values |
| `$DSH_HOME/start-web.sh` | written from the asset, mode 0755 | journal records prior bytes or "absent" |
| `$BIN_DIR/pi-deepseek` | written from the asset, mode 0755 (a real file, never a symlink into `node_modules`) | journal |
| `$STATE_DIR/dsh-overlay.yml` | only when the effective dsh default model diverges | journal |
| `$STATE_DIR/backups/<stamp>/` | prior bytes of every changed file | never deleted by uninstall |

Everything else in `settings.json` is preserved: unknown keys, `packages`,
`extensions`, `theme`, `deviceId`, and an existing non-empty `enabledModels`.

### Journal

`$STATE_DIR/journal.json`, one entry per changed path:

```json
{
  "version": 1,
  "installedAt": "<ISO>",
  "versions": { "pi": "...", "dsh": "...", "node": "..." },
  "entries": [
    { "path": "<abs>", "before": "<abs backup path>" | null, "after": "settings-keys" | "file-copy" | "absent" }
  ],
  "settings": { "keys": ["defaultProvider", "defaultModel"], "before": { "defaultProvider": "..." } }
}
```

`before: null` means the path did not exist and uninstall must delete it.
Uninstall restores only the recorded entries, never a whole directory, never
`git restore`/`git clean`, and never touches a file it did not record.

### dsh integration

Verified against `@deepseek-ai/dsh@0.2.1-rc.5`:

- The shipped `web` profile already defaults to `provider: deepseek-official`,
  `model: deepseek-flash`. Do not edit `$DSH_HOME/profiles/web/cordis.patch.yml`.
- To read the effective config without booting anything:
  `dsh --profile web --dump-config` (add `--patch <file>` when an overlay is installed).
- `--patch <file>` applies after every bundle and after the user layer; a patch
  entry whose `id` already exists replaces it rather than conflicting.
- `--from-default-profile web` must never be used for a shipped profile name; it
  errors with "profile \"web\" names shipped profile \"web\" and cannot be a
  custom profile target".

The launcher passes `--patch "$STATE_DIR/dsh-overlay.yml"` only when that file
exists. The overlay is written only when the probe finds a divergence; the
overlay content is:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
```

### doctor checks

Each check reports `ok` / `warn` / `fail` plus a one-line detail; only `fail`
sets exit code 1.

1. node >= 22.19.0
2. `pi` on PATH, with its version
3. `dsh` on PATH, with its version and whether it matches the compatibility matrix
4. `$PI_HOME/settings.json` parses and points at the requested provider/model
5. a DeepSeek credential exists in `$PI_HOME/auth.json` (report presence only; never print the value)
6. launcher installed, executable, and pointing at an existing file
7. `pi-deepseek` wrapper in `$BIN_DIR`
8. effective dsh default model matches the required route
9. `$STATE_DIR` writable; if a journal exists, report version drift since install

### Tests

`node --test`, hermetic: every test builds a sandbox with fake `pi` and `dsh`
executables on `PATH`, and never reads or writes the real home. Required cases:

- `help` and `--version` exit 0; unknown command exits 2 with usage on stderr.
- `install --dry-run` writes nothing (no file created, no journal written).
- `install` creates the launcher and wrapper, and exits 0.
- running `install` twice leaves the tree, the settings file and the journal byte-identical.
- `install` preserves unrelated settings keys and an existing `enabledModels`.
- `uninstall` restores the exact prior `settings.json` bytes and removes the wrapper and launcher.
- `uninstall` deletes a file that did not exist before install.
- `doctor --json` emits valid JSON and fails when `pi` is missing from PATH.
- `doctor` warns on a dsh version outside the compatibility matrix.
- `verify` refuses to run without `--yes`.

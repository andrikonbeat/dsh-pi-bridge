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
| T1 | S7 S8 — git init, .gitignore, LICENSE, baseline commit | inline | | |
| T2 | S1 S10 — CLI skeleton, paths/preflight/state libs, RED tests | inline | | |
| T3 | S2 S3 S4 — install command (dry-run, merge, idempotency) | inline | | |
| T4 | S2 S3 — uninstall command (exact restore from journal) | inline | | |
| T5 | S5 S6 — doctor command (offline checks, drift, --json) | inline | | |
| T6 | S6 — verify command (costly E2E behind --yes) | inline | | |
| T7 | S5 S4 — dsh overlay + launcher with divergence detection | inline | | |
| T8 | S11 — shims for install.sh / verify.sh / uninstall.sh | inline | | |
| T9 | S8 S12 — README as product, CONTRIBUTING, compat matrix | inline | | |
| T10 | S9 — CI workflow and npm pack validation | inline | | |
| T11 | all — full suite, doctor on the real machine, release check | inline | | |

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

# Contributing

Thanks for taking the time. This project has an unusually small surface, so the
rules are short.

## What this project will and will not do

It configures Pi and installs a dsh launcher. It does **not** implement a model,
a provider, an agent loop, or a Pi → dsh bridge — see the "What this is not"
section of the README before proposing one.

The value it adds is that every change is reversible and observable. Any change
that makes it harder to reason about what was written, or that mutates a path it
did not journal, will be pushed back on regardless of how useful it is.

## The command-line contract is frozen

`install`, `doctor`, `verify`, `uninstall`, and the flags documented in the
README are a public contract from `0.1.0` on:

- adding a command or an optional flag → minor bump
- changing or removing one, or changing an exit code → major bump
- changing an output message freely is fine; the `--json` shape is not

## Before opening a pull request

```bash
node --test        # hermetic: fake pi/dsh, temporary homes, no network
npm run pack:check # confirm the published file set did not grow by accident
```

Both must pass. The test suite must never read or write a real `~/.pi`, `~/.dsh`
or `~/.local/bin`; if a test needs `pi` or `dsh`, it uses the fakes from
`test/helpers.js`.

## What a good change includes

- **One behaviour per pull request**, with tests that assert the observable
  effect: exit code, exact stdout/stderr, and that a rejected input leaves
  stored data and the journal unchanged.
- **Documentation updated with the behaviour**: a new flag goes in the README
  command table, a new failure mode goes in `docs/troubleshooting.md`, and a
  newly verified `dsh` version goes in `docs/compatibility.md` — only after a
  real `verify --yes` run, never from a changelog entry.
- **No new runtime dependencies.** The zero-dependency property is a feature;
  a pull request that adds one needs to argue why the standard library cannot
  do it.
- **No secrets in fixtures.** Use obviously fake keys (`sk-test`) and never
  commit an `auth.json`.

## Reporting bugs

Include the output of:

```bash
npx pi-dsh-bridge doctor --json
npx pi-dsh-bridge --version
pi --version
dsh --version
node --version
```

That answers most of the triage questions without a round trip.

## Commits and review

Conventional Commits, one reviewable slice per commit, tests and docs alongside
the behaviour they describe. Keep pull requests under roughly 400 changed lines;
if a change needs more, split it and say why in the description.

## Publishing a release

Publishing is a human decision, and it needs two credentials that only the
maintainer can create:

1. An npm **automation token**: npmjs.com → Access Tokens → Automation Token.
2. That token as the repository secret `NPM_TOKEN`:
   `gh secret set NPM_TOKEN --repo andrikonbeat/dsh-pi-bridge`.

Then the release is a tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The `Release` workflow checks that the tag matches the version in
`package.json`, runs the tests, and publishes with npm provenance. Nothing
publishes on a plain push to `main`.

The package is not on npm until this happens, so `npm install -g
pi-dsh-bridge` answers 404. That is expected, not a broken install: use the
checkout (`npm install -g .`) or the tarball (`npm pack`, then
`npm install -g ./pi-dsh-bridge-<version>.tgz`).

## License

By contributing you agree your work is licensed under the MIT license in
[LICENSE](../LICENSE).

---
name: Bug report
about: Something installed, checked or uninstalled incorrectly
labels: bug
---

## What happened

<!-- One or two sentences. The exact command and the exact output are the most
useful thing in this report. -->

## Diagnostics

Paste the output of these. `doctor` never prints a credential value, so it is
safe to share.

```console
$ npx pi-dsh-bridge doctor --json
$ npx pi-dsh-bridge --version
$ pi --version
$ dsh --version
$ node --version
```

## Environment

- OS and version:
- Shell:
- How you installed: `npx` / global / from a clone
- `PI_HOME` / `DSH_HOME` / `BIN_DIR` overrides, if any:

## Reproduction

```console
# the smallest sequence of commands that shows the problem
```

## What you expected instead

<!-- If this is about the dsh side, also include the output of
`dsh --profile web --dump-config | grep -A5 agent-default-model`. -->

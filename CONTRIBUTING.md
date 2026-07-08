# Contributing to Sidewrite

Thanks for your interest in contributing! Bug reports, fixes, docs, and ideas
are all welcome.

## Getting started

Requirements: **Node.js ≥ 22.5** and the `claude` CLI.

```sh
git clone https://github.com/hassanalitamam/sidewrite.git
cd sidewrite
npm link            # makes `sidewrite`, `sw`, and `ccx` point at your checkout
sidewrite doctor    # verifies your environment
```

Useful commands while developing:

```sh
npm run up          # start the local dashboard daemon
npm run status      # daemon health snapshot
npm run stop        # stop the daemon
```

The landing page under `landing/` is a separate Vite app with its own
`package.json`.

## Project invariants

Sidewrite has a few hard rules. PRs that break them will not be merged:

- **Zero runtime dependencies.** Only Node built-ins (`node:sqlite`,
  `node:http`, etc.). Do not add anything to `dependencies`.
- **Account safety.** Never proxy OAuth or run a Claude subscription headless.
  Never write `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` into `~/.claude` or
  a shell profile, and never log the user out. External sessions stay isolated
  under `CLAUDE_CONFIG_DIR=~/.claude-<provider>`.
- **Fail closed.** `ccx` must keep aborting when the base URL is
  `api.anthropic.com`, and mode reads resolve to
  `subscription | standalone | unknown` — never guess.

## How to contribute

1. **Open an issue first** for anything non-trivial, so we can agree on the
   approach before you spend time on it.
2. **Fork and branch** from `main` (`fix/...` or `feat/...`).
3. **Keep changes focused** — one logical change per PR.
4. **Test manually**: run `sidewrite doctor`, exercise the affected command,
   and check the dashboard still works if you touched the viewer.
5. **Open a PR** describing what changed and why. Link the related issue.

## Commit messages

- Short imperative subject line ("Fix mode detection on fresh installs").
- Explain the *why* in the body when it isn't obvious.

## Reporting bugs and security issues

- Bugs: [open an issue](https://github.com/hassanalitamam/sidewrite/issues)
  using the bug report template.
- Security vulnerabilities: **do not open a public issue** — see
  [SECURITY.md](SECURITY.md).

## Code of conduct

By participating, you agree to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache-2.0 License](LICENSE).

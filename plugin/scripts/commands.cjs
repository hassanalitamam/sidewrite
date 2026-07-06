'use strict';

/*
 * commands.cjs — the ONE CLI verb registry (plan §S10).
 *
 * Every subcommand `bin/sidewrite` can dispatch — plus every short alias
 * (`code|c|co`) — is declared exactly once, here. This table is the
 * canonical declaration of the verb set: `bin/sidewrite`'s bash `case`,
 * `cli.cjs`'s `--help` text, and `sidewrite completion` are meant to derive
 * FROM it (via `resolve()` / `COMMANDS`) rather than hardcode their own
 * copy, so adding a verb (or an alias for one) has a single home instead of
 * three that drift. NOTE: those consumers do not yet all read from here —
 * wiring each one to this registry (or reconciling any that still hardcode)
 * is the remaining work; until then this table is the intended, not yet the
 * enforced, single source.
 *
 * Pure data + a resolver. No filesystem/network I/O, no side effects —
 * safe to `require()` from the bash dispatcher's inline `node -e`, from
 * `cli.cjs`, and from a `__complete` shell-completion hook alike.
 *
 * Curated static aliases only (plan S10 point 1) — no prefix/abbreviation
 * matching, so `sidewrite c` always means the same thing regardless of
 * what other verbs happen to exist.
 */

/**
 * @typedef {{ desc: string, aliases: string[] }} CommandSpec
 */

/** @type {Record<string, CommandSpec>} */
const COMMANDS = {
  // -- pipeline -------------------------------------------------------------
  run: {
    desc: 'run the plan → implement pipeline (or: sidewrite <provider> "task…")',
    aliases: [],
  },
  code: {
    desc: 'launch an interactive Claude Code session on an external provider',
    aliases: ['c', 'co'],
  },

  // -- daemon / dashboard -----------------------------------------------------
  open: {
    desc: 'start the daemon if needed, then open the dashboard in a browser',
    aliases: [],
  },
  up: {
    desc: 'ensure the viewer daemon is running',
    aliases: ['start'],
  },
  stop: {
    desc: 'stop the viewer daemon',
    aliases: [],
  },
  status: {
    desc: 'print the daemon status snapshot',
    aliases: [],
  },
  url: {
    desc: 'print the dashboard URL',
    aliases: [],
  },

  // -- setup / lifecycle ------------------------------------------------------
  install: {
    desc: 'register sidewrite as a global Claude Code plugin + link CLIs',
    aliases: [],
  },
  uninstall: {
    desc: 'reverse install (keeps ~/.sidewrite data)',
    aliases: [],
  },
  setup: {
    desc: 'guided first-run setup (verify + provision)',
    aliases: [],
  },
  onboard: {
    desc: 'guided onboarding wizard for a new provider + model map',
    aliases: [],
  },
  bootstrap: {
    desc: 'provision a new provider/environment end-to-end, non-interactively',
    aliases: [],
  },
  doctor: {
    desc: 'verify environment (providers, keys, daemon, config)',
    aliases: [],
  },
  mode: {
    desc: 'print or set the sidewrite mode (subscription|standalone)',
    aliases: [],
  },
  undo: {
    desc: "revert files a run wrote back into the working dir",
    aliases: [],
  },

  // -- providers ----------------------------------------------------------
  provider: {
    desc: 'add/list/test/remove providers',
    aliases: [],
  },
  alias: {
    desc: 'install/uninstall a short shell alias for sidewrite (default: sw)',
    aliases: [],
  },

  // -- observability --------------------------------------------------------
  stats: {
    desc: 'show token/cost usage rollups',
    aliases: [],
  },
  errors: {
    desc: 'show recently captured errors',
    aliases: [],
  },
  telemetry: {
    desc: 'view or change the telemetry level (off|crash|error|all)',
    aliases: [],
  },
  flags: {
    desc: 'view or override remote-config feature flags',
    aliases: [],
  },
  prune: {
    desc: 'prune old run history/logs',
    aliases: [],
  },

  // -- updates --------------------------------------------------------------
  update: {
    desc: 'check for, or apply, a sidewrite update',
    aliases: [],
  },

  // -- shell integration ------------------------------------------------------
  completion: {
    desc: 'print a shell completion script (bash|zsh|fish)',
    aliases: [],
  },

  // -- meta -----------------------------------------------------------------
  help: {
    desc: 'show usage and the full command list',
    aliases: ['-h', '--help'],
  },
};

// Deep-freeze the registry so a consumer that `require()`s this module
// cannot inject a verb at runtime — an unfrozen COMMANDS lets
// `COMMANDS.evil = {…}` make `resolve('evil')` return 'evil', turning an
// attacker-controlled token into a dispatched command. Freeze each spec and
// its aliases array too, matching the frozen ALIASES below. (Reads of a
// frozen object are unaffected, so the ALIASES derivation still works.)
for (const spec of Object.values(COMMANDS)) {
  Object.freeze(spec.aliases);
  Object.freeze(spec);
}
Object.freeze(COMMANDS);

/**
 * Flat alias -> canonical-command lookup, derived once from COMMANDS so
 * there is exactly one place aliases are declared.
 * @type {Record<string, string>}
 */
const ALIASES = Object.freeze(
  Object.keys(COMMANDS).reduce((acc, name) => {
    for (const alias of COMMANDS[name].aliases) {
      acc[alias] = name;
    }
    return acc;
  }, /** @type {Record<string, string>} */ ({}))
);

/**
 * Resolve a raw first CLI token (argv[2] / `$1`) to its canonical command
 * name, or `null` if it isn't a known command or alias (e.g. it's a
 * provider name meant for the `sidewrite <provider> "task…"` catch-all, or
 * an empty/bare invocation the caller handles itself).
 *
 * Exact-match only — no prefix/abbreviation matching, case-sensitive
 * (all declared tokens are lowercase, `-h`/`--help` excepted).
 *
 * @param {unknown} argv0
 * @returns {string|null}
 */
function resolve(argv0) {
  if (typeof argv0 !== 'string' || argv0.length === 0) return null;
  if (Object.prototype.hasOwnProperty.call(COMMANDS, argv0)) return argv0;
  if (Object.prototype.hasOwnProperty.call(ALIASES, argv0)) return ALIASES[argv0];
  return null;
}

module.exports = { COMMANDS, ALIASES, resolve };

/* ── self-test ──────────────────────────────────────────────────────────── */
if (require.main === module) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  let pass = 0, fail = 0;
  function assert(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else      { fail++; console.error('  ✗ ' + label); }
  }

  console.log('commands.cjs self-test:');

  // Run under a temp HOME override so this module — and anything it may
  // grow to touch later — never reads/writes real ~/.sidewrite.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidewrite-commands-test-'));
  const realHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    const commandNames = Object.keys(COMMANDS);

    // 1. Every declared command name resolves to itself.
    let allNamesResolve = true;
    for (const name of commandNames) {
      if (resolve(name) !== name) allNamesResolve = false;
    }
    assert(allNamesResolve, 'every canonical command resolves to itself');

    // 2. Curated aliases resolve to the right canonical command.
    assert(resolve('c') === 'code', 'alias "c" -> "code"');
    assert(resolve('co') === 'code', 'alias "co" -> "code"');
    assert(resolve('start') === 'up', 'alias "start" -> "up"');
    assert(resolve('-h') === 'help', 'alias "-h" -> "help"');
    assert(resolve('--help') === 'help', 'alias "--help" -> "help"');

    // 3. Every alias in the ALIASES table round-trips through resolve().
    let allAliasesResolve = true;
    for (const [alias, canonical] of Object.entries(ALIASES)) {
      if (resolve(alias) !== canonical) allAliasesResolve = false;
    }
    assert(allAliasesResolve, 'every ALIASES entry resolves via resolve()');

    // 4. Unknown tokens (provider names, garbage, empty/undefined) resolve
    //    to null so the caller's catch-all pipeline fallback still fires.
    assert(resolve('openrouter') === null, 'unknown token (provider name) -> null');
    assert(resolve('') === null, 'empty string -> null');
    assert(resolve(undefined) === null, 'undefined -> null');
    assert(resolve(null) === null, 'null -> null');
    assert(resolve(123) === null, 'non-string -> null');

    // 5. No collisions: no alias token is also a canonical command name
    //    (that would silently shadow one or the other), and no alias
    //    token is declared more than once across different commands.
    const seenAliasOwners = new Map(); // alias -> owning command name
    let noAliasCollidesWithCommand = true;
    let noDuplicateAliasAcrossCommands = true;
    for (const name of commandNames) {
      for (const alias of COMMANDS[name].aliases) {
        if (Object.prototype.hasOwnProperty.call(COMMANDS, alias)) {
          noAliasCollidesWithCommand = false;
        }
        if (seenAliasOwners.has(alias) && seenAliasOwners.get(alias) !== name) {
          noDuplicateAliasAcrossCommands = false;
        }
        seenAliasOwners.set(alias, name);
      }
    }
    assert(noAliasCollidesWithCommand, 'no alias shadows a canonical command name');
    assert(noDuplicateAliasAcrossCommands, 'no alias is declared under two commands');

    // 6. Every command has a non-empty description (single-sources help text).
    let allHaveDesc = true;
    for (const name of commandNames) {
      if (typeof COMMANDS[name].desc !== 'string' || COMMANDS[name].desc.length === 0) {
        allHaveDesc = false;
      }
    }
    assert(allHaveDesc, 'every command has a non-empty description');

    // 7. ALIASES is frozen (single source is COMMANDS; ALIASES is derived,
    //    not hand-maintained, and must not be mutated at runtime).
    let threw = false;
    try { ALIASES.bogus = 'x'; } catch (e) { threw = true; }
    assert(Object.isFrozen(ALIASES), 'ALIASES is frozen');
    assert(!Object.prototype.hasOwnProperty.call(ALIASES, 'bogus'), 'ALIASES mutation is a no-op/throws');

    // 8. COMMANDS is frozen too (a require()r must not be able to inject a
    //    verb that resolve() would then honour). Deep: specs frozen as well.
    try { COMMANDS.evil = { desc: 'x', aliases: [] }; } catch (e) { /* strict-mode throw */ }
    assert(Object.isFrozen(COMMANDS), 'COMMANDS is frozen');
    assert(resolve('evil') === null, 'injected COMMANDS entry does not resolve');
    assert(Object.values(COMMANDS).every((s) => Object.isFrozen(s)), 'every command spec is frozen');
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  console.log('\nResult: ' + (fail === 0 ? 'PASS' : 'FAIL') + ' (' + pass + ' passed, ' + fail + ' failed)');
  if (fail !== 0) process.exit(1);
}

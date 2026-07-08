# Security Policy

Sidewrite handles provider API keys and talks to external model providers, so
we take security reports seriously.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.3.x   | ✅        |
| < 0.3   | ❌        |

Only the latest release published to npm receives security fixes.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use one of these private channels:

1. **GitHub private vulnerability reporting** (preferred):
   [Report a vulnerability](https://github.com/hassanalitamam/sidewrite/security/advisories/new)
2. **Email**: hsnnet963@gmail.com with the subject line `[SECURITY] sidewrite`

Please include:

- A description of the issue and its impact
- Steps to reproduce (a minimal proof of concept helps a lot)
- The sidewrite version and platform you tested on

## What to expect

- An acknowledgement within **72 hours**
- A status update within **7 days**
- Credit in the release notes once a fix ships, unless you prefer to stay
  anonymous

## Scope

Reports we especially care about:

- API key leakage (keys written to logs, shell profiles, `~/.claude`, or sent
  to the wrong host)
- Bypasses of the account-safety invariants (OAuth proxying, running a
  subscription headless, `ccx` reaching `api.anthropic.com`)
- The local dashboard exposing data beyond `127.0.0.1` or leaking secrets to
  the browser

Out of scope: vulnerabilities in the external model providers themselves, or
issues requiring an already-compromised machine.

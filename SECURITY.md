# Security Policy

DEALORA handles business data, credentials, and externally facing actions.
Security is a first-class requirement from day one (`DEALORA_BLUEPRINT.md` §44,
`ROADMAP.md` §37, §45).

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

1. Use GitHub's private reporting: **Security → Report a vulnerability** on the
   `blockora/Dealora` repository.
2. Include the affected component, impact, and reproduction steps.
3. Avoid including real customer data or live credentials in the report.

You will receive an acknowledgement as soon as practicable, and the issue will
be coordinated privately until a fix is available.

## Non-negotiable security constraints

These constraints outrank every other requirement in the repository
(`ROADMAP.md` §57, source-of-truth hierarchy):

- **No hardcoded secrets.** Credentials come from environment variables or the
  hosting secret store; `.env` files are never committed.
- **No bypassing authentication or authorization.** Authorization is enforced
  server-side; the UI is never the only guard. Workspace/tenant data stays
  isolated.
- **No platform or API restriction bypass.** DEALORA uses permitted APIs and
  approved data sources only — never robots/access-control or ToS evasion.
- **No credential theft, unauthorized account access, mass-spam
  infrastructure, fabricated evidence, or fabricated business claims.**
- **Least privilege.** Every tool, integration, and token has explicit,
  scoped permissions.
- **Human control.** External side effects (Level 2) and high-impact actions
  (Level 3) require approval/policy authorization. Nothing consequential runs
  silently.
- **Auditability.** Every consequential action produces an audit trail;
  important failures are never hidden.
- **Rate limits, stop conditions, opt-out handling, and a kill switch** guard
  all outbound activity.

## Baseline for contributions

Every pull request must verify (see `CONTRIBUTING.md`):

- no secrets, keys, or `.env` values in the diff,
- no new external side effect without the approval/policy layer,
- failure paths defined for anything that can fail externally,
- permission/tenant-isolation implications reviewed.

## Supported versions

Only the latest commit on `main` is supported during the pre-release phase.

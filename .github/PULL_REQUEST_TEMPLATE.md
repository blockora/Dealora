## Summary

<!-- What changed and why? Link the source-of-truth requirement. -->

## Roadmap phase / source of truth

<!-- e.g. ROADMAP.md Phase 3 — Revenue Goal Engine; DEALORA_BLUEPRINT.md §7 -->

## Quality gates

- [ ] `bun run lint`
- [ ] `bun run format:check`
- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run build`

## Security & permissions

- [ ] No secrets, credentials, or `.env` values committed
- [ ] Authorization enforced server-side; workspace/tenant isolation preserved (or N/A)
- [ ] New external side effects pass the approval/policy layer (or N/A)

## Failure handling

- [ ] Failure paths defined for anything that can fail externally (or N/A)

## Documentation

- [ ] Docs/ADR updated if architecture or behavior changed

# Temps design-system source snapshot

Source: `gotempsh/temps`, worktree `design-system-ds`, HEAD `eeed336a2085bb3887aac97cbeae67325c1ee102` (including the worktree contents at integration time).

These are the actual components from `web/packages/ds/src` and their required primitives from `web/src/components/ui`. Only import paths are adapted to make this plugin independently buildable. `cn.ts` supplies the same clsx/tailwind-merge helper. `ds/tokens.css` is copied without changes. Copyright and dual-license notices are preserved.

The source packages currently reference files outside their package roots and workspace dependencies. This checked-in subset avoids a dependency on a developer's filesystem. Replace it with published standalone packages when available. Refresh components and tokens from the source worktree together; do not make plugin-specific visual edits here.

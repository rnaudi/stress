# Comment taxonomy

Great comments are documentation. Every public item should carry a doc comment (`/** */` TSDoc) so typedoc, IDE hovers, and generated docs surface the same guidance reviewers rely on. Inline `//` belongs to private helpers or single statements that truly need annotation.

## Structuring doc comments

The taxonomy categories below (Function, Design, Why, Teacher, Checklist, etc.) describe the **purpose** of a comment, not labels to insert into the text. Do not use Markdown headings like `# Design` or `# Why` inside doc comments. Write flowing prose instead -- a concise summary followed by rationale, constraints, or examples as needed.

For functions, classes, interfaces, and types, lead with a concise summary and keep any rationale in plain prose. Use `@example` for runnable snippets because typedoc groups them automatically.

Module or entry-point files should start with a file-level `/** @module */` comment that covers intent, scope, design trade-offs, and non-obvious constraints in flowing prose so readers can orient themselves quickly.

Example:

```ts
// view/renderer.ts

/**
 * @module renderer
 *
 * Viewport renderer for the gh-log dashboard. Renders summary, detail, and
 * tail panes using a terminal backend. Keeps interaction logic isolated so
 * data and configuration layers stay testable.
 *
 * A single `AppState` orchestrates the active view and scroll state.
 * `DetailMode` toggles between weekly and repo breakdown without
 * reallocations. A shared render buffer avoids flicker while switching panes.
 *
 * Scroll math tracks both content height and viewport height so resizes
 * never trap the cursor below the fold.
 *
 * @example
 * ```ts
 * import { runUI } from "./renderer";
 *
 * const terminal = createTerminal(process.stdout);
 * await runUI(terminal, monthData);
 * ```
 */
```

## Function comments

- Explain what the function promises and when to call it so readers can skip the body.
- Keep the note beside the signature; the code and comment should travel together.
- Surface rationale in plain prose near the summary so the documentation reads naturally.
- Add an `@example` section when a snippet clarifies usage; typedoc will render it in the standard Examples tab.
- Use `/** */`; for private helpers, fall back to `//` only if the guidance is truly local.

Example:

```ts
// github.ts

/**
 * Fetch pull requests authored by the current user within the provided month (YYYY-MM).
 *
 * GitHub search paginates reliably only with cursors, so we walk the entire page chain
 * to avoid missing PRs in busy months.
 *
 * @example
 * ```ts
 * const client = new CommandClient();
 * const prs = await client.fetchPRs("2025-01");
 * console.log(`Fetched ${prs.length} PRs`);
 * ```
 */
export async function fetchPRs(month: string): Promise<PullRequest[]> {
  // ...
}
```

## Design comments

- Describe the big idea for the file, module, or subsystem and the trade-offs you accepted.
- Keep the rationale in clear sentences on public items so it lands in generated docs.
- Focus on invariants ("single writer, many readers"), concurrency or memory strategies, and what would break if the design changed.

Example:

```ts
// cache.ts

/**
 * @module cache
 *
 * Cache layer for month-level PR aggregates. Uses a write-through cache
 * keyed by `YYYY-MM` to keep CLI invocations quick. File locking ensures
 * the CLI and TUI never stomp on each other. JSON payloads stay stable so
 * older versions can read newer cache files.
 */
```

## Why comments

- Spell out the hidden reason for an ordering, threshold, or guard clause.
- Work the reasoning directly into the doc comment; rely on inline `//` for a single statement that needs context.
- Highlight constraints (API quirks, time zones, data contracts) that aren't obvious from the signature.

Example:

```ts
// cache.ts

/**
 * Remove the stale cache file first so schema migrations never mix old and new
 * formats in a single document.
 */
export async function rewriteCache(cachePath: string, data: CachedData): Promise<void> {
  await fs.rm(cachePath);
  await writeCache(cachePath, data);
}
```

## Teacher comments

- Teach the background math, protocol, or data structure.
- Put the lesson immediately before the lines that rely on it.
- For reusable helpers, encode the explanation as a doc comment and include formulas or tables when they clarify behavior.

Example:

```ts
// data.ts

/**
 * Lead time equals `updatedAt - createdAt`; clamp negatives to zero to hide clock skew.
 */
export function leadTime(updatedAt: Date, createdAt: Date): number {
  return Math.max(updatedAt.getTime() - createdAt.getTime(), 0);
}
```

## Checklist comments

- Remind maintainers about other spots to touch or the order to follow when tooling cannot enforce it.
- Keep reminders short and actionable; delete them once tests or automation cover the rule.
- Link to follow-up issues when the checklist implies ongoing work.

Example:

```ts
// config.ts

/**
 * Adding another filter list requires updating `Config.validate()`
 * and the CLI regression tests in `tests/cli.test.ts`.
 */
export interface FilterConfig {
  ignorePatterns: string[];
}
```

## Guide comments

- Break long functions into sections with light headings (Step 1/2/3).
- Use sparingly; if many steps are needed, consider extracting helpers.
- Inline `//` or block comments are acceptable here because the guidance is local to the routine.

Example:

```ts
// view.ts

// Step 1: compute panel rectangles before drawing widgets.
const chunks = layout({
  direction: "vertical",
  constraints: [{ length: summaryHeight }, { min: 0 }],
}).split(area);

// Step 2: render summary panel first so scrollbar state stays coherent.
renderSummary(frame, chunks[0], month);
```

## Trivial comments

- Delete comments that merely restate the code.
- Replace them with Function, Why, or Teacher guidance if deeper context is needed.

## Debt comments

- Mark shortcuts with clear exit criteria and a review date.
- Prefer `TODO(issue#)` or `FIXME` with a link; escalate long-lived notes into the issue tracker.
- Revisit debt comments during each release cut.

Example:

```ts
// cache.ts

/* TODO:#182 cap cache JSON at 5 MB once serializer benchmarks land. */
if (cacheSize > MAX_CACHE_BYTES) {
  scheduleCompaction();
}
```

## Backup comments

- Never check in old code blocks commented out. Version control already stores history.
- Delete temporary fallbacks once the new behavior ships.

## Review checklist

- [ ] Doc comments start with a concise summary; rationale follows in flowing prose.
- [ ] Public APIs include `@example` when usage benefits from a snippet.
- [ ] Design and Why rationales appear where the next maintainer will look first.
- [ ] Checklist and Debt notes point to enforceable steps or tracked issues.
- [ ] Trivial or stale comments were culled during the change.

## References

- ["Writing system software: code comments"](https://www.antirez.com/news/124)
- [Bitask doc comment example](https://github.com/vrnvu/bitask/blob/master/src/db.rs)

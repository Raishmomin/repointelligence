# Repository Intelligence Engine

A VS Code extension that indexes your codebase into a local knowledge base, then uses it to ground an approval-gated coding agent. The agent reads freely, edits surgically, and stops for your approval before it writes anything to disk or runs any command.

Works against **Claude** (via the Anthropic API) for full autonomy, or **Ollama** for a fully local, offline setup.

---

## Architecture

Three layers, each depending only on the ones below it.

### Layer 1 — Intelligence (`src/layer1-intelligence/`)

Turns a directory of files into structured facts.

| Module | Responsibility |
|---|---|
| `scanner/` | Walks the workspace, honours `.gitignore`, classifies and size-filters files |
| `ast/` | `ts-morph` parsing → symbols, imports, and code patterns (**TS/JS only**; other languages are indexed as raw text) |
| `framework/` | Detects React, Next.js, NestJS, Express, plain Node |
| `graph/` | Builds the file-level dependency graph |
| `packages/` | Reads manifests to identify dependencies |

### Layer 2 — Context (`src/layer2-context/`)

Stores those facts and retrieves the relevant slice for a given question.

| Module | Responsibility |
|---|---|
| `database/` | `sql.js` (WASM SQLite) store — projects, files, symbols, dependencies, embeddings, agent runs, change sets |
| `search/` | Hybrid retrieval: keyword (0.4) fused with semantic cosine similarity (0.6) |
| `context/` | Assembles a token-budgeted context window |
| `prompt/` | Builds grounded prompts |
| `validation/` | Infers the repo's own conventions |

### Layer 3 — Reasoning (`src/layer3-reasoning/`)

Runs the agent loop.

| Module | Responsibility |
|---|---|
| `providers/` | `LlmProvider` abstraction over Anthropic and Ollama |
| `agent/` | The turn loop, tool registry, change sets, command execution, safety checks |

`src/vscode/` holds commands, webview and tree providers, and file watchers. `src/container.ts` is the service container.

---

## The safety model

This is the part worth understanding before you trust the agent with a repository.

**Reads are free. Writes are not.**

- `read_file`, `glob`, `grep`, and `query_index` execute immediately with no prompt, so the agent can explore without interrupting you.
- Every file mutation and every shell command is a *proposal*. It shows you a diff or a command preview and waits for an explicit approval.

**Guarantees enforced in code:**

| Guarantee | Mechanism |
|---|---|
| The agent cannot touch files outside the workspace | `pathGuard` rejects absolute paths and anything escaping the root, including via `..` |
| The agent cannot read secrets | `agent.ignorePatterns` blocks path segments such as `.env`, `node_modules`, `.git`, checked on the *resolved* path so `a/../.env` is caught too |
| The agent cannot edit a file it hasn't read | Read-before-Edit, enforced inside every edit tool before any I/O |
| The agent cannot clobber a file that changed underneath it | The file is re-read from disk and hashed against what the agent saw; re-verified again at apply time, since approval can sit pending for minutes |
| An ambiguous edit is refused, not guessed | `str_replace` requires a unique match and reports the occurrence count instead of editing the first one |
| Commands cannot become shell injection | `spawn` with `shell: false`; the executable must be a single literal token, arguments passed separately |
| Every applied change can be undone | A `git stash create` checkpoint is taken before applying — a dangling commit that changes no other git state — with per-operation content snapshots as the fallback |
| Nothing happens without a record | Runs, transcripts, change sets, command requests, and approvals are all persisted |

**One write path.** `ChangeSetService` is the only module permitted to mutate workspace files. An ESLint rule (`no-restricted-syntax` in `eslint.config.mjs`) fails the build if any other module calls `writeFileSync` and friends — so the guarantees above cannot be bypassed by accident.

---

## Getting started

```bash
npm install
npm run build
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

**With Claude:** run `Repo Intelligence: Set Anthropic API Key` from the command palette. The key is stored in VS Code's `SecretStorage` — never in `settings.json`, never in the repo.

**With Ollama:** install [Ollama](https://ollama.com), then `ollama pull qwen2.5-coder:7b`. Set `repo-intelligence.provider` to `ollama`.

Then run `Repo Intelligence: Scan Repository` and open the Repo Intelligence view in the activity bar.

---

## Development

```bash
npm run watch      # esbuild in watch mode
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest
npm run package    # build a .vsix
```

All four gates must be green before a change lands.

### Testing approach

Unit tests run outside the extension host. `test/mocks/vscode.ts` stands in for the `vscode` module (aliased in `vitest.config.ts`), which is what makes the agent layer testable at all. Tools receive their dependencies through an injected `ToolContext` rather than reaching into the service container, for the same reason.

The agent loop is integration-tested against a scripted `MockProvider` that replays a fixed sequence of turns — this covers approval parking, cancellation, and error-result handling without touching a real API.

### Manual smoke checklist

Not automated; run before releasing.

1. <kbd>F5</kbd> → set API key → `Scan Repository` completes without error
2. Ask the agent for a change spanning two files
3. The step timeline streams reasoning and tool calls live
4. The diff shows **only** the changed hunks, not whole-file rewrites
5. Approve → exactly those hunks are applied
6. `Revert Applied Change Set` → the working tree returns to its prior state
7. Cancel mid-run → the loop stops promptly and leaves no partial writes

---

## Known limitations

- AST-level understanding is TypeScript/JavaScript only; other languages fall back to text indexing, and their embeddings use fixed-size windows rather than per-symbol chunks.
- Semantic search requires Ollama for embeddings even when Claude is the chat provider — the Anthropic API has no embeddings endpoint. Without Ollama, retrieval degrades to keyword-only.
- Embedding a large repository is expensive and is therefore off by default (`search.enableEmbeddings`).
- Brute-force cosine similarity is fine to roughly 50k vectors; beyond that, retrieval will visibly stall.
- Approving a change re-indexes the whole repository (debounced to once per burst). A genuinely incremental re-index is not implemented.
- A run parked awaiting approval lives in memory. Its transcript is persisted, but reloading the window before deciding abandons the run rather than resuming it.
- The chat panel renders the agent timeline read-only; approving still goes through the command palette.

## License

MIT

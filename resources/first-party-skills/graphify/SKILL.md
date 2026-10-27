---
name: graphify
description: >-
  Map a folder or codebase into a queryable knowledge graph with the graphify CLI
  (local tree-sitter AST, zero LLM cost) and answer structure questions from it:
  架构 / 依赖关系 / 什么调用了 X / A 和 B 怎么关联 / 这个项目怎么组织 / 知识图谱 /
  graphify. Trigger when the user points at a project directory and asks about
  its structure, wants a graph or architecture report of it, or types /graphify
  or $graphify. Query an existing graphify-out/ first; build one only when missing.
---

# graphify — code / folder → knowledge graph (in-app agent edition)

<!-- skill-budget: fast -->

graphify turns a directory into `graphify-out/` with three files: `graph.json`
(the graph you query), `GRAPH_REPORT.md` (hubs, communities, surprising
connections, suggested questions) and `graph.html` (clickable). Every edge is
tagged `EXTRACTED` (explicit in source) or `INFERRED` (resolved by graphify), so
you can tell what was read from what was guessed. Code is parsed locally with
tree-sitter — no model call, nothing leaves the machine.

This is the compact edition shipped with the CATIMATION app. If the user has
installed the official skill (`graphify install --platform agents`), that copy
replaces this one and its longer pipeline applies instead.

## Step 0 — pin the target directory

- Use the folder the user named. Without one, use the current thread workspace
  root. Never run on `~`, a drive root, or a parent that contains other projects.
- Quote paths with spaces. In PowerShell type `graphify`, not `/graphify`
  (the leading slash is a path separator there).

## Step 1 — make sure the CLI exists (ask before installing)

```
graphify --version
```

If that fails, tell the user graphify is missing and offer to install it:

```
uv tool install --python 3.13 "graphifyy[sql]"     # preferred (isolated env)
pipx install graphifyy                              # alternative
python -m pip install --user graphifyy              # last resort
```

The PyPI package is `graphifyy` (double y); the command is `graphify`. Pin
Python 3.13 — networkx breaks on CPython 3.14.1. On Windows the binary lands in
`%USERPROFILE%\.local\bin`; if a fresh shell still cannot find it, call it by
full path (`"$env:USERPROFILE\.local\bin\graphify.exe"`). Do not install
anything without an explicit yes from the user.

## Step 2 — fast path: the graph already exists

If `<dir>/graphify-out/graph.json` exists and the request is a question (how
does X work / what calls Y / trace Z), do NOT rebuild. Go straight to Step 4.

## Step 3 — build (local, free)

```
graphify update <dir>                     # ~1 min per 1000 files; writes graph.json + GRAPH_REPORT.md + graph.html
```

- `update` is the AST-only path: code via tree-sitter plus a heading/link scan
  of Markdown, no model call. It works from a cold start (no `graphify-out/`
  yet) and is the same command used to refresh later, so the graph never
  changes shape between builds. Do not use `graphify extract --code-only` for
  the initial build — it omits the Markdown layer that `update` will add anyway.
- Tell the user roughly how long it will take before starting; run it in the
  foreground — it needs no interaction.
- If the directory contains vendored bundles, minified JS, build output, media
  or generated mirrors, write a `<dir>/.graphifyignore` (gitignore syntax, merged
  on top of `.gitignore`) before extracting. Junk hubs with two-letter names
  (`tu`, `Yt`, `__`) in the report mean a minified file slipped in — add it to
  `.graphifyignore` and re-run with `--force`.
- Concepts inside docs, PDFs and images are **not** in this default build (only
  Markdown structure is). They need a model pass: `graphify extract <dir>
  --backend openai` with `OPENAI_BASE_URL` / `OPENAI_API_KEY` (or `--backend
  claude|gemini|ollama`). Only do this when the user explicitly wants document
  content in the graph and provides or approves a backend — never reuse the
  app's image/video gateway token for it silently, and never paste keys into
  the chat.
- Community names stay `Community N` without a backend. That is fine; the hub
  names in the report are what you navigate by.

## Step 4 — answer from the graph, then confirm in source

```
graphify query "<the user's question>" --budget 1500
graphify path "<SymbolA>" "<SymbolB>"                # add --undirected if no directed path
graphify explain "<Symbol or file>"
```

- Start with `query`; narrow with `path`/`explain`. Raise `--budget` only when
  the answer is clearly among the truncated nodes.
- Every node carries `src=<file> loc=L<line>` and every edge an EXTRACTED /
  INFERRED tag. Open the two or three files the graph points at to verify before
  stating how something works; say which claims are INFERRED.
- Summarize in prose with file:line citations. Do not paste raw graph output.
- `GRAPH_REPORT.md` is for broad "what is this project" questions; open
  `graph.html` in the browser when the user wants to explore (above 5000 nodes
  it shows an aggregated community view).

## Keeping the graph current

- After editing code in that directory: `graphify update <dir>` (AST only).
- After deleting or excluding files: `graphify update <dir> --force`, otherwise
  the shrink guard keeps the stale nodes.
- `graphify-out/` is an artifact. Do not commit it unless the user asks; suggest
  adding it to `.gitignore` if the directory is a git repo.

## Boundaries

- `graphify update` sends nothing anywhere. The documents pass (`extract
  --backend …`) sends file contents to whichever backend the user configured —
  say so before running it.
- Do not loop: one build, one report, then answer. If extraction fails
  (missing grammar extra, sensitive-file skip, Python version), report the exact
  message and the one-line fix rather than retrying blindly.

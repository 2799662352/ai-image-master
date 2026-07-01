/**
 * Native `/init` alignment.
 *
 * Codex's slash commands (`/init`, `/model`, `/pets`, …) live entirely in the
 * Rust TUI (`codex-rs/tui/src/slash_command.rs`) — they are NOT app-server
 * RPCs. The TUI's `/init` simply sends the prompt below as a normal user turn,
 * and the agent (a coding agent with file-write in the workspace) generates the
 * `AGENTS.md`. Our Electron GUI talks to the same app-server over `turn/start`,
 * so we reproduce `/init` the only possible way: send this exact prompt as a
 * turn against the current workspace `cwd`.
 *
 * The text is copied VERBATIM from Codex's `codex-rs/tui/prompt_for_init_command.md`
 * (fetched from the shipped upstream) so behavior — including the "do not
 * overwrite an existing AGENTS.md" guard — matches native exactly. Keep it in
 * sync if upstream changes it.
 */
export const INIT_AGENTS_MD_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`

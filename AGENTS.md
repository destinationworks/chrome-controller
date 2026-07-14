# Agent Working Agreement

This file contains instructions for automated coding agents.

## Chrome Controller Startup

Before using `chrome_*` tools, ensure the bridge server is running:

```bash
cd /Users/dst/dev/chrome-controller && npm start
```

This single command handles everything: kills stale servers, rebuilds if source changed, starts the server, and verifies it's healthy. The extension in Chrome must also be loaded (`Chrome Extension/` as unpacked MV3).

Verify with:

```bash
curl -s http://127.0.0.1:8898/health
```

If the extension is not connected, reload it in `chrome://extensions`.

## User Updates

While actively working, reread `user-updates.md` for new instructions at least once per minute and incorporate any new guidance before continuing.

## Refactoring Guidelines (LSP/MCP)

Before executing any semantic refactoring (TypeScript/JavaScript, HTML, Rust), the agent must:

1. Run diagnostics for the target file/project to verify baseline state.
2. Use symbol tools (`definition`, `references`, `hover`, `workspace symbols`) to explore impact.
3. Prefer LSP rename/code-action tools over manual text/regex edits wherever possible.
   - For TS/JS: Use `ts-js-lsp` (`typescript-language-server`).
   - For HTML: Use `html-lsp` (`vscode-html-language-server`).
   - For Rust: Use `rust-lsp` (`rust-analyzer`) and/or `rust-analyzer-native` (`rust-analyzer-mcp`).
4. After making edits, run compiler/validation checks:
   - TS/JS: `npm test`, `npm run typecheck`, `npm run lint` (if available).
   - Rust: `cargo fmt`, `cargo clippy`, `cargo test`.
5. Never perform large cross-module or architectural refactors without creating a plan first.

---
name: deepseek-novel-reader
description: Inspect, test, package, and maintain the DeepSeek Harness novel reader in this plugin.
---

# DeepSeek Novel Reader

Use this project skill when maintaining the bundled DSH client plugin.

1. Keep parsing and storage logic in `src/shared` or `src/client/storage` so it remains independently testable.
2. Register browser UI only through the additive `shell.overlay` slot in `src/client/index.tsx`.
3. Put every global browser side effect in `ctx.effect()` and return its cleanup function.
4. Run `npm run typecheck`, `npm test`, and `npm run build` before delivery.
5. Treat all novel content as local-only; do not add network transmission.

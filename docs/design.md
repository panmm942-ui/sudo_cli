# codexcli 0.3 design

Project codexcli; command sudocli; SUDO CLI ASCII identity. Terminal-only custom Node UI over official open-source Codex0.160.1 private app-server, isolated temporary CODEX_HOME and ephemeral threads. Model setup is interactive with keys/settings kept in memory.

The dashboard shows date/time, OS, working state, API status, model, observed connection health, reported context, permissions, Web, session worked time and lifetime total, plus activity/project. Its temporary screen uses the supplied escape sequences, erased CRLF frames, monotonic refresh scheduling, resize handling and exit/signal restoration. Input keys remain hidden during redraw/resize.

Health tracks real upstream requests, first semantic native Responses output or buffered Chat reply readiness. Recent latency/errors and pending wait produce a heuristic percentage: green>70, orange51–70, red<=50. Unknown stays unknown. Native stream completion is validated, including long terminal events. Cancelled requests are excluded.

Worked counts monotonic agent/tool time and pauses for idle input/approvals. Session resets each launch. Unique atomic scalar checkpoints persist lifetime duration without storing key/model/endpoint/content or losing concurrent usage. Normal exit flushes; crash loss is limited by the last successful checkpoint.

Ask uses workspace/on-request policy, including stricter Windows fallback. Allow Everything is explicit never/full access. Web Off disables hosted search and HTTP MCP and requests disabled sandboxed-command network in Ask. Full-access/approved escalation can still use OS networking; model API remains available. Runtime switches start new conversations.

First setup verifies/installs the pinned native runtime, then registers a current-user wrapper and PATH/startup block without admin privileges. Foreign commands and unrelated settings are protected. Windows portable includes Node/native engine; the source installer maps Linux/Windows/macOS x64/arm64. Windows/Linux native execution is verified; native Mac/ARM remains pending.

# Third-party source and runtimes

The MIT license at the project root covers the new sudo cli frontend and tests. It does not replace upstream licenses.

| Component | Included material | License/provenance |
| --- | --- | --- |
| OpenAI Codex 0.160.1 | `runtime/<platform>-<arch>/`; complete source archive under `upstream/` | Apache 2.0; see `licenses/CODEX-APACHE-2.0.txt`, `licenses/CODEX-NOTICE.txt`, and source archive for third-party notices |
| Node.js 24.19.0 | `runtime/node.exe` | MIT and included dependency notices; see `licenses/NODE-LICENSE.txt` |

Codex source: <https://github.com/openai/codex>, tag `rust-v0.160.1`, commit `d27764b82f7118f674371e6d6e76271d9d606edb`. Version 0.2 uses the official native release package, verified against its pinned archive size and SHA-256 hash. Each installed package includes `sudo-runtime.json` with its download provenance. The source snapshot references the matching released version; binaries were not locally compiled from it. Version 0.1's independently copied legacy Windows binaries can remain in a previously extracted working folder; the current launcher prefers its matching native package.

Node license source: <https://github.com/nodejs/node/blob/v24.19.0/LICENSE>. The Node executable was copied from the local bundled workspace runtime. `runtime/manifest.json` records versions, file sizes, and SHA-256 hashes.

OpenAI, Codex, and other product names belong to their respective owners. sudo cli is an independent frontend and is not an OpenAI product.

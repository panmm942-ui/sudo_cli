# Signed release integrity

codexcli 0.6.8 ships an Ed25519-signed source manifest. The launcher and both setup entrypoints authenticate the manifest and their own verification helpers before loading application code, then verify the complete source inventory and SHA-256 of each distributed file. A changed credit, source file, test, notice, upstream source archive, or launcher refuses startup. Missing signatures and manifests refuse startup. There is no environment-variable bypass.

`release-integrity.json` is canonical UTF-8 JSON with one trailing LF. Its fields, in order, are `format`, `schemaVersion`, `version`, `algorithm`, `digest`, `keyId`, and `files`. The format is `codexcli-release-integrity`, schema version is `1`, algorithm is `ed25519`, and digest is `sha256`. `keyId` is the SHA-256 of the publisher public key's SPKI DER encoding. Each sorted file record contains `path`, `bytes`, and `sha256`, in that order. `release-integrity.sig` contains the detached 64-byte Ed25519 signature over the exact manifest bytes. The pinned public key is distributed; the publisher private key is not.

The inventory includes every regular root file and every file beneath `.github`, `bin`, `src`, `scripts`, `docs`, `test`, `tests`, `licenses`, and `upstream`. It requires the package metadata, primary launchers, CLI, verification code, setup code, credits, and license notices. Added and removed files invalidate the inventory. Unknown root directories, traversal paths, duplicate or case-conflicting names, symbolic links, junctions, hardlinks, nonregular files, and noncanonical manifests are refused. Verification checks sizes and hashes from bounded file reads and checks that each opened file remained the same during that read.

`runtime` is excluded because the existing native and portable runtime verifier checks its platform, pinned upstream version, archive checksum, layout, and runtime manifest separately. Developer `.git` and `node_modules` directories are excluded. Python `__pycache__` directories and `.pyc`/`.pyo` cache files are excluded so running the supplied manual Python tests does not modify the source inventory. The two manifest files exclude themselves to avoid recursive hashes. No other source-directory exclusion is allowed.

The limits are a 4 MiB manifest, 10,000 signed files, 1,024 characters per path, 32 path components, 128 MiB per source file, and 256 MiB of source bytes. Signing rejects private-key blocks and credential/private-key filenames in the source tree. The signing key itself must be a regular unlinked file outside the release tree. There is no automatic signing, private-key download, or private-key creation during setup or startup.

## Publishing

Keep the publisher key outside the project, release staging tree, and output/archive directories. Protect its parent directory and file with owner-only operating-system permissions; on Windows use a restricted ACL. A release never includes the publisher private key. To create a new key pair at an explicitly chosen external location:

```text
node scripts/sign-release.mjs --generate-key /absolute/publisher/release-ed25519-private.pem
```

The command refuses existing destinations and writes the public key to the explicit key path plus `.pub`. It never prints key material. Pin that public key in `bin/sudocli.mjs`, both setup bootstraps (`scripts/setup.mjs` and `scripts/setup-runtime.mjs`), and `src/release-public-key.mjs`. Keep the expected version in each bootstrap aligned with the release. Retain the private key securely for future releases; replacing the publisher key also requires an intentional trusted-key update for installed clients.

After all source, metadata, documentation, and launchers are final, sign the exact release tree:

```text
node scripts/sign-release.mjs --root /absolute/release/codexcli --version 0.6.8 --key /absolute/publisher/release-ed25519-private.pem
```

The tool checks package-version agreement, writes both integrity files, and independently verifies the resulting release before reporting its manifest hash. If any distributed source changes afterward, sign again before producing archives and checksums. Source and portable packages share identical signed source bytes; portable packages add separately verified runtime files. Archive extraction must preserve the signed bytes exactly.

Programmatic verification uses `verifyReleaseIntegrity({root, expectedVersion, publicKey})`; omitting `publicKey` uses the pinned publisher key. It returns the authenticated version, file count, manifest SHA-256, and key ID. Update installation verifies signed releases from 0.6.4 onward before executing their setup or doctor code. Previously retained unsigned releases through 0.6.3 remain compatible with the existing verified update and rollback process.

## What this protects

The signature proves that a release's distributed source and attribution files match bytes approved by the holder of the publisher key. It detects accidental corruption and altered packages presented to an intact trusted verifier. A user with full control of the launcher, runtime, and filesystem can replace the public key or remove the checks. Editable JavaScript cannot make source unstealable or prevent its owner from modifying and redistributing it. Concurrent hostile filesystem changes also require operating-system controls beyond a startup check. Keep the original release archive or trusted archive checksum when checking a modified installation.

These checks do not change licensing rights. codexcli retains its MIT license; upstream Codex source and its Apache-2.0 license and notices remain included. Integrity verification makes no claim to restrict upstream modification or redistribution rights.

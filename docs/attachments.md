# Uploading files and folders as model context

`/upload` selects files or folders for the next model turn. The collector reads the selection locally and queues attributed text or supported images in memory. Collection itself performs no network request and creates no remote file upload. Sending the next turn sends the queued context to the selected AI endpoint, which may be a local server or a cloud provider.

Text is attached with its original path and an explicit untrusted-data label. Images are captured as data URIs, preserving the bounded bytes collected at queue time. Later edits to the original image do not replace the queued image. Folder contents are walked recursively in a stable order; repeated file selections are queued once.

Supported content is UTF-8 text without binary control bytes, and PNG, JPEG, GIF or WebP images with a matching recognized signature. PDFs, Office documents, archives, executables, audio and video are excluded with a reason; this version does not extract document text or transcribe media. Signature checks identify the image format but do not replace the selected provider's image decoder or capability checks.

Audio transcription is a separate explicit `/voice file PATH` command with a configured compatible service; it is not performed by `/upload`. See the [user guide](user-guide.md) and [service details](services.md).

Defaults are 100 files and 2 MiB of raw content per collection, with 512 KiB per text file and 2 MiB per image. The folder scan is bounded to 5,000 inspected entries and 20 levels. Files exceeding a limit are excluded entirely. Nothing is silently truncated. The result reports byte totals, image count and exclusions; text-token estimation is approximate, and image-token usage depends on the provider.

The collector excludes `.git`, `node_modules`, common credential directories, `.env` files including templates, private-key and credential filenames, symbolic links and paths through symbolic links. These rules also apply to explicit selections inside those directories. Common private-key blocks, provider token formats and literal credential assignments cause the entire text file to be excluded. This filter covers common cases; it cannot identify every sensitive value or read secrets visible in an image. Review the selected context and reported exclusions before sending.

Missing paths, unsupported formats, duplicate choices, unreadable content, changed files and size/depth/scan limits appear as warnings. A skipped directory warning describes its entire subtree. Absolute paths and paths containing spaces are supported. Paths outside the working directory can be selected explicitly; folder traversal does not follow symbolic links outside its selection.

## Module interface

```js
const result = await collectAttachments(paths, {
  cwd,
  maxFiles: 100,
  maxBytes: 2 * 1024 * 1024,
});
// result.inputItems: app-server input objects
// result.files: {path, kind: 'text'|'image', bytes, mime?} metadata
// result.warnings: {path, reason} exclusions
// result.summary: concise human-readable queue summary
// result.totalBytes, result.imageCount, result.estimatedTextTokens
```

Text items are `{type: 'text', text, text_elements: []}`. Images are `{type: 'image', url: 'data:image/...;base64,...'}` and include a preceding attributed text item. These can be handed directly to the engine's typed turn-input support. Collection accepts optional `maxFileBytes`, `maxImageBytes`, `maxEntries` and `maxDepth` limits; all limits must be positive safe integers. Tests use owned temporary files and contain no live model or cloud uploads.

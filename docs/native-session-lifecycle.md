# Closing a native AI session

Switching AIs or quitting closes the private native engine and its owned helpers, including plugin-catalog Git processes. Cleanup uses process ownership and birth identity. It does not select other programs by name. Plugins remain enabled.

If cleanup cannot be verified, the CLI shows an error, prevents a new AI connection in that session, and exits with a failure status. The error attention sound respects `/notify on|off` and audio availability. Remaining chat checkpoints and monitor cleanup still run.

A background task does not report successful completion when its native cleanup fails. An earlier task error is retained as the cause of the cleanup error. A cancelled task keeps its cancellation status when cleanup succeeds.

Windows checks the original live engine and captured descendants before terminating its tree. If the engine exits before ownership can be captured, cleanup is reported as unverified. Unix uses a private process group and recorded birth identities. An unobserved orphan or an ambiguous escaped process is also reported as unverified; it is not treated as a successful stop.

Windows metadata helpers restrict module discovery to the stock Windows PowerShell system module directory before loading Microsoft modules. They do not use inherited user module paths.

If an owned Windows process exits between the identity check and `taskkill`, the CLI checks its birth identity again before accepting the stop. Native error output does not bypass that check; a matching process that remains live still makes cleanup fail.

On macOS, a known helper in a separate process group may exit naturally during the existing 250 ms shutdown grace, such as when its input closes. The CLI does not send individual signals using macOS's second-precision birth metadata. A helper that remains live after that grace keeps cleanup unverified.

`/stop` interrupts the current turn and requests termination of its native background commands. It retains the AI connection for another turn. Closing the session performs the additional process cleanup described above.

The native runtime may refresh its public plugin catalog during startup. This is separate from an AI model request. Cleanup does not disable that catalog or change the selected permission scope.

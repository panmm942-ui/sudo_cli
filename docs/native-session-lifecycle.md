# Closing a native AI session

Switching AIs or quitting closes the private native engine and its owned helpers, including plugin-catalog Git processes. Cleanup uses process ownership and birth identity. It does not select other programs by name. Plugins remain enabled.

If cleanup cannot be verified, the CLI shows an error, prevents a new AI connection in that session, and exits with a failure status. The error attention sound respects `/notify on|off` and audio availability. Remaining chat checkpoints and monitor cleanup still run.

A background task does not report successful completion when its native cleanup fails. An earlier task error is retained as the cause of the cleanup error. A cancelled task keeps its cancellation status when cleanup succeeds.

Windows checks the original live engine and captured descendants before terminating its tree. If the engine exits before ownership can be captured, cleanup is reported as unverified. Unix uses a private process group and recorded birth identities. An unobserved orphan or an ambiguous escaped process is also reported as unverified; it is not treated as a successful stop.

`/stop` interrupts the current turn and requests termination of its native background commands. It retains the AI connection for another turn. Closing the session performs the additional process cleanup described above.

The native runtime may refresh its public plugin catalog during startup. This is separate from an AI model request. Cleanup does not disable that catalog or change the selected permission scope.

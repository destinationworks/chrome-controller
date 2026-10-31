# Version 1.3.2

Guarded secret transfers now verify that their target tab exists before reserving protection or capturing a value. Unsupported workers and inaccessible targets fail closed. Uncertain failures after admission retain the existing close-or-quarantine behavior. No extension permissions are added.

The native IPC client waits for the complete admission, operation and recovery budget (47 seconds), so it can receive the host's definitive response. Secret-transfer clients must support the same budget. The MCP advertised version, package version and popup badge are synchronized.

Seven production transitive dependency versions are refreshed within their existing compatible ranges. A targeted lock refresh avoids unrelated dependency drift and unnecessary overrides. Production dependency audit is clean; the development-only peer toolchain retains separate audit findings.

Install the new extension worker before using the new native host. For an unpacked installation, preserve its existing source directory and extension ID. Preserve every existing native-host allowed origin. Before any manual reload or host replacement, establish that all protected tabs and output guards have expired and that no sensitive operation is pending. Do not infer guard expiry from idle process health alone.

Normal automatic extension updates defer while the native connection keeps the worker active. Forced reload and loss of the connection are separate cases. Rollback follows the same guard-expiry check, reverting the host before the extension while retaining the longer secret-client response deadline.

Build, CI, local installation, runtime acceptance, Store upload, review and public availability are separate evidence states. A prepared package does not establish Store publication.

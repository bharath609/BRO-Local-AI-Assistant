# Security and privacy notes

BRO runs entirely on the local machine. Nothing is sent anywhere except the
model provider the user configures (Ollama locally, or an OpenAI-compatible
endpoint with the user's own key).

## Local HTTP API

- The backend listens on `127.0.0.1` only (`BRO_PORT`, default `4280`).
- Every request must use a loopback `Host` header and, if it sends an `Origin`,
  a loopback origin. This blocks DNS-rebinding and cross-site form posts.
- When Electron starts the backend it generates a random 256-bit token for that
  launch, passes it to the backend in the environment, and injects it into its
  own requests through `session.webRequest`. Requests to `/api/*` without the
  token get `401`. The token is never written to disk and is not exposed to the
  page's JavaScript.
- Plain `node server.js` (development) leaves the token unset, so the API is
  reachable from local tools on the same machine.
- The backend removes `BRO_API_TOKEN`, `BRO_SECRET_KEY`, and `BRO_AI_API_KEY`
  from its environment after startup, so processes it launches (PowerShell
  helpers, terminals, project commands) cannot read them.

## Credentials at rest

- In an installed build, Electron creates a random 32-byte master key and wraps
  it with Windows DPAPI through `safeStorage` (`%APPDATA%\BRO Assistant\secret.key`).
  The backend encrypts the provider key with AES-256-GCM.
- `settings.json` stores only `enc:v1:<base64>` for the key. A settings file
  copied to another Windows account cannot be decrypted.
- A plaintext key written by an older version is upgraded in place on first read.
- Development keeps the old plaintext format because a source checkout may
  outlive the Windows profile that holds the master key.

## Web content

- Pages are served with a strict Content-Security-Policy (`default-src 'self'`,
  no inline scripts, `frame-ancestors 'none'`), `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, and COOP `same-origin`.
- Electron windows run with `contextIsolation`, `sandbox`, no Node integration,
  and navigation/window-open handlers that only allow BRO's own origin or hand
  `http(s)` links to the system browser.
- Only microphone permission is granted, and only to BRO's own origin.

## Guardrails (current behavior)

Three modes exist (`strict`, `guarded`, `trusted`) and are stored in
`guardrails.json`, but **approval prompts are currently disabled**:
`guardrails.approvalNeeded()` always returns `false`. In practice every
registered action that is not an admin action runs immediately after the model
asks for it. This is deliberate for now so existing behavior is preserved
during packaging, and changing it is an explicit, separate decision.

- Unknown action types are classified as `destructive`, but because no approval
  is requested they are not blocked by the mode either; `executeAction()`
  rejects types it does not implement.
- The master lock (`locked: true`) blocks every non-admin action and returns a
  spoken explanation. Admin actions (`set_guardrails`, `lock_controls`,
  `unlock_controls`) still work.
- `run_project_command` additionally requires an explicit
  `requiresApproval: true` flag on the action.

Every executed, blocked, requested, approved, denied, or failed action is
appended to `%APPDATA%\BRO Assistant\audit.log` (JSON Lines, rotated at 1 MB).
The API exposes the last entries at `GET /api/audit`.

## Data and logs

| Path | Contents |
| --- | --- |
| `%APPDATA%\BRO Assistant\settings.json` | provider URL, model, encrypted key |
| `%APPDATA%\BRO Assistant\state.json` | registered projects |
| `%APPDATA%\BRO Assistant\guardrails.json` | mode and master lock |
| `%APPDATA%\BRO Assistant\audit.log` | action audit trail |
| `%APPDATA%\BRO Assistant\desktop.json` | auto-start and last launch |
| `%APPDATA%\BRO Assistant\logs\bro-*.log` | redacted application log |
| `%APPDATA%\BRO Assistant\secret.key` | DPAPI-wrapped master key |

Logs redact bearer tokens, API keys, long base64 blobs, and user-profile paths.
Uninstalling does not remove this folder.

## Known gaps

- Code signing is not configured; the installer is unsigned.
- There is no automatic update mechanism.
- Guardrail approval prompts are disabled (see above).
- `BRO_AUTO_MAXIMIZE_WINDOWS` starts a PowerShell helper that maximizes new
  windows; set it to `0` to disable.

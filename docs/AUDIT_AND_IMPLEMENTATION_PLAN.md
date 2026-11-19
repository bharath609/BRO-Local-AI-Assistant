# BRO Assistant — Audit Report & DevOps Implementation Plan

Status: **Phase 1 (Audit & Baseline) — complete, awaiting approval**
Date: 2026-11-19
Repository: https://github.com/bharath609/BRO-Local-AI-Assistant (public, no releases, no license)
Blueprint: `Bro_Assistant_DevOps_Blueprint.docx`

---

## 1. Scope and evidence

| Check | Result |
| --- | --- |
| Blueprint read in full (10 sections) | Done |
| Repository inspected (source, tests, assets, scripts, git history) | Done |
| Test suite executed | **107 / 107 pass** (`npm test`, ~20 s) |
| Backend smoke test (`node server.js` on a spare port, isolated `BRO_DATA_DIR`) | Passed: `/api/bootstrap` returned app name, provider state, 42 capabilities, voice available |
| Live desktop/voice test (microphone, hotkey, app launch) | **Not performed** — hardware/GUI verification is a manual step |
| Installer build | Does not exist yet |

Environment used: Windows, Node v24.21.0, npm 8.3.0, Electron 37 installed locally.

Working tree note: **14 modified/untracked entries** exist (7 source files, 5 test files, README, overlay/recorder). These are treated as the user's work in progress and were not touched.

---

## 2. Existing architecture report

### 2.1 Stack (actual, not the blueprint's Python assumption)

| Layer | Current implementation |
| --- | --- |
| Runtime | Node.js ≥ 22 (`package.json`), no build step |
| HTTP backend | Plain `node:http` server, `server.js` (587 lines), loopback only `127.0.0.1:4280` |
| UI | Vanilla HTML/CSS/JS in `public/` (no framework, no bundler) |
| Desktop shell | Electron 37, `desktop/main.js` (434 lines), frameless always-on-top popup |
| Voice | Bundled `whisper.cpp` binaries in `vendor/whisper` + two warm servers (base.en/tiny.en) |
| AI provider | OpenAI-compatible HTTP; native Ollama `/api/chat` path; auto protocol (`chat` / `responses`) |
| Persistence | JSON files in `data/` (`state.json`, `settings.json`, `guardrails.json`, `audit.log`) |
| Tests | `node --test`, 10 files, 107 tests, 1,488 lines |
| Dependencies | **Electron only** (devDependency). No runtime npm packages. |

Approximate size: 6,986 lines of application JS, 1,488 lines of tests, 319-line README.

### 2.2 Process and runtime flow

```
Start-BRO.vbs / start-bro-overlay.cmd / npm run desktop
        │
        ▼
Electron main (desktop/main.js)
  ├─ single-instance lock, global hotkey (Electron, PowerShell fallback)
  ├─ auto-launch at login (always enabled today)
  ├─ spawn("node", "server.js")  ◄── requires Node on PATH
  └─ BrowserWindow (320×158, transparent, always-on-top) → http://127.0.0.1:4280/overlay.html
                                                              │
                                                              ▼
                                                     Backend (server.js)
                                                       ├─ /api/chat, /api/action
                                                       ├─ voice.js → whisper-server (warm, ports 4791+)
                                                       ├─ assistant.js → provider.js / tools.js / skills
                                                       ├─ store.js → data/*.json
                                                       └─ guardrails.js → audit.log
```

The full chat UI (`public/index.html` + `app.js`) is **only reachable by opening a browser** at `http://127.0.0.1:4280`. The Electron app never creates a main window for it.

### 2.3 Module map

| File | Lines | Responsibility |
| --- | --- | --- |
| `server.js` | 587 | HTTP routing, action execution, static files, startup/shutdown |
| `src/assistant.js` | ~1,500 | Intent routing, command catalogue, chat orchestration |
| `src/tools.js` | ~2,700 | Windows app/file/window/input/system tools (PowerShell + Win32 via Add-Type) |
| `src/skills/application-control.js` | ~1,300 | App/page control grammar (Gmail, LinkedIn, Drive, Office, Explorer…) |
| `src/voice.js` | ~800 | Whisper warm servers, wake detection, transcription, WAV handling |
| `src/provider.js` | 260 | Ollama + OpenAI-compatible adapters, runtime warm-up |
| `src/guardrails.js` | ~330 | Risk tiers, approval store, audit log |
| `src/store.js` | 196 | JSON persistence, project registry, provider settings |
| `src/app-catalog.json` | — | Installed-app aliases/processes |
| `src/command-catalog.json` | — | Web resource aliases |
| `public/*` | ~1,500 | Chat UI, settings, guardrails panel, overlay, recorder, worklet |
| `desktop/main.js` | 434 | Electron shell, backend spawn, hotkey, overlay, maximizer |
| `desktop/preload.js` | 27 | Narrow IPC bridge (hotkey, hide/show/close, env flags) |
| `scripts/setup-voice.js` | 95 | One-time Whisper engine + model download |
| `scripts/maximize-new-windows.ps1` | — | Background window maximizer |

### 2.4 Feature inventory (verified from code + tests)

| Feature | Status | Notes |
| --- | --- | --- |
| Chat with local/remote OpenAI-compatible provider | Working | Ollama native path, Responses/Chat auto-detection, timeouts |
| Voice capture and local transcription | Working (code + tests) | Own mic pipeline, mono 16 kHz WAV, VAD, pre-roll |
| Wake word ("BRO"), sleep phrases, follow-up window | Working (tests) | tiny.en wake check + base.en command decode |
| Global hotkey Ctrl+Alt+B | Working (code) | Electron primary, PowerShell RegisterHotKey fallback |
| Open apps/sites/files/folders by voice | Working (tests) | Start Menu/MSIX/desktop shortcuts, allowlisted |
| Window control (focus/min/max/restore/close), scrolling, media keys | Working (tests) | Windows-only, PowerShell/Win32 |
| App control grammar (browser tabs, Gmail, Office, Explorer) | Working (tests) | Large rule set in `application-control.js` |
| Project registry + named commands with approval flag | Working | `/api/projects/*` |
| Guardrail modes strict/guarded/trusted | **Present but effectively disabled** | `approvalNeeded()` and `blockedByLock()` always return false except `admin` |
| Audit log | Working | JSONL in `data/audit.log`, no rotation |
| Settings UI for provider | Working | API key accepted, stored **plaintext** |
| Chat history persistence | Working | Browser `localStorage`, last 80 messages |
| Electron desktop app | Partial | Voice popup only; no main window, tray, or Settings entry point |
| Installer / releases / CI / license / docs package | Missing | — |

### 2.5 Verified defects and mismatches

1. **README vs code:** README promises spoken/clicked approval for risky actions; `src/guardrails.js` returns `false` from `approvalNeeded()` for every risk tier except none, and `blockedByLock()` only blocks `admin`. Default mode is `trusted`.
2. **Backend depends on a system `node`:** `desktop/main.js:115` spawns `'node'`, which will not exist in a packaged app.
3. **Data written next to code:** `src/store.js:61` defaults to `<repo>/data`; installed under `Program Files` this is not user-writable. Voice clips (`server.js:439`) also use `<repo>/data`.
4. **Auto-start always on:** `configureAutoLaunch()` forces login auto-start on first run.
5. **No main window:** users must know to open a browser to reach chat/settings.
6. **API key plaintext:** `data/settings.json`, mode 0600 but unencrypted.
7. **No auth on the local API:** any local process — and, via a simple `text/plain` POST, a web page in the user's browser — can call `/api/action` and control the PC (`readBody` parses JSON regardless of Content-Type; no Origin/Host check).
8. **No CSP on the main UI** (`public/index.html`); the overlay has one.
9. **`activate_bro` path breaks when packaged:** `src/tools.js:855` looks for `node_modules/electron/dist/electron.exe`.
10. **Startup failure is console-only:** if the backend fails, the popup stays empty with no user-facing error.
11. **Voice engine requires a manual 160 MB setup step** that a non-technical installer user cannot run.
12. **Port 4280 is fixed;** an unrelated process on that port makes the app attach to the wrong backend (`backendReady()` only checks any 2xx/3xx/4xx).

---

## 3. Missing functionality vs blueprint

| Blueprint requirement | Status | Gap |
| --- | --- | --- |
| Public repo with downloadable Windows installer | Missing | No packaging, no releases, no artifacts |
| Install without Python/Git/Node | Missing | Electron bundles Node, but installer/runtime wiring absent |
| Configure AI provider on first run | Partial | Settings page exists in browser UI; no first-run flow in the desktop app |
| Bundle required dependencies | Missing | Whisper binaries/models are dev-only; `vendor/` gitignored |
| OS credential storage for keys | Missing | Plaintext JSON |
| Confirmation for sensitive actions | Missing | Guardrails disabled |
| Structured logs with redaction | Missing | Console only; audit log separate |
| Unit + integration tests in CI | Partial | 107 local tests; no workflow, no packaging/desktop tests |
| Release automation + SHA-256 | Missing | No `.github/` at all |
| LICENSE / CONTRIBUTING / CHANGELOG / SECURITY | Missing | None present (repo is not legally open source yet) |
| README install/provider/troubleshooting for end users | Partial | Excellent developer README; no installer/user guide/screenshots |
| SQLite persistence | Not needed now | JSON is adequate; do not add complexity |
| Provider adapters | Adequate | Existing OpenAI-compatible + Ollama covers hosted/local |

---

## 4. Proposed final architecture

Keep the stack. Add only the pieces required to ship a desktop app.

```
BRO Assistant installer (NSIS, per-user)
├─ Electron 45 (upgraded, bundled Node)
│  ├─ Main process
│  │  ├─ app lifecycle, single instance, tray, main window + voice overlay
│  │  ├─ global hotkey, opt-in auto-start
│  │  ├─ safeStorage (DPAPI) for the provider API key
│  │  └─ utilityProcess.fork(server.js)   ← bundled Node, no external node
│  ├─ Preload (contextIsolation, sandbox)
│  └─ Renderer: existing public/ UI, loaded from the local HTTP origin
├─ resources/
│  ├─ whisper/ (trimmed whisper-server, whisper-cli, required DLLs)
│  ├─ models/  (ggml-base.en.bin, ggml-tiny.en.bin)  ← or first-run download
│  └─ scripts/maximize-new-windows.ps1 (asarUnpack)
└─ userData: %APPDATA%\BRO Assistant
   ├─ settings.json (key encrypted)
   ├─ state.json, guardrails.json, audit.log, logs/
   └─ migrated legacy data (copy, never delete)
```

Key decisions and rationale:

1. **Do not port to Python.** The blueprint is Python-oriented ("if the current project is Python-based"). This project is JavaScript, Electron and Windows-native. PySide6/PyInstaller/Pytest would be a full rewrite and would break whisper/Electron behavior.
2. **Electron stays; upgrade 37 → 45.4.1.** Electron supports the latest three majors; 37 is out of support in Nov 2026 (security risk). Upgrade in an isolated phase with the existing 107 tests as the regression gate.
3. **Backend runs in an Electron `utilityProcess`, not `node`.** Keeps the current process isolation (PowerShell `spawnSync` cannot freeze the UI), removes the Node requirement, and adds a private message channel for secret handling.
4. **Packaging: electron-builder + NSIS.** One tool covers app packaging, asar, resources, installer, uninstaller and CI. Inno Setup would add a second toolchain for the same output.
5. **Data moves to `app.getPath('userData')`** via `BRO_DATA_DIR`; packaged resources resolve from `process.resourcesPath`; a one-time migration copies existing `data/`.
6. **Secrets: Electron `safeStorage`** (DPAPI on Windows). No `keytar`, no native addon, no new runtime technology.
7. **Model distribution:** bundle models in `resources/` (installer ~200–280 MB) for true offline-first install, and keep an optional "download later" path for a smaller installer. This is the main size trade-off.
8. **Local API hardening:** random per-launch token required by all `/api/*` calls, strict `Host`/`Origin` allowlist, CSP, and loopback-only binding.
9. **No Docker, Kubernetes, Terraform, SQLite, React, TypeScript, or auto-updater in v1.** None solves a current problem.

## 5. Technology decisions

| Need | Choice | Reason |
| --- | --- | --- |
| Language/runtime | Node.js ≥ 22 (existing) | Already the codebase |
| Desktop shell | Electron 45 | Existing shell, security support |
| Packaging/installer | electron-builder 26 + NSIS | Single tool, per-user install, CI-friendly |
| Voice | whisper.cpp (existing) + bundled models | Already implemented and tested |
| Provider | Existing OpenAI-compatible + Ollama | Blueprint's "provider adapters" already satisfied |
| Tests | `node --test` (existing) | No new framework |
| Lint | ESLint flat config (optional, dev-only) | Blueprint asks for lint gate |
| CI/CD | GitHub Actions, `windows-latest` | Blueprint requirement |
| Distribution | GitHub Releases + SHA-256 | Blueprint requirement |
| Signing | Optional later (SmartScreen warning until then) | Cost/trade-off, needs user decision |

Explicitly **not** adopting: Python, PySide6, PyInstaller, Pytest, Inno Setup, Docker, Kubernetes, Terraform, SQLite, a frontend framework, a bundler, `keytar`, auto-updater.

---

## 6. Phased implementation plan

Estimates assume part-time work and include verification.

### Phase 0 — Safe starting point (0.5 day, Low)

- Commit or stash the 14 pending changes; tag/back up the current known-good state.
- Choose and add `LICENSE`; add repo description/topics; protect `main`.
- Create `docs/`, `.github/` scaffolding.

**Exit:** clean tree, baseline commit, license present.

### Phase 1 — Audit and baseline (done)

**Exit:** this report, 107/107 tests, backend smoke test.

### Phase 2 — Packaging-compatible architecture (3–5 days, Medium-High)

- Upgrade Electron 37 → 45; fix API deltas; re-run all tests.
- Add `src/paths.js`: data dir, resources dir, logs dir, dev vs packaged detection.
- `BRO_DATA_DIR` default → `app.getPath('userData')`; migrate legacy `data/` (copy only).
- Replace `spawn('node', …)` with `utilityProcess.fork`; health check with app instance token.
- Add main application window (existing `index.html`) + tray menu (Open, Settings, Quit).
- Keep the overlay window, hotkey and wake behavior untouched.
- Resolve whisper/scripts paths from `process.resourcesPath`; replace `activate_bro` electron path with an app-level relaunch/IPC.
- Make auto-start opt-in; add first-run greeting/name instead of hardcoded "Bharath".
- User-facing error state when the backend or voice engine is unavailable.

**Exit:** `npm run desktop` runs entirely from Electron; all 107 tests pass; chat + settings reachable from the desktop app; overlay still works.

### Phase 3 — Security and reliability (2–3 days, Medium)

- API token + `Host`/`Origin` validation on every route; reject non-loopback.
- `safeStorage` encryption for the API key; migration of existing plaintext key; never return it.
- Decide guardrail behavior: restore documented confirmations for `file`/`destructive` (recommended) or rewrite docs to match "trusted" default. Requires user decision.
- CSP + security headers for the main UI; tighten media permission to the app origin.
- File logs in `userData/logs` with secret redaction, rotation, and an "Export diagnostics" action.
- Validate `openExternal` targets; cap audit log; fix `data` paths for clips.

**Exit:** token required (401 without), no plaintext secrets on disk, logs redacted, documented behavior matches code.

### Phase 4 — Testing (2–3 days, Medium)

- Tests for paths/migration, settings encryption adapter, API auth/Host checks, guardrail policy, static file safety.
- Desktop startup smoke test (`--smoke-test` starts backend, hits `/api/bootstrap`, exits 0).
- Keep all existing tests green; `npm run test:ci`; optional ESLint gate.

**Exit:** test count grows, CI command runs locally on Windows, no flaky hardware dependency.

### Phase 5 — Windows packaging (3–5 days, High)

- electron-builder config, app id, icons, `asarUnpack` for whisper/scripts, NSIS per-user installer.
- Bundle trimmed whisper binaries + models; add third-party notices (whisper.cpp, models, Electron).
- First-run provider screen (reuse settings UI) and microphone/network disclosure.
- Test on a **clean Windows VM**: install, first launch, provider setup, voice, upgrade, uninstall, reinstall, user-data preservation.

**Exit:** `BRO-Assistant-Setup-x.y.z.exe` installs and runs with no Node/Python/Git present.

### Phase 6 — CI/CD (1–2 days, Medium)

- `ci.yml`: push/PR → Node 22/24 → `npm ci` → tests → optional lint.
- `release.yml`: tag `v*` → Windows runner → tests → build → artifact validation + smoke test → SHA-256 → GitHub Release.
- Least-privilege permissions, protected release environment, no release on failed verification.

**Exit:** a tag produces a verified installer + checksum on Releases.

### Phase 7 — Documentation and launch (2–3 days, Low-Medium)

- README restructure for users first (download, install, configure, voice, troubleshooting), developer section second, screenshots/GIF.
- `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `PRIVACY.md`, `docs/USER_GUIDE.md`, `docs/TROUBLESHOOTING.md`.
- Release notes template, known limitations, support channel, repo description/topics.

**Exit:** a new user can go from repo → installer → working assistant without reading source or using a terminal.

Total: roughly **2–3 weeks part-time**; critical path is Phase 2 → 5 → clean-VM validation.

---

## 7. Risks and blockers

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| 1 | Installer size (~200–280 MB with models) | Medium | Trim unused whisper binaries; offer model-download variant |
| 2 | Unsigned installer triggers SmartScreen/AV | High | Document; plan code signing; avoid encoded PowerShell where possible |
| 3 | PowerShell/Win32 automation and simulated input can be flagged by AV | High | Keep actions allowlisted; sign binaries; publish hashes; test on clean Defender VM |
| 4 | Electron 37 is EOL | High | Upgrade to 45 with tests as gate |
| 5 | API key currently plaintext | High | safeStorage + migration |
| 6 | Unauthenticated local API (CSRF/DNS rebinding) | Critical | Per-launch token, Host/Origin checks, CSP |
| 7 | Guardrails advertised but disabled | High | Decide behavior; align docs and code |
| 8 | Writing data inside the install directory | High | `userData` + migration |
| 9 | Existing `data/` (167 MB, 1,634 files) and WIP edits could be lost | High | Commit first; copy-only migration |
| 10 | Backend spawn requires system Node | Blocking | utilityProcess |
| 11 | Windows x64 only; whisper build is x64 | Medium | State requirement; no ARM64 claim |
| 12 | Voice hardware/mic permission cannot be CI-tested | Medium | Manual checklist + text fallback |
| 13 | Fixed port 4280 conflicts | Medium | Ephemeral/fallback port + instance token |
| 14 | No license = not open source | Blocking (legal) | Add license before publishing |
| 15 | `BRO_USER_NAME` personalized default | Low | First-run profile |
| 16 | Forced auto-start at login | Medium | Opt-in setting |
| 17 | No crash diagnostics | Medium | File logs + export diagnostics |
| 18 | Third-party license notices missing | Medium | THIRD_PARTY_NOTICES |

---

## 8. Phase checklist

### Phase 0
- [ ] Commit/stash existing 14 changes
- [ ] Back up `data/` (settings, state, guardrails)
- [ ] Add LICENSE (MIT or Apache-2.0 — user choice)
- [ ] Add `.github/` skeleton and `docs/`
- [ ] Repo description/topics; protect `main`

### Phase 1
- [x] Read blueprint
- [x] Inspect repository and map architecture
- [x] Run tests (107/107)
- [x] Backend smoke test
- [x] Produce this report

### Phase 2
- [ ] Upgrade Electron to 45, tests green
- [ ] Add `src/paths.js`; resolve data/resources/logs
- [ ] Move data to `userData` + copy-only migration
- [ ] utilityProcess backend + health/instance token
- [ ] Main chat window + tray
- [ ] Keep overlay/hotkey/wake intact
- [ ] Fix whisper/scripts/`activate_bro` packaged paths
- [ ] Opt-in auto-start; first-run name
- [ ] User-visible backend/voice error states

### Phase 3
- [ ] API token + Host/Origin validation
- [ ] safeStorage key encryption + migration
- [ ] Guardrail decision implemented and documented
- [ ] CSP + security headers
- [ ] File logs with redaction + diagnostics export
- [ ] Audit log rotation; clip path fix

### Phase 4
- [ ] New unit tests (paths, migration, auth, secrets, guardrails)
- [ ] Desktop `--smoke-test`
- [ ] `npm run test:ci` on Windows
- [ ] Optional ESLint gate

### Phase 5
- [ ] electron-builder + NSIS config
- [ ] Icons, app id, resources, asarUnpack
- [ ] Trim + bundle whisper + models + notices
- [ ] First-run provider flow
- [ ] Clean-VM install/first-run/upgrade/uninstall/reinstall tests

### Phase 6
- [ ] `ci.yml` on PR/push
- [ ] `release.yml` on `v*`
- [ ] Artifact validation + smoke test
- [ ] SHA-256 checksums
- [ ] Least-privilege GitHub Release

### Phase 7
- [ ] README user-first rewrite + screenshots
- [ ] CONTRIBUTING / CHANGELOG / SECURITY / PRIVACY
- [ ] User guide + troubleshooting
- [ ] Release notes + known limitations
- [ ] Publish v1.0.0

---

## 9. Decisions required before implementation

1. **License:** MIT (simplest, common for tools) or Apache-2.0 (patent grant)?
2. **Electron upgrade:** approve 37 → 45.4.1 in Phase 2 (recommended), or stay on 37?
3. **Model distribution:** bundle all models (larger installer, offline) or download on first run (smaller installer, needs internet once)?
4. **Guardrails:** restore real approvals for file/destructive actions (matches README and blueprint), or keep trusted auto-run and change the documentation?
5. **Signing:** ship unsigned v1.0.0 with a documented SmartScreen warning, or budget a code-signing certificate?

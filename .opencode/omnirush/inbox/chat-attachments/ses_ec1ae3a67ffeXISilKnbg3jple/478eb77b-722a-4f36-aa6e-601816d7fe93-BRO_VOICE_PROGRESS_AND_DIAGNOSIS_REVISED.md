# BRO Local AI Assistant — Voice Progress and Diagnosis

**Date:** October 22, 2026  
**Project:** BRO Local AI Assistant  
**Status:** Confirmed prefilter defect documented; Windows live verification pending

## 1. Executive Summary

BRO is a local Electron-based voice assistant with a loopback Node backend, a floating always-on-top overlay, a global `Ctrl + Alt + B` activation shortcut, and deterministic command handling.

The project report identifies one **confirmed software defect**: Wispr Flow text could be rejected by BRO before it reached the command parser when it began with parser-supported prefixes such as `check` or `google`. For example, the parser supports `Check my Gmail`, while the reported Wispr prefilters did not accept that prefix.

The reported narrow fix is to align the Wispr prefilters with the parser by accepting `check` and `google` in both the main-process and overlay filtering paths. This document does **not** assert that any code change, test run, or live microphone test was performed during this revision.

Wispr startup timing and the clipboard/hidden-textarea transcript handoff remain **hypotheses to verify on Windows**, with a practical evidence-collection plan in Section 13.

## 2. User Requirements and Preferences

The implementation is intended to preserve these requirements:

- Keep the OmniRush integration and the default `omnirush/gpt-6-astra` model.
- Keep BRO active in the backend/background.
- Keep the floating BRO popup always on top so the user does not need to return to the main website for every command.
- Keep a global command to activate BRO.
- Use `Ctrl + Alt + B` as the explicit wake shortcut.
- Press `Ctrl + Alt + B` once, speak one command, and have BRO stop after that command.
- Prefer Wispr Flow when it is available.
- Retain Windows native speech as a fallback.
- Preserve typed commands and unrelated application functionality.
- Do not replace the voice system without evidence.
- Do not claim an unconfirmed root cause.
- Do not expose API keys, passwords, tokens, or other secrets.
- Do not execute arbitrary clipboard text, dictated shell commands, destructive operations, or sensitive communication without appropriate validation or confirmation.

## 3. Current Technology Inventory

### Runtime

- Node.js backend using the built-in `node:http` server.
- Electron desktop shell, reported as Electron `37.10.3`.
- Browser UI served from the local backend.
- No Whisper package or direct audio-transcription dependency was identified in the report.

### Backend

- Host: `127.0.0.1`
- Default port: `4280`
- Main endpoint: `POST /api/chat`
- Action endpoint: `POST /api/action`
- Health/bootstrap endpoint: `GET /api/bootstrap`

### AI provider

- Default model: `omnirush/gpt-6-astra`
- Provider configuration remains local and optional.
- The provider is not required for deterministic local commands such as opening an allowlisted site or activating BRO.
- No API key should be added to the repository or documentation.

### Voice engines

1. **Wispr Flow — primary external voice engine**
   - Detected when the Wispr configuration exists and the Wispr process is running.
   - Activated through Wispr Flow's Windows hands-free shortcut: `Ctrl + Windows + Space`.
   - BRO controls this through a persistent PowerShell keyboard bridge.
   - Transcript delivery is reported to depend on focused text input and clipboard polling because no direct Wispr transcript API was identified in the project.

2. **Windows System.Speech — native fallback**
   - Implemented through a PowerShell child process.
   - Uses `System.Speech.Recognition.SpeechRecognitionEngine`.
   - Uses a restricted `BRO_COMMANDS` grammar.
   - Rejects low-confidence or out-of-vocabulary results.
   - Default confidence floor is reported as `0.70`, configurable through `BRO_SPEECH_MIN_CONFIDENCE`.

3. **Browser SpeechRecognition — fallback paths**
   - The main page microphone in `public/app.js` uses browser `SpeechRecognition` or `webkitSpeechRecognition` when available.
   - The Electron overlay only reaches browser recognition if Wispr and native Windows speech are unavailable.
   - This is not the intended primary overlay path on Windows when Wispr is detected.

## 4. Complete Voice Pipeline

1. The user taps `Ctrl + Alt + B` once.
2. The native Windows helper receives the shortcut through `RegisterHotKey`.
3. If registration is unavailable, the helper falls back to `GetAsyncKeyState` polling.
4. Electron receives `BRO_NATIVE_HOTKEY_TRIGGERED`.
5. `activateOverlay()` shows, focuses, and brings the floating overlay to the front.
6. Electron sends the `bro-hotkey` IPC event through `desktop/preload.js`.
7. `public/overlay.js` starts one-shot listening.
8. The overlay focuses the hidden `#wispr-capture` textarea when Wispr is active.
9. The main process starts the Wispr bridge or the native Windows speech process.
10. Wispr text may arrive through the focused textarea, clipboard polling in `desktop/main.js`, or the `bro-wispr-transcript` IPC event.
11. Native speech text arrives through `bro-native-transcript`.
12. The overlay normalizes and validates the command text.
13. The overlay submits `POST /api/chat`.
14. `src/assistant.js` parses deterministic commands and creates safe actions.
15. `server.js` executes safe immediate actions or returns approval-required actions.
16. BRO stops the voice bridge after one command.
17. The overlay displays the result and returns to the ready state.

## 5. Relevant Source Files

### Desktop and voice bridge

- `desktop/main.js` — Electron entry point; Windows hotkey helper; native speech PowerShell script; Wispr keyboard bridge; clipboard polling; auto-start/background mode; overlay creation and IPC routing.
- `desktop/preload.js` — exposes safe renderer APIs for hotkey events, voice start/stop, transcript events, state events, and errors.

### Overlay and main UI

- `public/overlay.html` — floating popup markup and hidden Wispr capture textarea.
- `public/overlay.css` — always-on-top popup styling.
- `public/overlay.js` — one-shot state machine, Wispr/native transcript handling, command validation, and hotkey registration in the renderer.
- `public/app.js` — main chat UI, browser microphone fallback, typed command submission, provider settings, and project UI.

### Backend and command handling

- `server.js` — loopback HTTP server, chat routing, action execution, and project endpoints.
- `src/assistant.js` — deterministic command parser, catalog site aliases, search commands, `activate BRO`, and context replay such as `open that`.
- `src/tools.js` — URL validation, fixed Windows target allowlist, and safe terminal, folder, application, and project actions.
- `src/command-catalog.json` — safe catalog-derived resource and application commands.

## 6. Previously Reported BRO Functionality

The following capabilities were described in the source report. They are retained here as **reported project state**, not as new verification by this revision.

### Floating overlay and background behavior

- The overlay is reported as frameless, transparent, always on top, and skipped from the taskbar.
- BRO can run with `--background`.
- The Electron process reportedly uses a single-instance lock.
- Closing the window reportedly does not quit the background process when launched in background mode.
- Windows login auto-start is reported to use Electron's `setLoginItemSettings()`.

### Global activation

- Default shortcut: `Ctrl + Alt + B`.
- Native Windows `RegisterHotKey` is preferred; a key-state polling fallback is retained.
- The source report states that a prior PowerShell/C# hotkey helper syntax error was fixed.

### One-shot listening

- One hotkey tap is intended to start one command capture.
- Repeated hotkey events are intended to be ignored while BRO is listening, busy, or finalizing a command.
- After a command is accepted, the voice bridge is intended to stop.
- The UI instructs the user to press `Ctrl + Alt + B` once for the next command.

### Wispr Flow bridge

- A persistent PowerShell helper is intended to avoid startup cost for every command.
- Reported bridge state markers: `BRO_WISPR_READY`, `BRO_WISPR_STARTED`, and `BRO_WISPR_STOPPED`.
- BRO reportedly uses a request ID to avoid stale asynchronous Wispr starts.
- Clipboard polling is intended to be bounded to the active capture window.

### Native Windows speech

- Uses the named `BRO_COMMANDS` grammar.
- Is designed to reject results outside the expected grammar or below the configured confidence threshold.
- Is designed to emit explicit rejection and error events to the overlay.

### Catalog commands

The report states that the attached command catalog was copied into `src/command-catalog.json`. Reported safe catalog-driven examples include YouTube, LinkedIn, Google, Gmail, ChatGPT, GitHub, Google Drive, Google Calendar, Google Maps, Stack Overflow, Wikipedia, Reddit, Netflix, Spotify, X/Twitter, WhatsApp Web, Amazon, Word, Excel, PowerPoint, Notepad, Calculator, File Explorer, Settings, Downloads, Documents, Desktop, Pictures, Google searches, and YouTube searches.

Destructive or sensitive catalog entries should remain restricted until dedicated confirmation handlers exist.

## 7. Phase 1–3 Diagnosis

### Phase 1 — Technology and architecture

The project report indicates that BRO does not use Whisper. The intended primary overlay path is Wispr Flow controlled through a Windows keyboard bridge; native Windows speech is the fallback, and the main page has an independent browser speech path.

The backend and deterministic parser are separate from transcription. A failure can therefore occur at hotkey activation, Wispr/native startup, transcript handoff, overlay filtering, backend request, command parsing, or action execution.

### Phase 2 — Pipeline trace

The source report traced the hotkey-to-command path through the IPC and function flow in Section 4. This separation is important during manual verification: record the last reached pipeline stage before treating a later stage as the cause.

### Phase 3 — Confirmed findings

#### Confirmed defect: prefilter drift

The reported parser supports both of the following forms:

- `Check my Gmail`
- `google local AI assistants`

The reported Wispr prefilters accepted a narrower set of prefixes. Consequently, text beginning with `check` or `google` could be discarded **before** `src/assistant.js` received it. This is a deterministic prefilter/parser mismatch, not evidence of microphone-quality failure, Wispr recognition failure, or backend failure.

#### Confirmed fix design: align the prefilters with parser-supported input

The documented fix is intentionally narrow:

- In `desktop/main.js`, `looksLikeWisprCommand()` should accept commands beginning with `check` and `google` before forwarding clipboard text to the overlay.
- In `public/overlay.js`, `isLikelyWisprCommand()` and `isCompleteWisprCommand()` should accept the same prefixes so the renderer does not reject a command a second time.
- A regression test should keep the Wispr filters aligned with parser-supported catalog and search commands.

This is the correct scope because it repairs the confirmed gate without changing Wispr activation, focus, clipboard behavior, native grammar, or safety controls. Whether the repository already contains this change must be determined by the project owner from the actual working tree; this revision makes no new change or test claim.

### Phase 3 — Hypotheses requiring live evidence

#### Hypothesis 1: Wispr startup timing

The command window may begin before the asynchronous `BRO_WISPR_STARTED` event. A user speaking immediately after the shortcut could race bridge startup, Wispr activation, or focus synchronization. This is plausible, but not confirmed without timestamped Windows traces.

#### Hypothesis 2: Transcript handoff

The integration reportedly relies on a nearly invisible 4×4 textarea and clipboard polling, with no confirmed direct Wispr transcript API. A transcript could be recognized by Wispr yet fail to reach the textarea, clipboard poller, IPC event, or overlay validation. This is a handoff hypothesis, not a proven root cause.

#### Hypothesis 3: Native grammar strictness

Native speech intentionally accepts only known command phrases. Natural-language variations outside its vocabulary are rejected by design; that is distinct from a Wispr handoff failure.

#### Hypothesis 4: Physical microphone and Wispr configuration

This report cannot validate the selected microphone, Wispr language, audio device, permissions, or actual speech timing. These are environment-specific factors to check during the Windows run.

### Not identified as the current blocker

The source report recorded these as prior evidence, not evidence generated by this revision:

- A local backend response with HTTP `200`.
- Parser handling for relevant catalog commands.
- Default model `omnirush/gpt-6-astra`.
- Optional provider use for deterministic local actions.
- A prior hotkey helper syntax issue described as fixed.

## 8. Targeted Fix

The confirmed defect has a narrow, explainable fix: make the Wispr prefilters recognize `check` and `google` wherever they make an early accept/reject decision. The parser already recognizes those forms; the prefilters must not be stricter than the parser.

### `desktop/main.js`

`looksLikeWisprCommand()` should treat commands beginning with `check` and `google` as eligible to forward from the clipboard path to the overlay.

### `public/overlay.js`

`isLikelyWisprCommand()` and `isCompleteWisprCommand()` should accept those same prefixes, preventing a second rejection after renderer delivery.

### Regression protection

A future regression test should compare the accepted Wispr-prefix set with parser-supported catalog/search inputs. It should include at least `Check my Gmail` and `google local AI assistants`.

No code was modified and no test was run as part of preparing this revised document.

## 9. Verification Results

### Evidence status

No new automated tests, syntax checks, backend smoke checks, parser smoke checks, hotkey tests, microphone captures, or Wispr live traces were performed for this revision.

The source report previously recorded `npm test` as 28 passing tests, no failed tests; syntax checks for `desktop/main.js`, `public/overlay.js`, and `tests/native-speech.test.js`; a `GET /api/bootstrap` response with HTTP `200`; and parser smoke checks for the two affected phrases. Treat those entries as historical claims until independently reproduced in the current project state.

### What a successful targeted verification must prove

For each affected phrase, establish all of the following with current evidence:

1. The transcript reaches BRO.
2. The prefilter accepts it.
3. The overlay captures it once.
4. `POST /api/chat` is issued.
5. The parser returns the expected safe action or reply.

For `Check my Gmail`, the expected deterministic result is an `open_url` action for `https://mail.google.com/`. For `google local AI assistants`, it is a Google-search action targeting `local AI assistants`.

## 10. Backup and Repository State

The source report described a pre-edit backup at:

```text
C:\Users\ybhar\AppData\Local\Temp\agent-tmp\bro-voice-checkpoint-20261022.zip
```

It also described a repository-root limitation: the detected repository root was `C:\Users\ybhar`, the branch had no commits, and the working tree included unrelated user-directory files. These are historical report statements. Before any project change, create or verify a current, recoverable backup and inspect the actual repository state without overwriting unrelated files.

## 11. Commands for Manual Verification

Use only within the BRO project directory, and do not paste private transcript content into logs or issue trackers.

```text
npm.cmd test
npm.cmd start
npm.cmd run desktop
npm.cmd run desktop -- --background
node server.js
node --check desktop/main.js
node --check desktop/preload.js
node --check public/overlay.js
node --check public/app.js
node --check src/assistant.js
node --check src/tools.js
node --check server.js
```

These commands are listed for the Windows verification owner; they were not executed for this document revision.

## 12. Remaining Limitations

- A live microphone phrase has not been captured as part of this revision.
- Actual Wispr transcript delivery during a real user utterance has not been observed as part of this revision.
- Wispr startup timing and focus behavior remain hypotheses, pending timestamped evidence.
- The native grammar is intentionally limited to supported command phrases.
- Browser playback control and sending messages through WhatsApp remain unsupported until a connected and approved browser-control session exists.
- Destructive operations remain unimplemented or confirmation-gated.

## 13. Recommended Next Step — Windows Manual Verification and Debugging Plan

Run this plan on the user's Windows machine with Wispr Flow available. The purpose is to locate the last successful pipeline stage, not to collect private dictated text.

### A. Prepare a safe, repeatable session

1. Close duplicate BRO instances and start a single BRO instance in background mode.
2. Confirm the intended microphone is selected in Windows and Wispr Flow, and that Wispr Flow is running before each trial.
3. Open the BRO overlay/log view and, if available, Electron/PowerShell logs. Record timestamps, event names, request IDs, text lengths, and outcome codes only. Redact transcript content; use the two fixed non-sensitive phrases below.
4. Use a stopwatch or timestamp logger. For every trial, record the time of hotkey press, `BRO_WISPR_STARTED` (if emitted), transcript arrival, command capture, request dispatch, response, and stop event.

### B. Establish the prefilter path with controlled phrases

Perform at least five trials each, waiting for the overlay to be visibly ready before speaking:

1. Press `Ctrl + Alt + B`, wait until Wispr/listening is visibly active, then say `Check my Gmail`.
2. Repeat with `google local AI assistants`.
3. For each trial, verify this ordered chain: `BRO_NATIVE_HOTKEY_TRIGGERED` → overlay shown/focused → Wispr start requested → `BRO_WISPR_STARTED` (when available) → transcript received → prefilter accepted → command captured → `POST /api/chat` → backend reply/action → `BRO_WISPR_STOPPED`.
4. If a transcript arrives but is rejected, capture its normalized length and the rejection reason. Do not capture unrelated clipboard contents.

**Interpretation:** failure immediately after transcript arrival points to filtering/normalization; failure after command capture points downstream to the request, parser, or action path.

### C. Test the startup-timing hypothesis

For each controlled phrase, run two groups of five trials:

- **Ready group:** speak only after the UI/listening indicator and `BRO_WISPR_STARTED` marker, if present.
- **Immediate group:** speak naturally immediately after pressing `Ctrl + Alt + B`.

Compare the hotkey-to-started interval and the success rate. If ready-group trials succeed reliably while immediate-group trials fail before a transcript event, that supports—but does not alone prove—the startup-timing hypothesis. If both groups show a transcript event but the overlay does not capture it, shift focus to handoff/filtering instead.

### D. Isolate the transcript handoff route

For a failed and a successful trial, determine which route delivered text:

- hidden `#wispr-capture` textarea input/change;
- clipboard polling in `desktop/main.js`; or
- `bro-wispr-transcript` IPC event.

Add or enable temporary diagnostic output only if the project owner approves it. Diagnostics should report route name, request ID, elapsed milliseconds, text length, and a short fixed-value status—not full transcript text and never arbitrary clipboard contents. Confirm that the request ID matches the active capture window; a mismatch suggests a stale asynchronous event rather than recognition failure.

### E. Rule out focus and clipboard interference

1. Observe whether the overlay remains frontmost and whether `#wispr-capture` receives focus before Wispr becomes active.
2. During the test, do not copy unrelated text or use clipboard managers. Run one comparison trial with such tools paused if permitted.
3. If Wispr visibly transcribes but BRO receives no textarea event, no IPC event, and no eligible clipboard update inside the capture window, the evidence supports a handoff integration problem.
4. If clipboard data arrives after `BRO_WISPR_STOPPED` or with a prior request ID, classify it as stale and do not execute it.

### F. Check the native fallback separately

Temporarily make Wispr unavailable only in a controlled test, then use a phrase known to be inside `BRO_COMMANDS`. Record confidence, grammar acceptance/rejection, and the same downstream events. This distinguishes native grammar limits from Wispr startup or handoff behavior.

### G. Decision guide

- **No hotkey event:** investigate Windows shortcut registration, helper process, and `RegisterHotKey`/polling fallback.
- **Hotkey occurs; no Wispr started marker:** investigate bridge launch, Wispr availability, and overlay focus.
- **Started marker occurs; no transcript on immediate-only trials:** prioritize startup timing/focus synchronization.
- **Wispr transcribes; BRO receives no route event:** prioritize textarea/clipboard/IPC handoff.
- **Transcript route event occurs; prefilter rejects `check` or `google`:** inspect the documented prefilter alignment fix.
- **Command is captured but no backend request:** inspect overlay state transitions.
- **Backend request succeeds but action is wrong:** inspect `src/assistant.js` and the command catalog.

Only change timers, focus behavior, or handoff code after the trace identifies the failing stage and a repeatable before/after test can validate the change.

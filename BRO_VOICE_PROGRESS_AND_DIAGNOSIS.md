# BRO Voice Engine — Architecture and Verification

**Updated:** October 29, 2026
**Project:** BRO Local AI Assistant
**Status:** BRO now records and transcribes voice itself; the external dictation bridge was removed

## 1. What changed and why

The previous voice path borrowed **Wispr Flow**. BRO simulated Wispr's hands-free shortcut, then recovered the transcript from a nearly invisible textarea or from clipboard polling. That design failed in practice: the popup opened and said "listening", but the words never reached BRO.

Evidence gathered on this machine:

| Check | Result |
| --- | --- |
| Wispr Flow running with a hands-free shortcut | Yes (`Ctrl+Win+Space` = `popo`) |
| Synthetic shortcut actually starts a Wispr session | Yes — `prefs.activeDictationSession` appeared ~127 ms after the tap |
| Wispr history rows for BRO's overlay (`app = electron`) during the failing period | None |
| Last `popo` row targeting `electron` | Oct 22, 07:09 — 0.88 s, empty transcript |

So the shortcut fired, but no usable transcript was ever delivered to BRO. Every recovery path depended on another application's window focus, clipboard behaviour, and timing. Window focus in particular cannot be guaranteed for a hidden always-on-top popup.

**Decision (per your instruction):** BRO keeps its own voice. Wispr Flow stays a separate tool for your own dictation and is no longer part of BRO.

## 2. Current voice pipeline

```
Ctrl + Alt + B
  └─ Electron globalShortcut (native PowerShell helper as fallback)
      └─ overlay renderer: BroRecorder (getUserMedia + AudioContext)
          ├─ 350 ms room-noise calibration
          ├─ energy VAD: stop after 900 ms of silence
          ├─ trim silence, resample to 16 kHz, encode mono PCM16 WAV
          └─ POST /api/voice/transcribe { audio: base64 }
              └─ src/voice.js
                  ├─ warm whisper-server on 127.0.0.1 (model kept in memory)
                  ├─ verbose_json segments filtered by no_speech_prob / avg_logprob
                  └─ clean text (marker stripping, hallucination blacklist)
          └─ transcript shown in the popup
              └─ POST /api/chat → src/assistant.js → actions
```

State machine in the popup: `idle → listening → transcribing → working → idle`. Re-entrant hotkeys, mic clicks, and in-flight transcriptions are rejected by phase, so one key press produces exactly one command.

## 3. Files

| File | Role |
| --- | --- |
| `public/recorder.js` | Microphone capture, calibration, VAD, resampling, WAV encoding. Shared by the popup and the main chat page. |
| `src/voice.js` | Locates the whisper.cpp build, starts a warm server, transcribes, filters hallucinations, falls back to the CLI. |
| `server.js` | `POST /api/voice/transcribe`, `GET /api/voice/status`, voice status in `/api/bootstrap`. |
| `desktop/main.js` | Hotkey, popup lifecycle, microphone permission, backend startup. |
| `public/overlay.js` | Popup state machine and command submission. |
| `public/app.js` | Main chat microphone now uses the same recorder and engine. |
| `scripts/setup-voice.js` | One-time download of the engine and model into `vendor/whisper`. |
| `tests/voice.test.js` | WAV/resampling unit tests, endpoint validation, and architecture guards. |

## 4. Verification performed

Automated:

```text
npm test
35 tests passed, 0 failed
```

Manual, on this machine, with the real Electron popup in the background:

1. Launched `electron desktop/main.js --background` with `BRO_VOICE_DEBUG=1`.
2. Sent `Ctrl+Alt+B` and played a synthesized "open youtube" clip through the laptop speakers.
3. App log:

```text
BRO hotkey triggered
BRO hotkey sent to voice popup
BRO voice clip 1540ms reason=silence peak=0.1282
BRO command captured (12 chars)
BRO transcript: Open YouTube
```

4. `POST /api/chat` reached the backend (verified independently with `list projects` → `No projects are registered yet.`).

Measured transcription latency with the warm server on this machine (i7-11370H, CPU only): **1.4–1.9 s** for a 1.7–2.8 s clip with `ggml-base.en.bin`. A 2 s silence-only clip returns no text after the `no_speech_prob` filter.

## 5. Known limits and next tuning options

- **Speed:** `ggml-tiny.en.bin` transcribes in about 0.8 s on this CPU. Set `BRO_WHISPER_MODEL` to it if you prefer faster replies over accuracy.
- **Accuracy for unusual names:** Whisper is prompted with BRO's command vocabulary. Add project or site names to `BRO_WHISPER_PROMPT` if a word keeps being misheard.
- **Language:** the engine is configured for English (`language=en`). Other languages need a matching multilingual model.
- **Loud rooms:** the VAD uses an adaptive noise floor measured at the start of each capture. Very noisy rooms may still trigger the "I did not hear anything" message, which is preferable to sending a phantom command.
- **First clip after login:** the first transcription also starts the Whisper server, which adds roughly one second.

## 6. Command understanding (“open anything”)

Voice recognition now produces correct text, so `open NAME` was made to resolve the way a person expects:

| Order | Resolution | Example |
| --- | --- | --- |
| 1 | Installed app from `src/app-catalog.json` | `open Telegram` → launches the Telegram desktop shortcut |
| 2 | Known website | `open Gmail` → `https://mail.google.com/` |
| 3 | Any other Start Menu app, matched by name | `open Postman` |
| 4 | Registered project folder | `open My App` |

Phrasings accepted for the open intent: `open`, `launch`, `start`, `visit`, `go to`, `take me to`, `bring up`, `pull up`, `show me`, `check my`. Trailing words such as `app`, `application`, `website`, `site`, `page`, `on my pc`, and `in the browser` are stripped before matching, and `website`/`site`/`web` forces the web version.

Safety: BRO launches only `.lnk` shortcuts it discovered itself inside the Start Menu, and uninstall/readme/documentation shortcuts are excluded. A spoken name never becomes a path or a shell command. `open_app` takes a catalog id; `open_start_menu_app` re-runs the same discovery on the server.

Verified on this PC: `open telegram` → `open_app` → `Opening Telegram.` and the Telegram process started; `open telegram website` → `https://web.telegram.org/`.

The Whisper initial prompt now includes common app names (Telegram, WhatsApp, Chrome, Discord, Slack, Spotify, Zoom, VS Code, Steam, …) so brand names are spelled correctly.

## 7. Wake word and closing (second voice pass)

### Wake word

Saying **“BRO”** now re-opens listening without the hotkey, and the hotkey still works at any time.

| Piece | Behaviour |
| --- | --- |
| `Microphone` in `public/recorder.js` | One persistent stream that can hand clips to a watcher or to a one-shot command capture. |
| `startWatch` | Repeated VAD clips (550 ms silence, 3.5 s max) while waiting for the wake word. |
| `POST /api/voice/wake` | Transcribes with `ggml-tiny.en` through a second warm server and matches wake/sleep phrases (about 0.5 s). |
| Overlay phases | `idle → awake → listening → transcribing → working → idle`. `awake` keeps the mic open; `sleep` closes it. |

Wake phrases: `bro`, `hey bro`, `hi bro`, `hello bro`, `brother`, `hey brother`, `ok bro`, `okay bro`, `wake up bro`, `listen bro`, `bro listen`, `yo bro`. A wake word plus a command in one breath (“BRO, open Telegram”) runs the command immediately. Sleep phrases: `sleep`, `stop listening`, `go to sleep`, `goodbye`, `bye`, `that’s all`.

Verified through the real popup while it was hidden in the background: “Hey BRO” played into the microphone produced `BRO wake word detected in 598ms`, then the following “open Telegram” opened the Telegram app. `POST /api/voice/wake` also returns the right verdicts for “BRO” (wake), “Hey BRO” (wake), “open telegram” (not a wake word) and “stop listening” (sleep).

### Closing

`close NAME`, `quit NAME`, `exit NAME`, `shut NAME`, `kill NAME` and `end NAME` close apps. `close that` uses the last opened app, and `close everything` closes only apps BRO launched this session.

Closing is deliberately two-stage: `taskkill` without `/F` first so apps can save, then `/F` only for apps that merely hide in the tray. Editors and Windows shell processes are exempt. `src/app-catalog.json` now lists `processes` per app, plus a `protected` flag for File Explorer.

Verified on this PC: `open telegram` → `Opening Telegram.`, then `close telegram` → `Closed Telegram.` with no Telegram process left running.

## 8. Universal app discovery and auto-hide

### Store/MSIX apps
The Start Menu `.lnk` scan missed packaged apps: ChatGPT and Claude on this PC are MSIX (`OpenAI.Codex_2p2nqsd0c76g0!App`, `Claude_pzs8sxrjxfjjc!Claude`) and have no `.lnk` file. `scanStartApps()` now reads `Get-StartApps` (name + AppID) and merges those entries, launching through `explorer.exe shell:AppsFolder\<AppID>`.

Resolution order for `open NAME`:

1. catalog app that is installed (Win32 or Store)
2. installed app with an exact name — **the PC beats the web**
3. known website
4. fuzzy installed-app match
5. registered project

Verified: `open chatgpt`, `bro open chatgpt application in my pc`, and `could you please open chatgpt for me` all resolve to `open_app chatgpt` → the ChatGPT Store app; `close chatgpt` closed all 16 ChatGPT processes.

### Flexible wording
`stripCommandPoliteness()` now also removes *I want to / I need to / I'd like to / let's / go ahead and*, and the new `stripActionFillers()` removes trailing *for me / please / right now* plus *app / application / program / window / page / site / website* and *on my pc / in the browser*. Open verbs gained *open up, fire up, boot up, load*.

### Auto-hide
After a command the popup hides itself after 20 s (`BRO_AUTO_HIDE_MS`) while the wake watcher keeps the microphone open; saying “BRO” calls `bro-show-overlay` and starts listening again. Verified in the live app log: `BRO popup hidden until next activation`, then `BRO popup shown` on the wake word.

### Wake-word reliability
Testing exposed two problems and fixed both:

- The tiny model *hallucinated* “Hey BRO” over silence because the wake prompt contained the phrase. The wake server now runs with **no prompt**, `-nf -sns -nth 0.4`, and the wake decision is pure text matching.
- `no_speech_prob` is unusable for one-word clips (a clear “BRO” scored 0.85), so it is not used for the wake decision; the renderer’s energy gate (peak ≥ 0.02) plus text matching decide.

Result table (`POST /api/voice/wake`): silence → no wake, “BRO” → wake, “Hey BRO” → wake, “open telegram” → no wake, “BRO open telegram” → wake + `open telegram` command.

## 9. Removed code

- Wispr Flow detection, key bridge, and clipboard polling.
- The `Ctrl+Win+Space` synthetic tap and its session bookkeeping.
- The restricted `BRO_COMMANDS` System.Speech grammar and its confidence filtering.
- The hidden `#wispr-capture` textarea and all renderer-side Wispr prefilters.
- Preload APIs for the old native/Wispr voice channels.

`clipboard`, `keybd_event`, and `BRO_SPEECH_MIN_CONFIDENCE` no longer exist in the codebase.

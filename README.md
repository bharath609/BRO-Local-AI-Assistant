# BRO · Local AI Assistant

BRO is a local-first personal workbench. It gives you a chat interface, a built-in offline voice engine, safe website/project opening, explicit terminal launching, and named project commands that always require approval before execution.

## Run it

Use Node.js 22 or newer:

```sh
npm start
# development: npm run dev
# checks: npm test
```

### Windows PowerShell

If PowerShell blocks `npm.ps1` with an execution-policy error, do not weaken the policy just to start BRO. Use the Windows command shim instead:

```powershell
npm.cmd start
```

You can also run the server without npm:

```powershell
node server.js
```

Or double-click `start-bro.cmd` in the project folder.

Then open <http://127.0.0.1:4280>.

The app binds to loopback only. If you want another port, set `BRO_PORT` before starting it. The browser UI is served by the same local process, so no frontend build step or dependency install is required.

### Windows desktop overlay

The optional Electron shell keeps a frameless, voice-only BRO window above other windows while continuing to use the same local HTTP app and port. It shows only the BRO mark, mic button, listening status, latest transcript/reply, and a close button. On Windows, **Ctrl + Alt + B** is a tap-to-start key: press and release it once, then speak one command; BRO stops recording on its own after you pause. You do not need to hold the keys or press them again to stop.

BRO records its own microphone audio. The popup captures PCM from the default Windows input device, detects when you start and stop speaking, and sends a single mono 16 kHz clip to the local backend, which transcribes it with a bundled [whisper.cpp](https://github.com/ggml-org/whisper.cpp) engine. No other dictation application, clipboard handoff, or window-focus trick is involved, so the microphone input is always BRO's own. The transcript is shown in the popup, then sent to the local command parser. One capture handles one command; when it finishes BRO goes back to waiting for **“BRO”** or **Ctrl + Alt + B**, so you rarely need to touch the keyboard.

Voice activity detection uses a short room-noise calibration at the start of each capture, then waits for 900 ms of silence before finishing. If the microphone is muted or nothing was heard, the popup says so instead of guessing. Whisper segments that the model itself flags as unlikely speech are discarded, so silence does not turn into a phantom command.

### Wake word and sleeping

After a command finishes, BRO does not go deaf. It keeps the microphone open in a light listening mode and waits for the wake word, so you can just say **“BRO”** instead of reaching for the keyboard. Both routes work at any time:

- **Say “BRO”** (or “hey BRO”, “brother”) — BRO answers “Yes — listening…” and captures your next command. You can also say them together: “BRO, open Telegram”.
- **Press Ctrl + Alt + B** — starts listening immediately, no wake word needed.

To stop hands-free listening say **“sleep”**, “stop listening”, or “goodbye”, or press the **Sleep** button in the popup. The microphone is then released completely and only the hotkey wakes BRO. Set `BRO_WAKE_WORD=0` if you want the microphone to stay closed until you press the hotkey.

After a command the popup stays on screen for **20 seconds**. If no new command arrives, it hides itself — but the microphone keeps listening for **“BRO”**, which brings the window straight back and starts listening. Tune the delay with `BRO_AUTO_HIDE_MS` (milliseconds).

The wake check uses the small `ggml-tiny.en` model (about 0.5 s per check) and only runs when the room is actually loud enough to be speech, so idle room noise never reaches the recogniser. The first wake detection in a session warms that second model, which adds about a second once.

### Closing apps by voice

`close NAME` closes an app the same way the open command finds it:

- `close Telegram`, `quit Chrome`, `shut down Discord` — closes that app.
- `close that` / `close it` — closes whatever BRO opened last (if it was an app).
- `close everything` — closes only the apps BRO opened in this session.
- `close Telegram and Chrome` — several at once.

BRO asks apps to close normally first, so a save prompt can appear. Apps that only hide in the system tray (Telegram, Discord, …) are force-closed. Document editors (Word, Excel, VS Code, Notepad++, …) are never force-closed, and Windows shell processes (Explorer, PowerShell, BRO itself) are always refused. Website tabs cannot be closed individually yet — `close Chrome` closes the browser instead.

Install the local voice engine once (about 160 MB, then fully offline):

```powershell
npm.cmd run setup:voice
```

Optional voice tuning variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRO_WHISPER_MODEL` | `vendor/whisper/models/ggml-base.en.bin` | Point at another GGML model, e.g. `ggml-tiny.en.bin` for lower latency or `ggml-small.en.bin` for better accuracy. |
| `BRO_WHISPER_HOME` | `vendor/whisper` | Where the engine and models live. |
| `BRO_WHISPER_PORT` | `4791` | Preferred port for the warm Whisper server (BRO picks the next free port if taken). |
| `BRO_WHISPER_PROMPT` | BRO command vocabulary | Initial prompt used to bias spelling of product names. |
| `BRO_VOICE_DEBUG` | off | Set to `1` to print the transcript in the app log while testing accuracy. |
| `BRO_HOTKEY` | `Control+Alt+B` | Alternate Electron accelerator for the wake key. |

Windows treats the **Fn** key as a hardware/laptop function layer rather than a normal application key, so `Ctrl + Fn` cannot be registered reliably as a global application shortcut. BRO registers `Ctrl + Alt + B` through Electron's global shortcut first, with a native Windows helper as a fallback if that registration is unavailable.

Install the declared desktop dependency once, then launch the overlay:

```powershell
npm.cmd install
npm.cmd run desktop
```

You can also double-click `start-bro-overlay.cmd`. BRO registers the desktop overlay to start in the Windows background at login, keeps the local backend and global hotkey available, and keeps the popup hidden until you press **Ctrl + Alt + B**. After the first launch, you do not need to open a terminal each day. There is no always-on wake word: when the overlay is not listening, type or say **activate BRO** in the main chat (the main chat microphone uses the same local engine) to bring the voice popup to the foreground; if the overlay is not running, BRO starts the local Electron overlay. Then press **Ctrl + Alt + B** whenever you want to dictate the next one-shot command. Typed chat remains available if a microphone is not connected.

## First-use flow

1. Open **Workspace → Add project** and register a folder you want BRO to work in.
2. Add named profiles such as `npm test`, `npm run dev`, or `npm run build`.
3. In Chat, use requests such as `list projects`, `open https://github.com`, or `run test in My App`.
4. BRO can open sites and registered folders directly. It shows an approval card before running a project profile.
5. Use the microphone button for browser speech recognition, and **Read aloud** for speech synthesis when supported.

BRO greets the configured local user as Bharath by default. To change the display name for a local installation, set `BRO_USER_NAME` before starting the server. Casual greetings create a reply only; they never open a site, project, or command. A local instruction-router skill is stored at `.opencode/skills/bro-instruction-router/SKILL.md`.

Explicit commands include `activate BRO` to show the voice popup, cataloged web resources such as `open ChatGPT`, `open Google Drive`, `open Google Calendar`, `open Stack Overflow`, `open Spotify`, and `open Twitter`, plus allowlisted Windows apps/folders such as `open Word`, `open Excel`, `open PowerPoint`, `open File Explorer`, and `open Pictures`. `search for QUERY` opens Google results, while `search YouTube for QUERY` and `find QUERY on YouTube` open YouTube results. `open terminal` launches a terminal window. Playback control and sending messages are not claimed until a browser-control connection is available and the exact external action is confirmed.

### Opening apps by voice

`open NAME` is resolved in this order:

1. **An app installed on this PC** — classic Start Menu shortcuts *and* Store/MSIX apps (ChatGPT, Claude, WhatsApp, …). The PC always wins over the web: `open ChatGPT` launches the ChatGPT desktop app when it is installed.
2. **A known website** — `open Gmail`, `open YouTube`, `open Google Drive`.
3. Any other installed app matched by name.
4. A registered project folder.

BRO only launches shortcuts it discovered itself (Start Menu `.lnk` files or Start-app IDs); a spoken name never becomes a path or a shell command.

You can ask in whatever shape feels natural — all of these mean the same thing:

```text
open chatgpt
open up chatgpt
launch chatgpt
fire up chatgpt
bro open chatgpt application in my pc
could you please open chatgpt for me
I want to open the chatgpt app
bring up chatgpt on my computer
take me to chatgpt
show me chatgpt
```

Add `website` to force the browser version: `open ChatGPT website`. If nothing matches, BRO says what it can open instead of claiming a project is missing. Add your own apps to `src/app-catalog.json` (`id`, `label`, `aliases`, the exact Start Menu `desktop` names, `processes`, and an optional `url`).

## Optional AI provider

Without a provider, BRO still handles the local command and workspace intents. To enable general AI replies, use **Provider** in the UI and configure an OpenAI-compatible endpoint. For a local Ollama model, use `http://127.0.0.1:11434/v1` and an installed model such as `llama3.2:3b`; local endpoints do not require an API key. For OpenAI, use `https://api.openai.com/v1`, choose the Responses API (or Auto), and enter the exact model available to your account. Settings are stored locally under `data/settings.json`, which is ignored by git. You can also set `BRO_AI_BASE_URL`, `BRO_AI_MODEL`, `BRO_AI_PROTOCOL`, and `BRO_AI_API_KEY` in the process environment before starting BRO. Never put the key in a chat message.

BRO's standalone Node server does not automatically inherit the model selected in the OmniRush desktop chat. OmniRush's ChatGPT/managed model connection is available to the OmniRush desktop app itself; using that model from this separate local server requires an officially supplied OpenAI-compatible endpoint and credential. Do not guess an endpoint or copy desktop session tokens into BRO. The GPT-6.1 Sol preset uses `https://api.openai.com/v1`, model `gpt-6.1-sol`, and the OpenAI Responses API; it still requires an authorized API key and account access.

The provider receives chat history and a short summary of registered project names/profiles. It never receives raw project files, and model output is not executed as shell code. Local model startup and longer answers can take time; BRO allows up to two minutes per provider request and limits generated output to 512 tokens.

The service binds to `127.0.0.1` (port `4280`, configurable with `BRO_PORT`). Registered projects and non-secret settings are stored under `data/`; provider API keys are stored only in `data/settings.json`, which is ignored by git and never returned by the API. Project command profiles are named, registered values; the server never executes a model-generated command. `POST /api/action` requires `requiresApproval: true` for command actions.

## Safety boundary

BRO is intentionally not an unrestricted “do anything on the computer” agent. It can only work inside folders you explicitly register, only runs named profiles you explicitly configure, limits command time/output, and requires an approval flag for command execution. Website opening is restricted to `http://` and `https://` URLs.

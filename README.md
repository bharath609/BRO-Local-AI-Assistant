# BRO · Local AI Assistant

BRO is a local-first personal workbench. It gives you a chat interface, a built-in offline voice engine, safe website/project opening, explicit terminal launching, and named project commands that always require approval before execution.

## Install on Windows

Download the latest `BRO-Assistant-Setup-<version>.exe` from
[GitHub Releases](https://github.com/bharath609/BRO-Local-AI-Assistant/releases)
and run it. Launch **BRO Assistant** from the Start menu or the tray.

- Windows 10/11 x64.
- The build is not code-signed yet, so SmartScreen may show an "unknown
  publisher" warning. Only run an installer downloaded from this repository.
- Voice works offline: the installer bundles the whisper.cpp engine and models.
- Settings, projects, and logs live in `%APPDATA%\BRO Assistant` and are kept
  when you uninstall.
- If no release is listed yet, build from source with the steps below.

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

BRO records its own microphone audio. The popup captures PCM from the default Windows input device, detects when you start and stop speaking, and sends a single mono 16 kHz clip to the local backend, which transcribes it with a bundled [whisper.cpp](https://github.com/ggml-org/whisper.cpp) engine. No other dictation application, clipboard handoff, or window-focus trick is involved, so the microphone input is always BRO's own. The transcript is shown in the popup, then sent to the local command parser. After each command BRO stays ready for 20 seconds (see below), then returns to waiting for **“BRO”** or **Ctrl + Alt + B**, so you rarely need to touch the keyboard.

Voice activity detection uses a short room-noise calibration at the start of each capture, then waits for 1.1 seconds of silence before finishing, so a natural pause mid-command does not cut the sentence off. A 1.2-second audio pre-roll also keeps the first words you say while **"BRO"** is still being verified, so "BRO, open settings" no longer loses the start of the command. If the microphone is muted or nothing was heard, the popup says so instead of guessing. Whisper segments that the model itself flags as unlikely speech are discarded, so silence does not turn into a phantom command.

### Wake word and sleeping

After a command finishes, BRO does not go deaf. It keeps the microphone open in a light listening mode and waits for the wake word, so you can just say **“BRO”** instead of reaching for the keyboard. Both routes work at any time:

- **Say “BRO”** (or “hey BRO”, “brother”) — BRO answers “Yes — listening…” and captures your next command. You can also say them together: “BRO, open Telegram”.
- **Press Ctrl + Alt + B** — starts listening immediately, no wake word needed.

The wake word is matched loosely on purpose: “bra”, “broo”, “bros”, “brah”, “bruh”, and similar sound-alikes all count. Filler before the name is ignored too, so “um, BRO”, “okay bro”, and “hey, BRO” all wake it in one go. If you pause after saying it, BRO re-opens the listening window once instead of asking you to call it a second time.

Wake detection is built to answer on the **first** try:

- **The engine is already warm.** BRO starts both Whisper servers when the app starts and again the moment it enters wake mode, so the first “BRO” of the day no longer waits through a model load. A cold engine was the main reason the name had to be repeated.
- **A short word is enough.** A quick “BRO” is about 200 ms of speech; the recorder now counts it as speech and closes the clip after 450 ms of silence instead of waiting seconds before the engine sees it.
- **The microphone never stops listening while a check runs.** Repeats are checked instead of being swallowed, and only the first confirmed wake starts a command.
- **A second opinion is used sparingly.** If the tiny wake model writes a mangled “BRO”, the accurate model re-checks that one clip (capped at three seconds) — but only for clips that actually look like the name, so ordinary speech does not make the microphone deaf.
- **The whole sentence runs at once.** “BRO, open notepad”, “BRO, chrome”, and “BRO, what time is it” are all captured as one command, so you never have to say the name and then repeat the request.

To stop hands-free listening say **“sleep”**, **“sleep mode”**, “go to sleep mode”, “go sleep”, “sleeping”, “disappear”, or “goodbye”, or press the **Sleep** button in the popup. The popup disappears right away, but BRO keeps the microphone open in wake-word mode — saying **“BRO”** (or pressing **Ctrl + Alt + B**) brings the popup straight back and starts listening. The microphone is released completely only when the popup window is closed with its **×** button. Set `BRO_WAKE_WORD=0` if you want the microphone to stay closed until you press the hotkey.

After a command the popup stays on screen for **20 seconds**. If no new command arrives, it hides itself — but the microphone keeps listening for **“BRO”**, which brings the window straight back and starts listening. Tune the delay with `BRO_AUTO_HIDE_MS` (milliseconds).

### Follow-up listening (no wake word needed)

For those 20 seconds after every command — whether it worked or returned an error — BRO keeps the microphone open and treats the next thing you say as a new command. You do **not** need to say “BRO” again between commands:

- Say “open Telegram”, wait for the reply, then simply say “minimize it” or “close that”.
- If BRO could not understand you or the command failed, just say it again; the popup shows the error and keeps listening.
- Twenty seconds of silence ends the window and returns BRO to wake-word-only mode, where saying **“BRO”** starts it again. Say **“sleep”** (or “go to sleep mode”) to hide the popup immediately; BRO keeps watching for **“BRO”**, and the popup reappears the moment you call it.

### Following the site BRO opened

Once a website is open, BRO treats what you say next as an action **on that site** instead of looking for an app with the same name:

| You say (after “open YouTube”) | What happens |
| --- | --- |
| `play lo-fi beats`, `watch python tutorial for beginners`, `open funny cat compilation` | Finds the top YouTube video and opens it directly with autoplay — it plays, not just searches. |
| `find lo-fi beats`, `look for python tutorial`, `look up lofi hip hop` | Opens the YouTube search results page instead. |
| `watch strangers things` (after “open Netflix”) | Opens Netflix search results. |
| `play the boys` (after “open prime video”) | Opens Prime Video search results. |
| `scroll down`, `scroll up`, `scroll to the top`, `scroll to the bottom`, `page down` | Scrolls the page you opened. The browser keeps its maximized size — BRO aims the wheel at the page, so the window is never shrunk or minimized while scrolling. |

`play <name>` and `play <name> on YouTube` also work without opening YouTube first: BRO looks up the top result and opens that video. The same search verbs work on Google, GitHub, Amazon, Spotify, Reddit, and Wikipedia. Real commands still win: `open Notepad`, `open Downloads`, or `open GitHub` are opened normally instead of becoming a search.

### Opening a file by name

BRO can find and open a document, photo, video, or any other file from your own folders:

- `open report.pdf` — finds the newest/best match and opens it with the default app.
- `open my resume`, `find the budget spreadsheet` — same search, without needing the extension.
- Open a folder first (`open Downloads`), then say `open report.pdf` or `open my resume`; BRO searches that folder first.
- Say `... in Downloads` / `... in Documents` to search a specific folder.

Files are only looked up inside **Desktop, Downloads, Documents, Pictures, Videos, and Music** (including their OneDrive versions). If BRO cannot find the file it tells you where it looked instead of opening something unexpected. Once a file is open, the normal window controls work on it: `check it once`, `minimize it`, `maximize it`, `close that`.

### Controlling the window BRO opened

BRO remembers the last app, folder, terminal, website, or file it opened and understands follow-ups that point back at it:

| You say | What happens |
| --- | --- |
| `check it once`, `show me that`, `bring that back`, `open that video` | Brings the last window back to the front. |
| `minimize it`, `hide that window`, `put it away` | Minimizes the last window. |
| `maximize it`, `make it full screen`, `expand the window` | Maximizes the last window. |
| `restore it` | Restores the last window to its normal size. |
| `close that`, `close it` | Closes the app / browser tab BRO opened last. |

For a website, “that video”/“the page” refers to the browser window BRO opened; BRO brings that browser to the front. To play a specific video, name it: `play <video name>` finds the top YouTube result and opens it with autoplay (see *Following the site BRO opened* above).

Every successful open also brings the new window to the foreground and re-asserts the BRO popup as topmost, so Settings, apps, folders, and browsers no longer appear behind the current window. Apps and browsers open **already maximized** — Windows is launched with `/MAX`, and the default browser is started with `--start-maximized` — so there is no small window that grows a moment later.

The wake check uses the small `ggml-tiny.en` model (about 0.5 s per check) and only runs when the room is actually loud enough to be speech, so idle room noise never reaches the recogniser. Both the wake model and the command model are started when BRO starts, so the first wake detection of a session is as fast as every later one.

A short command (“open notepad”, “scroll down”, “mute”) is decoded by the tiny model first — it is about twice as fast as the accurate model and just as reliable for a few words. If the clip is longer than 2.4 seconds or the tiny model writes more than four words, BRO decodes it again with the accurate `base.en` model. The transcript request also uses Whisper's plain `json` response shape: token-level timestamps in `verbose_json` more than doubled decode time on a laptop CPU without improving a short command.

### Closing apps by voice

`close NAME` closes an app the same way the open command finds it:

- `close Telegram`, `quit Chrome`, `shut down Discord` — closes that app.
- `close that` / `close it` — closes whatever BRO opened last (if it was an app).
- `close everything` — closes only the apps BRO opened in this session.
- `close Telegram and Chrome` — several at once.

BRO asks apps to close normally first, so a save prompt can appear. Apps that only hide in the system tray (Telegram, Discord, …) are force-closed. Document editors (Word, Excel, VS Code, Notepad++, …) are never force-closed, and Windows shell processes (Explorer, PowerShell, BRO itself) are always refused. `close Gmail` closes that browser tab when BRO can identify it; otherwise it closes the browser window showing it.

Install the local voice engine once (about 160 MB, then fully offline):

```powershell
npm.cmd run setup:voice
```

Optional voice tuning variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRO_WHISPER_MODEL` | best installed English model (`small.en`, then `base.en`, then `tiny.en`) | Point at another GGML model, e.g. `ggml-tiny.en.bin` for lower latency or `ggml-small.en.bin` for better accuracy. |
| `BRO_WHISPER_BEAM` | `5` | Beam-search width for command transcription. Lower it to `2` for less CPU work, raise it (max 8) for accuracy. |
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

> **Important:** the overlay is an Electron app. Do **not** start it with
> `node desktop/main.js`; plain Node has no Electron APIs and the app will exit
> immediately with an error. Always use `npm.cmd run desktop`,
> `start-bro-overlay.cmd`, or the **BRO Assistant** desktop shortcut.

For everyday use, double-click **BRO Assistant** on your Desktop (or in the
Start Menu), or double-click `Start-BRO.vbs` in this folder. That shortcut runs
the bundled Electron runtime directly, so no terminal window is needed. If BRO
is already running, launching the shortcut again brings the popup back to the
front instead of starting a second copy.

You can also double-click `start-bro-overlay.cmd`. BRO registers the desktop overlay to start in the Windows background at login, keeps the local backend and global hotkey available, and keeps the popup hidden until you press **Ctrl + Alt + B**. After the first launch, you do not need to open a terminal each day. There is no always-on wake word: when the overlay is not listening, type or say **activate BRO** in the main chat (the main chat microphone uses the same local engine) to bring the voice popup to the foreground; if the overlay is not running, BRO starts the local Electron overlay. Then press **Ctrl + Alt + B** whenever you want to dictate the next one-shot command. Typed chat remains available if a microphone is not connected.

## First-use flow

1. Open **Workspace → Add project** and register a folder you want BRO to work in.
2. Add named profiles such as `npm test`, `npm run dev`, or `npm run build`.
3. In Chat, use requests such as `list projects`, `open https://github.com`, or `run test in My App`.
4. BRO can open sites and registered folders directly. It shows an approval card before running a project profile.
5. Use the microphone button for browser speech recognition, and **Read aloud** for speech synthesis when supported.

BRO greets the configured local user as Bharath by default. To change the display name for a local installation, set `BRO_USER_NAME` before starting the server. Casual greetings create a reply only; they never open a site, project, or command. Local instruction-router and application-control skills are stored at `.opencode/skills/bro-instruction-router/SKILL.md` and `.opencode/skills/bro-application-control/SKILL.md`.

## Conversation and the AI brain

The configured model (Qwen by default) is the voice of the assistant, not a command manual. Greetings such as “Hello BRO”, questions such as “What can you do?”, and anything the deterministic parser cannot map are answered by the model in normal language. The full command list is opt-in: say **“command reference”** or **“list all commands”** when you actually want it.

Routing is hybrid on purpose:

1. **Deterministic parser first** in `src/assistant.js`. Fast, offline, exact commands (`open Chrome`, `scroll down`, `what time is it`) keep working in milliseconds and never need the model.
2. **AI brain second** in `src/brain.js`. Conversation, ambiguous requests, and PC actions the parser does not recognize go to the model.
3. **Tools, not shell access.** The model may call one of 20 validated tools (open/close apps and sites, search, windows, media, typing, screenshots, folders, settings, projects). Every argument is checked in `src/tool-schema.js` before it becomes an action.
4. **Guardrails stay in charge.** Tool actions run through the same `runWithGuardrails()` pipeline as every other action. Destructive work (shutdown, restart, delete, Recycle Bin, guardrail changes) is deliberately not offered as a tool, so the existing spoken-confirmation path is never bypassed.

Providers with OpenAI-style tool calling use it directly (chat-completions and Ollama). Providers without it, including the Responses API, fall back to a strict JSON tool protocol (`{"tool":"...","arguments":{...}}`). The loop is bounded to 4 model steps and 6 tool calls, so a confused model cannot spin forever.

Chat is streamed over newline-delimited JSON at `POST /api/chat/stream`, which lets the UI show live status (“Opening Chrome…”) while a tool runs and guarantees a `done` event. The non-streaming `POST /api/chat` endpoint remains for compatibility.

See `docs/AI_BRAIN.md` for the architecture, safety model, and verification results.

## Reply-first, async command execution

Commands return a reply **immediately**, before any window/focus/scroll work runs. This means every spoken request gets a response within ~50–200 ms, and the actual action (opening apps, scrolling, maximizing windows, playing media keys) happens in the background so it never blocks the next command.

The reply-first loop in `server.js` splits actions into two phases:

1. **Reply immediately** — the chat reply and HTTP response are sent to the client right away.
2. **Background execution** — all "immediate" actions (`open_desktop_target`, `open_app`, `open_url`, `scroll`, `media_key`, `screenshot`, etc.) are launched in a `void(async () => { ... })()` fire-and-forget loop that uses the new async window layer (`runPowerShellAsync`, `controlWindowAsync`, `maximizeWindowByHwndAsync`, `scrollActiveWindowAsync`, `mediaKeyAsync`, `raiseBroOverlayAsync`). PowerShell no longer blocks the Node HTTP server.

**Result:** `open notepad` returns in ~8 ms; `scroll down` returns in ~15 ms; `what time is it` returns in ~70 ms (local clock). The actual window activation, focus‑retry loops, and maximizing happen afterwards and do not add any stall to the reply.

Explicit commands include `activate BRO` to show the voice popup, desktop apps such as `open Word`, `open Excel`, `open PowerPoint`, `open File Explorer`, and `open Pictures`, cataloged web resources such as `open ChatGPT`, `open Google Drive`, `open Google Calendar`, `open Stack Overflow`, `open Spotify`, and `open Twitter`, plus `search for QUERY` (Google results), `search YouTube for QUERY`, `find QUERY on YouTube`, and `open terminal`. BRO can also control playback and the last opened app or page — see *Application-control commands* below.

### Opening apps by voice

`open NAME` is resolved in this order:

1. **An app installed on this PC** — Start Menu shortcuts, Store/MSIX apps, shortcuts on your Desktop, and executables under your per-user Programs folder. The PC always wins over the web: `open ChatGPT` launches the ChatGPT desktop app when it is installed, and `open Google` launches Chrome when Chrome is installed.
2. **A known website** — `open Gmail`, `open YouTube`, `open Google Drive`, but only when no strong desktop-app match exists. Weak partial matches never hijack a site (`open link` still opens LinkedIn, not Phone Link).
3. A registered project folder.

BRO only launches shortcuts and executables it discovered itself; a spoken name never becomes a path or a shell command.

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

### Application-control commands

These commands act on the app, page, or window BRO opened last. If nothing is open, BRO asks you to open something first instead of guessing.

| Area | Examples |
| --- | --- |
| Playback | `play`, `pause`, `stop`, `resume`, `forward` / `backward` (10 s), `rewind 30 seconds`, `next track`, `previous track`, `play the next video`, `play the previous video`, `skip forward 30 seconds`, `skip back 20 seconds` |
| Volume and video | `volume up`, `volume down`, `mute`, `unmute`, `turn captions on`, `turn captions off`, `enter fullscreen`, `exit fullscreen` |
| Browsing | `new tab`, `close this tab`, `next tab`, `previous tab`, `reopen closed tab`, `go back`, `forward`, `refresh`, `zoom in`, `zoom out`, `bookmark this page`, `browser downloads`, `history` |
| Pages, feeds, and lists | `scroll down`, `scroll up`, `scroll down a little`, `scroll down a lot`, `scroll down a page`, `scroll down 2 times`, `scroll more`, `page down`, `scroll to top`, `scroll to bottom` |
| Keyboard and mouse | `press control s`, `type Hello World`, `click first result`, `right click Settings`, `double click report.pdf`, `select all`, `copy`, `paste`, `undo` |
| Gmail / Outlook | `open my inbox`, `open sent`, `search my gmail for invoices`, `find emails from Arun`, `open first unread email`, `reply`, `archive this email` |
| LinkedIn / WhatsApp | `open linkedin feed`, `search linkedin for python developer`, `find jobs for data analyst`, `search chats for Arun`, `open chat with Arun` |
| Google Drive / Docs / Calendar | `open google drive starred`, `search drive for budget`, `create a new doc`, `show today's schedule`, `switch to week view` |
| Office, VS Code, PDFs | `save`, `save as`, `print`, `make this bold`, `add a new slide`, `start the slideshow`, `open the terminal`, `problems`, `next page`, `fit to page` |
| File Explorer | `create a new folder`, `create a new folder called Reports`, `create a folder called Reports in downloads`, `rename this file to final report`, `show file properties`, `search this folder for pdf` |
| Windows shell | `open start menu`, `show task view`, `open quick settings`, `show notifications`, `open windows search`, `open run dialog`, `show clipboard`, `open emoji picker`, `refresh`, `refresh the desktop`, `switch window` |
| Windows tools | `open control panel`, `open device manager`, `open programs and features`, `open network connections`, `open power options`, `open sound settings`, `open mouse settings`, `open date and time`, `open region`, `open internet options`, `open system information`, `open event viewer`, `open disk management`, `open services`, `open printers`, `open recycle bin`, `open this pc` |
| System | `take a screenshot`, `show desktop`, `open bluetooth settings`, `open wi-fi settings`, `open taskbar settings`, `lock the pc`, `switch to notepad` |

Risky actions ask for a spoken confirmation first: `shut down the pc`, `restart the computer`, `delete this file`, and `empty the recycle bin` only run after you say **yes**; say **no** or **cancel** to stop them. Under the default `guarded` level, every action that changes files, closes apps or windows, or touches the power controls waits for the same one-time approval. Moving a file uses the Recycle Bin, not a permanent delete. WhatsApp messages, LinkedIn applications, and screen sharing are never sent or started automatically.

When BRO opens a window it brings that window to the front, enlarges it to fill the screen when it opened small, and keeps the BRO popup above it, so the reply stays visible without hiding the app you just opened.

The rules live in `src/skills/application-control.js`; the matching skill notes are in `.opencode/skills/bro-application-control/SKILL.md`.

## Your control key: guardrails

Every action BRO can perform passes through one central policy in `src/guardrails.js`. The key stays with you: the AI model can suggest an action, but it can never approve, execute, or bypass one. Approval is stored on the server and is only created by your spoken **yes** or by a click in the Guardrails panel.

### Three guardrail levels (changeable by voice: `guardrails strict`, `guardrails guarded`, `guardrails trusted`):

| Level | Runs immediately | Waits for your yes |
| --- | --- | --- |
| `strict` | Read-only information | Everything that touches the PC, even opening an app |
| `guarded` (default, now changed to **`trusted`**) | Opening, typing, playback, scrolling | File changes, closing apps/windows, shutdown/restart, deleting, locking the PC |
| `trusted` | **Opening, typing, files, scrolling** | **Destructive actions only** |

**In trusted mode (the new default), all non-destructive commands execute immediately without yes/no prompts.** Only truly destructive actions (shutdown, delete, empty recycle bin) require a one-time approval. This is the "normal" mode you requested - commands just work.

- **One approval = one action.** An approval expires after two minutes and cannot be replayed.
- **Master lock.** While it is on (`lock everything`), only admin-level risks are blocked. Normal commands still run. `unlock controls` turns it back off.
- **Default deny for new features.** Any action type not registered in the risk table is treated as destructive and blocked until registered - safety is the default, not an opt-in.
- **Audit trail.** Every run, block, approval request, and denial is appended to `data/audit.log` (JSONL, 1 MB rotation) and shown in the Guardrails tab.
- **The model has no hands.** The optional AI provider only writes chat replies; it never returns actions, cannot call `/api/action`, and cannot approve anything. All actions come from the local deterministic rules and the server checks them again.

### Voice‑driven PC control demo (what a recruiter would see)

**10‑second demo script:**

| Time | Action | Result |
| --- | --- | --- |
| 0:00 | Say **"BRO"** (or press **Ctrl+Alt+B**) | Voice popup opens, mic activates |
| 0:05 | Say **"open notepad"** | Notepad opens immediately, no prompt |
| 0:10 | Say **"take a screenshot"** | Screenshot saved to Pictures/BRO Screenshots |
| 0:15 | Say **"open calculator"** | Calculator opens immediately |
| 0:20 | Say **"lock everything"** | Popup shows "Master lock is on" |
| 0:25 | Say **"open notepad"** | Still opens (lock only blocks admin) |
| 0:30 | Say **"unlock controls"** | Lock clears, normal commands resume |

**Diagram: BRO voice → command parser → guardrails check → execute/action → result**

```
User speaks → Wake word detected → Whisper transcription → Command parser → 
Risk classification (launch/input/file/destructive/read/admin) → 
Guardrails mode check (trusted/guarded/strict) → 
Execute if allowed / Ask for yes if needed → Outcome returned to user
```

### Recruiter‑attracting pitch (copy‑paste)

> **BRO · Local AI Assistant** – A voice‑controlled PC assistant that stays under your control.  
> - **Trusted mode:** Everyday commands (open apps, type, scroll, screenshot) run instantly – no confirmation prompts.  
> - **Guardrails:** Three levels (`strict`/`guarded`/`trusted`) changeable by voice; master lock blocks only admin actions.  
> - **Safe by design:** Unknown future commands are blocked as destructive until registered; the AI never sees or grants approvals.  
> - **Full audit:** Every action logged and viewable in the Guardrails tab.  
> - **Works offline:** Built‑in Whisper speech engine, no cloud dependencies for command understanding.  
> - **Recruiter demo (10 sec):** Say "BRO, open notepad" → notepad opens instantly. Say "BRO, take screenshot" → saved instantly. Say "BRO, lock everything" → lock engages. Demonstrates a capable, controllable AI assistant that respects user authority.

---

*Guardrails simplified – 162/162 tests pass (149 foundation + 13 new agent tests), trusted mode default, commands execute directly without yes/no prompts. BRO 2.0 agent layer adds computer-use capabilities with confirmation gates, master lock, and multi-step planning.*

Without a provider, BRO still handles the local command and workspace intents. To enable general AI replies, use **Provider** in the UI and configure an OpenAI-compatible endpoint. For a local Ollama model, use `http://127.0.0.1:11434/v1` and an installed model such as `qwen2.5:3b`; local endpoints do not require an API key. If Ollama is installed but not running, BRO starts it automatically and retries the request once. For OpenAI, use `https://api.openai.com/v1`, choose the Responses API (or Auto), and enter the exact model available to your account. Settings are stored locally under `data/settings.json`, which is ignored by git. You can also set `BRO_AI_BASE_URL`, `BRO_AI_MODEL`, `BRO_AI_PROTOCOL`, and `BRO_AI_API_KEY` in the process environment before starting BRO. Never put the key in a chat message.

**Installing a local model.** Install Ollama (`winget install --id Ollama.Ollama -e`, or unzip the release into `%LOCALAPPDATA%\Programs\Ollama`), then pull a model with `ollama pull qwen2.5:3b`. A 3B Q4 build needs about 2 GB of disk and runs on CPU at roughly 12 tokens per second on a recent laptop CPU, so a short answer lands in about 2 seconds warm and about 15 seconds on the very first request while the model loads. If `ollama pull` stalls on a slow connection, download the GGUF over IPv4 and build it locally: `ollama create qwen2.5:3b -f Modelfile` with `FROM C:\path\to\model.gguf`. If the configured model is missing, BRO says which `ollama pull` command to run instead of pretending the runtime is offline.

**Why a local model can feel slower than the commands.** Spoken commands never touch the model: opening apps, scrolling, the clock, screenshots, and similar intents are answered in 10–80 ms by the local command parser. Only general questions reach the model. When they do, BRO uses Ollama's **native** `/api/chat` endpoint, because the OpenAI-compatible `/v1` endpoint ignores the tuning that keeps the microphone responsive. The native request keeps the model resident for 10 minutes (`keep_alive`), limits the context to 2048 tokens (`num_ctx`), and gives the model half of the logical CPU threads (`num_thread`), so the two Whisper engines keep the cores they need. A resident model also avoids paying the ~12-second load again on the next question. If Ollama was closed, BRO starts it in the background at launch and retries a failed request once.

BRO's standalone Node server does not automatically inherit the model selected in the OmniRush desktop chat. OmniRush's ChatGPT/managed model connection is available to the OmniRush desktop app itself; using that model from this separate local server requires an officially supplied OpenAI-compatible endpoint and credential. Do not guess an endpoint or copy desktop session tokens into BRO. The GPT-6.1 Sol preset uses `https://api.openai.com/v1`, model `gpt-6.1-sol`, and the OpenAI Responses API; it still requires an authorized API key and account access.

The provider receives chat history and a short summary of registered project names/profiles. It never receives raw project files, and model output is not executed as shell code. Local models get a deliberately short system prompt and only the last six turns, because a small model pays for every prompt token in prefill time, and answers are capped at 120 tokens (three or four spoken sentences) so replies stay short and never hang the microphone behind a minute of generation. Hosted models keep the longer history and a 512-token cap. Hosted requests may take up to two minutes; a local model that has not answered within 30 seconds is reported as timed out instead of leaving BRO “working” indefinitely.

A spoken sentence that starts like a PC action (“scroll to the left”, “maximize the settings window”) but matches no local rule is answered instantly with a short “I don’t know how to do that yet” reply. The local model has no access to the desktop, so sending that sentence to it would only add seconds of waiting before the same apology.

The service binds to `127.0.0.1` (port `4280`, configurable with `BRO_PORT`). Registered projects and non-secret settings are stored under `data/`; provider API keys are stored only in `data/settings.json`, which is ignored by git and never returned by the API. Project command profiles are named, registered values; the server never executes a model-generated command. `POST /api/action` requires `requiresApproval: true` for command actions.

## Safety boundary

BRO is intentionally not an unrestricted “do anything on the computer” agent. It can only work inside folders you explicitly register, only runs named profiles you explicitly configure, limits command time/output, and requires an approval flag for command execution. Website opening is restricted to `http://` and `https://` URLs. File open/rename/delete actions are re-validated against your own Desktop, Downloads, Documents, Pictures, Videos, and Music folders, deletes use the Recycle Bin, and shutdown, restart, file deletion, and emptying the Recycle Bin require a spoken confirmation.

On top of those rules, every action is classified by risk and checked against your guardrail level before it runs. The server — not the model — owns the approval queue, the mode, and the master lock. A page or script running in the app cannot mark an action as pre-approved; only a spoken yes handled by `/api/chat` or a click on `/api/approvals/:id` can. The Guardrails tab and `/api/guardrails`, `/api/approvals`, and `/api/audit` expose the same state. The real data folder can be moved with `BRO_DATA_DIR` if you want a separate profile.

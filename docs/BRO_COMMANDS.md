# BRO 2.0 Command Reference

> **Quick start:** Say `"BRO"` (or press **Ctrl + Alt + B**) to activate the voice popup, then speak one command. The popup stays open for 20 seconds of follow-up listening.

---

## 🎙️ Wake & Listening

| Action | Trigger |
|---|---|
| Wake word | Say `"BRO"` (or `"hey BRO"`, `"brother"`) |
| Hotkey | Press **Ctrl + Alt + B** |
| Start listening | Popup activates, mic listens |
| Follow-up window | 20 seconds after last command (no wake word needed) |
| Sleep / hide | Say `"sleep"`, `"go to sleep mode"`, or press the **Sleep** button |
| Microphone off completely | Close the popup window with its **×** button |

---

## 📺 YouTube

| Command | Result |
|---|---|
| `open history in YouTube` | Opens `https://www.youtube.com/feed/history` |
| `search YouTube for <query>` | Searches YouTube, shows results |
| `play lo-fi beats on YouTube` | Searches and plays first result with autoplay |
| `play <video title> on YouTube` | Searches and plays that specific video |
| `youtube control play` | Plays the current video |
| `youtube control pause` | Pauses the current video |
| `youtube control volume <n>` | Sets volume 0–100 (e.g., `volume 70`) |
| `youtube control seek <n>` | Seeks to n seconds (e.g., `seek 120`) |
| `youtube now playing` | Reports: title, channel, duration, current time, volume, play state |
| `youtube control mute` | Mutes the video |
| `youtube control unmute` | Unmutes the video |

### Gmail
| Command | Result |
|---|---|
| `open Gmail inbox` | Opens `https://mail.google.com/mail/u/0/#inbox` |
| `search my Gmail for <query>` | Searches inbox rows (sender, subject, snippet, unread) |
| `open sent in Gmail` | Opens Sent folder |
| `open drafts in Gmail` | Opens Drafts folder |
| `gmail create draft to <name> about <topic>` | Creates a draft (never sends without your final `"yes"`) |
| Example: `gmail create draft to Arun about the project` | Draft opens with recipient pre-filled; you must review and send |

### LinkedIn
| Command | Result |
|---|---|
| `open LinkedIn feed` | Opens LinkedIn home feed |
| `search LinkedIn for <query>` | Search people, jobs, or posts (read-only) |
| Example: `search LinkedIn for machine learning jobs` | Returns list of results; BRO never sends connection requests |

---

## 💻 VS Code

| Command | Result |
|---|---|
| `open VS Code` | Focus or open VS Code |
| `open VS Code and create folder called <name>` | Creates a new folder workspace |
| `create <filename> in VS Code` | Creates a new file (specify extension: `main.py`, `app.js`, etc.) |
| `write <code content> in VS Code` | Writes code to the current or new file |
| `save in VS Code` | Sends the save shortcut (Ctrl+S) |
| `run python file in VS Code` | Runs the Python file with the validated interpreter; returns output |
| `run node file in VS Code` | Runs the JS/TS file with node; returns output |
| `save and run in VS Code` | Saves then runs the file |

### VS Code File Actions
| Command | Result |
|---|---|
| `create main.py in VS Code` | Creates `main.py` if it doesn't exist; opens it |
| `write `def hello()` in VS Code` | Inserts that code at cursor |
| `save the file in VS Code` | Saves the currently focused file |
| `rename this file to <new name>` | Renames the file (requires confirmation) |
| `move this file to <folder>` | Moves the file (requires confirmation) |

---

## 📁 Files & Folders

| Command | Result |
|---|---|
| `open Downloads` | Opens File Explorer to `%USERPROFILE%\Downloads` |
| `open Documents` | Opens File Explorer to `%USERPROFILE%\Documents` |
| `open Pictures` | Opens File Explorer to `%USERPROFILE%\Pictures` |
| `search for <name>` | Searches your allowed folders (Desktop, Downloads, Documents, Pictures, Videos, Music) |
| `create folder called <name>` | Creates a folder in your allowed roots |
| `create file called <name>` | Creates a new text file (UTF-8) |
| `rename this file to <new name>` | Renames the selected/file (requires confirmation) |
| `move <file> to <folder>` | Moves a file to a destination folder (requires confirmation) |
| `delete this file` | Moves to Recycle Bin (requires confirmation under guardrails) |
| `open <filename>` | Opens the file with its associated app (if within allowed roots) |

### File Search Examples
| Command | Searches |
|---|---|
| `search for report.pdf` | Finds the newest match in allowed folders |
| `find my resume` | Searches without needing the extension |
| `open report.pdf in Downloads` | Opens a specific file in a specific folder |

---

## 🖥️ Windows Desktop

| Command | Result |
|---|---|
| `open Notepad` | Opens or focuses Notepad |
| `open calculator` | Opens Windows Calculator |
| `take a screenshot` | Saves to `%USERPROFILE%\Pictures\BRO Screenshots` |
| `show desktop` | Minimizes all windows (BRO popup stays on top) |
| `lock the pc` | Locks Windows (requires spoken `"yes"` confirmation) |
| `unlock controls` | Turns off master lock (if enabled) |
| `open start menu` | Opens the Start menu |
| `open quick settings` | Opens Windows Action Center |
| `open run dialog` | Opens Win+R |
| `open emoji picker` | Opens emoji picker |
| `refresh the desktop` | Refreshes icon/layout |

---

## 🎵 Playback & Volume (when media is open)

| Command | Result |
|---|---|
| `play` | Plays the current video/audio |
| `pause` | Pauses |
| `stop` | Stops playback |
| `volume up` | Increases volume |
| `volume down` | Decreases volume |
| `mute` | Toggles mute |
| `unmute` | Unmutes |
| `scroll down` | Scrolls the page down |
| `scroll up` | Scrolls the page up |
| `scroll to the top` | Jumps to top of page |
| `scroll to the bottom` | Jumps to bottom of page |

### Media Key Shortcuts
| Command | Trigger |
|---|---|
| `press control s` | Saves the current file/page |
| `type <text>` | Types the text at cursor (e.g., `type Hello World`) |
| `click first result` | Clicks the first result on a page |
| `select all` | Selects all content |
| `copy` | Copies selection |
| `paste` | Pastes from clipboard |
| `undo` | Undoes last action |

---

## ⚙️ System & Settings

| Command | Result |
|---|---|
| `open start menu` | Opens Start |
| `show task view` | Opens Task View (virtual desktops) |
| `open quick settings` | Opens Wi-Fi, Bluetooth, volume panel |
| `open notifications` | Opens notification center |
| `open windows search` | Opens Search/Cortana |
| `open control panel` | Opens Control Panel |
| `open device manager` | Opens Device Manager |
| `open power options` | Opens Power settings |
| `open sound settings` | Opens Sound control panel |
| `open taskbar settings` | Opens taskbar configuration |
| `open wifi settings` | Opens Wi-Fi network list |
| `open bluetooth settings` | Opens Bluetooth pairings |
| `lock the pc` | Locks Windows (requires `"yes"`) |
| `switch to notepad` | Brings Notepad to front (if open) |

---

## 🛡️ Guardrails (Voice-Changeable Modes)

| Voice Command | Effect |
|---|---|
| `guardrails strict` | Every action waits for your yes (read-only info + PC actions need approval) |
| `guardrails guarded` | Opening, typing, playback, scrolling need yes; file changes/closing/power need yes |
| `guardrails trusted` **(default)** | Non-destructive commands run immediately; only shutdown/delete/empty recycle bin need yes |
| `lock everything` | Master lock on — only admin-level risks are blocked; normal commands still run |
| `unlock controls` | Master lock off — normal commands resume |

### Guardrail Priority
```
strict:        everything needs yes
guarded:       file/close/power need yes; others run
trusted:       only destructive (shutdown/delete/recycle) need yes
locked:        agent tools blocked except read; "unlock controls" turns it off
```

### Check Current Mode
| Command | Result |
|---|---|
| `status` | Reports: busy, guardrails mode, pending approvals, agent task status |
| `guardrails status` | Short: "Guarded mode", "Trusted mode", "Strict mode", "Master lock on" |

---

## 📂 Projects (Registered Folders)

| Command | Result |
|---|---|
| `list projects` | Shows registered projects with their roots |
| `open <project name>` | Opens the project folder in File Explorer or VS Code |
| `add project <folder path>` | Registers a folder (done via UI → Workspace → Add project, or by voice if configured) |
| `run <profile name>` | Runs a named profile (e.g., `npm test`, `npm run build`) |

### Profile Examples
| Profile | Trigger |
|---|---|
| `run test in My App` | Runs whatever is configured for that profile |
| `run dev in my-project` | Starts the dev server for that project |

---

## ℹ️ Informational / Conversational

| Command | Result |
|---|---|
| `what can you do?` | Explains BRO's capabilities (you are reading it now!) |
| `status` | Reports: busy, guardrails mode, pending approvals, agent task status, open apps |
| `list my projects` | Shows registered projects and their folders |
| `who are you?` | "I'm BRO, your personal AI desktop assistant." |
| `tell me about yourself` | Short bio + capabilities overview |

---

## 🔧 Troubleshooting Commands

| Issue | Command / Fix |
|---|---|
| "I don't know how to do that yet" | Try rephrasing; check if the command is in the supported list |
| Transcription too slow / inaccurate | Set `BRO_WHISPER_MODEL=base.en` (or `small.en`) before starting BRO |
| Command not recognized | Speak clearly after the listening light turns on; wait ~1s after saying "BRO" |
| "Master lock is on" | Say `"unlock controls"` to disable; or change guardrails mode |
| Browser won't open YouTube history | Say `"open history in YouTube"` (be clear about "YouTube") |
| Gmail not opening inbox | Say `"open Gmail inbox"`; make sure you're signed in in the BRO browser |
| VS Code not found | Set `BRO_VSCODE_PATH` env var, or install VS Code and restart BRO |
| Update available? | Check GitHub Releases for `BRO-Assistant-Setup-2.0.0.exe` (manual) |

---

## 📱 Quick Reference Card (What to Say)

### First-time use
```
BRO
open notepad
take a screenshot
lock everything
unlock controls
```

### YouTube session
```
BRO
open history in YouTube
search YouTube for python tutorials
play lo-fi beats on YouTube
youtube control volume 70
youtube now playing
```

### Gmail session
```
BRO
open Gmail inbox
search my Gmail for invoices
gmail create draft to Arun about the project
```

### VS Code session
```
BRO
open VS Code
create main.py in VS Code
write `def hello(): pass` in VS Code
save in VS Code
run python file in VS Code
```

### File management
```
BRO
open Downloads
search for report.pdf
create folder called Projects
create file called notes.txt
```

---

## 🛠️ Technical Notes for Power Users

| Feature | Detail |
|---|---|
| Voice model | Bundled Whisper.cpp (offline, no cloud) |
| Command parser | Deterministic first, then AI brain (Qwen) |
| Guardrails | Server-owned approval queue + master lock |
| Agent tools | 50 registered tools (files, VS Code, Notepad, browser, YouTube, Gmail, LinkedIn) |
| Confirmation gate | Exact pending `{name, key}` only; generic "yes" cannot approve different action |
| Master lock | `ctx.locked` — say "unlock controls" to re-enable |
| Browser | Chrome DevTools Protocol (no Playwright); semantic DOM locators |
| OCR | Optional — install Tesseract, set `BRO_TESSERACT_PATH` |
| Supported OS | Windows 10/11 x64 |
| Installer | NSIS: `BRO-Assistant-Setup-${version}.exe` |

---

## 📜 Version & Build

| Item | Value |
|---|---|
| Current version | **2.0.0** |
| Installer | `BRO-Assistant-Setup-2.0.0.exe` |
| Git tag | `v2.0.0` |
| Tests | 162/162 passing |
| Voice engine | Whisper.cpp (bundled, offline) |
| AI provider | Qwen (configure via `BRO_BASE_URL`, `BRO_MODEL`) |
| Guardrails modes | `strict` / `guarded` / `trusted` (voice-changeable) |
| Master lock | Voice: `lock everything` / `unlock controls` |

---

*This file is tracked in the repository at `docs/BRO_COMMANDS.md`. It is updated with each BRO release. Users can open it from the Docs tab in the web UI, or from the GitHub repository.*

---

*Last updated: 22 November 2026 — BRO 2.0 release*
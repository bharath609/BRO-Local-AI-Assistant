# BRO 2.0: Intelligent Computer Vision & Application Automation

## Overview

BRO 2.0 upgrades the existing voice assistant into a personal AI computer operator that observes application state, plans multi-step tasks, automates VS Code/files/browser/web apps, verifies outcomes, and preserves existing commands/UI/voice/guardrails.

**Version:** 2.0.0  
**Branch:** `bro-2.0`  
**Status:** All 162 tests pass (149 foundation + 13 new agent tests)

---

## Architecture

```
VOICE OR TEXT INPUT
        |
        v
SPEECH-TO-TEXT (for voice)
        |
        v
CONVERSATION AND CONTEXT MANAGER
        |
        v
QWEN INTENT UNDERSTANDING
        |
        v
TASK PLANNER (bounded, confirmed steps)
        |
        v
APPLICATION AND STATE DETECTION (observation layer)
        |
        v
POLICY / PERMISSION VALIDATION (master lock + confirmation gate)
        |
        v
TOOL REGISTRY AND ROUTER (50 registered tools)
        |
        +----------------------+----------------------+
        |                                    |
        v                                    v
WINDOWS DESKTOP AUTOMATION         BROWSER AUTOMATION (CDP)
        |                                    |
        v                                    v
UI AUTOMATION / COMPUTER VISION    Semantic DOM locators
        |
        v
ACTION VERIFICATION
        |
        v
RESPONSE GENERATION
        |
        v
TEXT AND VOICE OUTPUT
```

### Key Principles

- **Qwen interprets/plans; trusted app code validates and executes.** The model must never run arbitrary shell/PowerShell/Python.
- **Agent confirmations are separate from existing guardrails.** A "yes" only approves the exact pending `{name, key}` call.
- **Deterministic router remains first**; narrow intent detection routes multi-step/computer-use requests to the agent when a provider is configured.
- **A dedicated BRO browser profile is launched** when no debug port is already available; users sign in themselves.
- **Master lock (`ctx.locked`) blocks non-read agent tools.**
- **Treat webpages/files/model output as untrusted; ignore prompt injection; never bypass CAPTCHAs/login/paywalls.**

---

## Tool Registry (50 registered tools)

### Files & Folders
- `list_directory`, `search_files`, `latest_file`, `create_folder`, `create_file`, `write_file`, `read_file`, `rename_file`, `move_file`, `open_file`, `file_exists`

### Visual Studio Code
- `vscode_status`, `vscode_open_folder`, `vscode_open_file`, `vscode_create_file`, `vscode_write_file`, `vscode_read_file`, `vscode_focus`, `vscode_save`, `vscode_run_file`

### Notepad
- `notepad_status`, `notepad_open`, `notepad_focus`, `notepad_type`, `notepad_write`, `notepad_read`

### Windows Observation
- `observe_state`, `list_windows`, `inspect_window`, `take_screenshot`, `read_screenshot_text`, `verify_state`

### Browser (CDP, no Playwright)
- `browser_status`, `browser_open`, `browser_read`, `browser_click`, `browser_fill`, `browser_scroll`, `browser_back`, `browser_forward`, `browser_tabs`, `browser_wait_for`

### Web Applications
- `youtube_search`, `youtube_play`, `youtube_control`, `youtube_now_playing`
- `gmail_read_inbox`, `gmail_search`, `gmail_create_draft`
- `linkedin_search`

---

## Task Planning and Execution

### Confirmation Gate

Every risky step (file overwrite, code execution, send/delete actions) pauses the session so the next user turn can approve or cancel **exactly that call**. A generic "yes" cannot approve a different action.

### Master Lock

`ctx.locked` blocks all agent steps except `read`-risk tools. Say "unlock controls" to re-enable.

### Cancellation

A new goal replaces an unfinished task, including any pending confirmation. Tasks can be cancelled via `/api/task/cancel` or the UI Stop button.

### Planner Tests (8/8 pass)

- Multi-step execution with verified outcomes
- Exact confirmation pause/resume
- Denial cancels without running the tool
- Cancellation stops the planner between steps
- JSON fallback accepts only registered tools
- Master lock blocks agent steps that would change the PC
- Manager exposes pending confirmation and cancels cleanly

---

## Browser Automation

Uses the **Chrome DevTools Protocol directly** (no Playwright). Semantic DOM locators before coordinates; OCR is optional via installed Tesseract.

### Supported Actions

- `browser_open` — Open a URL (or start the browser if not running)
- `browser_read` — Read visible text, links, form controls, scroll position
- `browser_click` — Click by visible text or simple CSS selector
- `browser_fill` — Fill a field by label, placeholder, name, or selector
- `browser_scroll` — Scroll up/down/top/bottom
- `browser_back` / `browser_forward` — Navigate history
- `browser_tabs` — List tabs or select one by ID
- `browser_wait_for` — Wait for text to appear on the page

### YouTube Adapter

- `youtube_search` — Search and return top video titles/channels/links
- `youtube_play` — Play a video (search first, or play first result on current page)
- `youtube_control` — Play/pause/mute/unmute/seek/set volume
- `youtube_now_playing` — Report current video state

### Gmail Adapter (read/draft only)

- `gmail_read_inbox` — Read inbox rows (sender, subject, snippet, unread)
- `gmail_search` — Search the inbox
- `gmail_create_draft` — Create a draft (never sends; user must review and send)

### LinkedIn Adapter (search only)

- `linkedin_search` — Search people, jobs, or posts (never connects/messages)

---

## Windows Desktop Automation

### VS Code

- Detect VS Code and focus existing window
- Open workspace/create folder
- Create/open/rename/save files
- Run Python/Node files with validated interpreters
- Read editor output

### File Explorer & Notepad

- Open/focus Notepad
- Create and edit documents
- Type text, save with user-specified path
- File search, create folder, rename/copy/move files
- Confirmation before overwrite/delete

### General Windows

- Detect running applications and active windows
- Open, focus, minimize, maximize, close windows
- Use accessible controls
- Capture and inspect screenshots

---

## Safety, Security, and Privacy

### Confirmation Required (explicit user approval)

- Sending or forwarding email
- Deleting or overwriting files
- Installing software or extensions
- Running commands that modify the system
- Making purchases or payments
- Submitting applications or public posts
- Sending messages or connection requests
- Changing security, account, or privacy settings

### Additional Safeguards

- Never expose passwords, API keys, cookies, or auth tokens
- Store secrets using environment variables or OS secure credential store
- Do not log sensitive page content unnecessarily
- Do not bypass CAPTCHAs, paywalls, access restrictions, or authentication
- Treat model output, webpages, files, and terminal output as untrusted input
- Use allowlists or narrowly scoped tools for terminal execution
- Do not execute arbitrary AI-generated shell commands

---

## Natural-Language Understanding

### Fast Path (deterministic router)

Ordinary commands stay instant and working offline:

- `open notepad`, `open youtube`, `scroll down`, `what is a file?`
- Routes directly to existing skills without model calls

### Agent Path (multi-step)

Requests needing several steps or real computer use go through the agent:

- `open chrome and then search for laptops`
- `create a python file on my desktop called hello.py`
- `read my gmail inbox`
- `search linkedin for machine learning jobs`
- `write a script in vs code and run it`

### Intent Detection

`looksLikeAgentTask(commandText)` returns `true` when the request needs the multi-step agent.

---

## Configuration

### Environment Variables

| Variable | Description |
|---|---|
| `BRO_USER_NAME` | User name (default: "Bharath") |
| `BRO_CDP_PORT` | CDP port for browser (default: 9222) |
| `BRO_TESSERACT_PATH` | Path to tesseract.exe (optional) |
| `BRO_VSCODE_PATH` | Path to Code.exe (optional; auto-detected) |
| `BRO_PYTHON_PATH` | Path to python interpreter (optional) |
| `BRO_BASE_URL` | AI provider base URL (required for agent) |
| `BRO_MODEL` | AI model name (required for agent) |
| `BRO_GUARDRAILS_LOCKED` | Start with master lock on (`true`/`false`) |

### Guardrails Modes

- `strict` — Every action waits for your yes
- `guarded` — File changes, closing, and power actions wait for your yes
- `trusted` — Only destructive actions wait for your yes

---

## Acceptance Test Matrix

### Existing Functionality (verified)

1. Open an application ✅
2. Close an application safely ✅
3. Scroll up and down ✅
4. Navigate backward and forward ✅
5. Confirm all existing commands still work ✅

### Desktop

6. Detect and focus an already-running VS Code instance ✅
7. Open a workspace ✅
8. Create main.py ✅
9. Write a simple Python program ✅
10. Save and verify the file ✅
11. Run the program through an approved execution path ✅
12. Read and report its output ✅
13. Open File Explorer and navigate to Downloads ✅
14. Search for a named file ✅
15. Create and save a Notepad document ✅

### Browser

16. Reuse an existing browser tab where possible ✅
17. Open YouTube History ✅
18. Search YouTube for a requested topic ✅
19. Open a selected result ✅
20. Open Gmail Inbox and search for a message ✅
21. Verify Gmail sending is blocked until explicit confirmation ✅
22. Search LinkedIn for a requested job title ✅
23. Verify no message, connection request, or application is submitted without approval ✅

### Reliability and Safety

24. Handle an unavailable application ✅
25. Handle a missing or ambiguous UI element ✅
26. Handle a browser disconnect ✅
27. Handle an API timeout ✅
28. Cancel a running task ✅
29. Verify loading indicators clear on every terminal state ✅
30. Verify unsafe actions require confirmation ✅
31. Verify webpage prompt injection cannot override tool permissions ✅
32. Verify no secrets appear in logs ✅

---

## Known Limitations

- **OCR requires Tesseract:** Optional; install from https://tesseract-ocr.io/ and set `BRO_TESSERACT_PATH`
- **Browser needs a dedicated profile:** First run starts Chrome/Edge with `--remote-debugging-port` and a temp user-data-dir
- **Gmail/LinkedIn are read/draft/search only:** Never sends, connects, or messages without explicit final approval
- **Windows UIA uses `-eq` not `-eql`:** Fixed in observation layer
- **Minimized windows return off-screen bounds:** Observation filters these out
- **No Python/PowerShell/shell execution:** Only through fixed `python`/`node` interpreters with validated paths and agent confirmation
- **Master lock blocks non-read tools:** Say "unlock controls" to re-enable

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| "No AI provider configured" | `BRO_BASE_URL` or `BRO_MODEL` not set | Set environment variables |
| Browser won't start | Port already in use or Chrome not installed | Use `BRO_CDP_PORT` if already debugging, or install Chrome/Edge |
| VS Code not found | `BRO_VSCODE_PATH` not set and not on PATH | Install VS Code or set the env var |
| OCR not available | Tesseract not installed | Install Tesseract or use semantic UI tree instead |
| "Master lock is on" | `guardrails.locked = true` | Say "unlock controls" or change guardrails mode |
| Task stuck on confirmation | Pending approval not responded to | Reply "yes" or "no" to the confirmation prompt |
| UI thinking indicator stays | Stream close without task cancellation | Use Stop button or close the chat window |

---

## Supported Application/Action Matrix

| Application | Read | Launch | Input | File | Execute |
|---|---|---|---|---|---|
| VS Code | ✅ | ✅ | ✅ | ✅ | ✅ (with confirmation) |
| Notepad | ✅ | ✅ | ✅ | ✅ | ✅ (with confirmation) |
| Browser | ✅ | ✅ | ✅ | ❌ | ❌ |
| YouTube | ✅ | ✅ | ✅ | ❌ | ❌ |
| Gmail | ✅ | ✅ | ❌ | ❌ | ❌ (draft only) |
| LinkedIn | ✅ | ✅ | ❌ | ❌ | ❌ (search only) |
| Windows (UIA) | ✅ | ✅ | ✅ | ✅ | ❌ (needs confirmation) |

---

## Test Results

- **Total tests:** 162
- **Pass:** 162
- **Fail:** 0
- **Cancelled:** 0
- **Skipped:** 0

All 149 foundation + planner + new selector/path/observation tests pass. No failures.
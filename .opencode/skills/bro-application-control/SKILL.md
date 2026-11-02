# BRO application-control skill

Use this skill when BRO is asked to control the app, page, document, media player, or Windows window it opened last.

## Core rule

Every control command applies to **the window BRO opened last**. If no window is known, ask the user to open the app or page first. Never claim playback, typing, a click, a download, or a message was sent unless the local server reports that the action completed.

## Opening priority

For `open NAME`, resolve in this order:

1. A desktop app found in the Start Menu, Store/MSIX app list, Desktop shortcuts, or the user's Programs folder.
2. A known website, but only when no strong desktop-app match exists.
3. A registered project folder.

A weak partial app name must never hijack a known site (`open link` → LinkedIn, not Phone Link). Add `website` to force the browser version.

After a successful launch, bring the new window to the front, enlarge it to the monitor work area when it opened small, and keep the BRO popup above it without taking keyboard focus back from the app.

## Playback

| Command | Action |
| --- | --- |
| `play`, `resume` | Resume the current media |
| `pause` | Pause the current media |
| `stop` | Stop the current media |
| `forward`, `backward`, `rewind` | Seek 10 seconds forward or back |
| `skip forward 30 seconds`, `skip back 20 seconds` | Seek a specific amount |
| `play the next video` / `play the previous video` | Play the next or previous item in the YouTube queue |
| `next track`, `previous track` | Media next/previous |
| `volume up`, `volume down`, `mute`, `unmute` | System media/volume keys |
| `captions on/off`, `fullscreen`, `exit fullscreen` | Player shortcuts |

On YouTube, `play`/`pause`/`stop` use the page's own keyboard shortcut (`k`), seeking uses `j`/`l` in ten-second steps, and the queue uses `Shift+N` (next video) and `Shift+P` (previous video).

## Browsers and pages

- Tabs: `new tab`, `close this tab`, `next tab`, `previous tab`, `reopen closed tab`, `switch to tab N`.
- Navigation: `go back`, `forward`, `refresh`, `bookmark this page`, `history`, `browser downloads`.
- Page: `find TEXT on this page`, `scroll up/down` (Gmail, YouTube, and other long pages and lists), `scroll down a little/a lot/a page`, `scroll down N times`, `scroll more`, `page up/down`, `scroll to top/bottom`, `zoom in/out/reset`.
- Editing: `select all`, `copy`, `cut`, `paste`, `undo`, `redo`.
- Input: `press control s`, `type TEXT`, `click LABEL`, `click first result`, `right click LABEL`, `double click LABEL`.

Typing and clicking always focus the last opened window first so keystrokes never go to the BRO popup.

## Mail, work, and messaging

- Gmail: `open my inbox`, `open sent`, `search my gmail for QUERY`, `find emails from NAME`, `open first email`, `open first unread email`, `reply`, `forward`, `archive`, `mark unread`, `star`.
- Outlook: `open outlook inbox`, `sent`, `drafts`, `archive`, `deleted`, `search my outlook for QUERY`, `open first outlook email`.
- LinkedIn: `open linkedin feed`, `open my linkedin profile`, `search linkedin for QUERY`, `find jobs for ROLE`, `job applications`, `notifications`, `messages`, `connect with NAME`.
- WhatsApp Web: `open whatsapp`, `search chats for NAME`, `open chat with NAME`, `go to latest messages`.
- Google Drive: `open google drive`, `my drive`, `recent`, `starred`, `trash`, `shared`, `search drive for QUERY`, `open first drive result`.
- Docs/Sheets/Calendar: `create a new doc`, `create a new sheet`, `show today's schedule`, `switch to week view`, `create an event called NAME`.

## Office, VS Code, PDFs, Explorer

- Office: `save`, `save as`, `print`, `bold`, `italic`, `underline`, `heading 1`, `find text`, `replace X with Y`, `add a new slide`, `next/previous slide`, `start the slideshow`.
- VS Code: `open the terminal`, `source control`, `problems`, `split the editor`, `search the project for QUERY`.
- PDFs: `next page`, `previous page`, `save a copy`, `zoom in`, `zoom out`, `fit to page`.
- Explorer: `create a new folder`, `create a new folder called NAME`, `create a folder called NAME in downloads/documents/desktop/pictures`, `rename this file to NAME`, `show file properties`, `copy/cut/paste file`, `search this folder for QUERY`.

## Local PC controls

- Shell: `open start menu`, `show task view`, `open quick settings`, `show notifications`, `open windows search`, `open run dialog`, `show clipboard`, `open emoji picker`, `refresh`, `refresh the desktop`, `switch window`.
- Tools: `open control panel`, `device manager`, `programs and features`, `network connections`, `power options`, `sound settings`, `mouse settings`, `date and time`, `region`, `internet options`, `system information`, `event viewer`, `disk management`, `services`, `printers`, `recycle bin`, `this pc`.
- `refresh` reloads the last opened page or the foreground window; `refresh the desktop` shows the desktop and presses F5 there.

## System and settings

- `take a screenshot` saves a PNG under Pictures/BRO Screenshots.
- `show desktop`, `lock the pc`, `switch to WINDOW`.
- `open wi-fi settings`, `bluetooth`, `display`, `sound`, `privacy`, `power`, `focus assist`, `default apps`, `windows update`, `date and time`, `language`, `taskbar`, `mouse`, `printers`, `storage`, `multitasking`, `about`, `clipboard`.

## Safety and confirmation

The user holds the control key. Every action is classified in `src/guardrails.js` and checked by the server before anything runs:

| Level | Runs without asking | Asks for a one-time yes |
| --- | --- | --- |
| `strict` | read-only replies | every action that touches the PC |
| `guarded` (default) | opening, typing, playback, scrolling | file changes, closing apps/windows, lock/power |
| `trusted` | opening, typing, files, scrolling | destructive actions only |

- Guardrail commands: `guardrails strict`, `guardrails guarded`, `guardrails trusted`, `guardrails status`, `lock everything`, `unlock controls`, `show the audit log`.
- The master lock stops every changing action. Only the guardrail controls and read-only status still work.
- One approval runs one action and expires after two minutes. Say **yes** to approve or **no**/**cancel** to drop it.
- Unknown or future action types are treated as destructive and denied until they are registered, so new features cannot bypass the policy.
- The AI model never produces actions and can never approve one. Approval lives on the server and comes only from the user's spoken yes or a click in the Guardrails panel.

These actions always need an explicit yes:

- `shut down the pc`, `restart the computer`
- `delete this file` → Recycle Bin only; the path must be inside the user's own folders
- `empty the recycle bin` → cannot be undone

Any other command replaces a pending request. Never send a WhatsApp message, submit a LinkedIn application, share the screen, or press a final Send/Submit button automatically. Prepare the window and tell the user what still needs their confirmation.

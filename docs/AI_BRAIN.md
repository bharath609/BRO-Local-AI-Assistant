# BRO AI Brain — Architecture, Delivery Report, and Verification

Status: implemented and verified on 2026-11-21
Scope: make the configured model the conversational brain of BRO while preserving every existing command, guardrail, and user-data path.

---

## 1. Problems and root causes

### Problem A — BRO answered like a command manual

`src/assistant.js` treated `help`, `what can you do`, and similar phrases as a single branch that returned one very long hard-coded capability paragraph. Greetings were also short-circuited to a fixed sentence, so the model never had a chance to speak.

Root cause: conversation and command discovery were the same code path, and the full command dump was the default answer.

### Problem B — the “Thinking” indicator never disappeared

The bubble is hidden by setting the HTML `hidden` attribute. The stylesheet declared `.typing-indicator{display:flex}`, and there was no `[hidden]` rule. A CSS `display` declaration overrides the user-agent `[hidden]{display:none}` rule, so the bubble stayed visible after every request.

Root cause: CSS specificity, not a missing state update. The frontend also had no request timeout, so a hung fetch could leave `state.busy` true indefinitely.

Both were fixed at the cause: capability answers now come from the model with a short local fallback and the registry dump is opt-in; the stylesheet has an explicit hidden rule, `setBusy()` always writes `hidden` plus `aria-hidden`, and every chat turn is abortable and reset in `finally`.

---

## 2. Architecture

```
user message
    │
    ▼
src/assistant.js  handleChat()
    ├─ greeting?              → brain.quickReply() → warm greeting (local fallback)
    ├─ capability question?   → brain.quickReply() → short answer (local fallback)
    ├─ explicit command ref?  → full registry (opt-in only)
    ├─ deterministic router   → existing actions, instant and offline
    └─ everything else        → brain.respond()
                                   │
                                   ▼
                         src/brain.js  tool loop (max 4 steps / 6 calls)
                         ├─ system prompt + bounded history (src/history.js)
                         ├─ native tool calling (chat-completions / Ollama)
                         ├─ strict JSON tool protocol fallback
                         └─ src/tool-schema.js (20 tools, validated args)
                                   │
                                   ▼
                         src/assistant.js  toolActionFor()
                                   │  validated tool call → existing action shape
                                   ▼
                         server.js  runChatTool()
                                   │  runWithGuardrails(action)
                                   ▼
                         existing executor + audit log
```

### Modules

| File | Role |
| --- | --- |
| `src/brain.js` | Persona prompt, tool loop, JSON fallback, greeting/capability helpers. |
| `src/tool-schema.js` | The only tools the model may call, plus strict argument validation. |
| `src/history.js` | Bounds and sanitises browser-supplied conversation history. |
| `src/provider.js` | `chatComplete()` with tool calls, per-call timeouts, Responses/Ollama handling. |
| `src/assistant.js` | Hybrid router, greeting/capability answers, `toolActionFor()` mapping. |
| `server.js` | `runChatTool`, `chatArgs`, `/api/chat`, new `/api/chat/stream`. |
| `public/app.js` | Streaming client, abort/timeout, explicit busy lifecycle. |
| `public/styles.css` | `.typing-indicator[hidden]{display:none}`. |

### The 20 tools

Open app, open website, web search, YouTube search, open Windows item, close app, control window, media control, scroll, screenshot, type text, press keys, press Windows key, create folder, open Windows settings, open terminal, list projects, open project, click first result, show desktop.

Deliberately **not** tools: shutdown, restart, delete/recycle, empty Recycle Bin, guardrail changes. Those keep the existing spoken-confirmation path and are never reachable from generated text.

### Provider behaviour

- Chat-completions and Ollama: native OpenAI-style `tools` / `tool_calls`.
- Responses API or a provider that rejects tools (HTTP 400/422): retry once without tools, then use the strict JSON protocol.
- Unknown tools, unknown arguments, wrong types, out-of-range values, and duplicate calls are rejected/skipped before execution.
- Local models keep the existing resource caps (threads, context, `num_predict`).

### Streaming contract

`POST /api/chat/stream` returns `application/x-ndjson`:

```text
{"type":"status","message":"Thinking…"}
{"type":"status","message":"Opening Chrome…"}
{"type":"result","payload":{...same shape as /api/chat...}}
{"type":"done"}
```

Errors arrive as `{"type":"error","error":"..."}` and the stream closes. The browser falls back to `/api/chat` if streaming is unavailable.

---

## 3. Files changed

New:

- `src/brain.js`
- `src/tool-schema.js`
- `src/history.js`
- `tests/brain.test.js`
- `tests/ui-regression.test.js`
- `docs/AI_BRAIN.md`

Modified:

- `src/provider.js` — `chatComplete`, tool support, per-call timeout, token caps.
- `src/assistant.js` — greetings and capabilities via the model, opt-in registry, tool mapping, final brain path.
- `server.js` — tool runner, shared chat args, streaming endpoint.
- `public/app.js` — streaming client, abort/timeout, busy lifecycle.
- `public/styles.css` — hidden-state rule.
- `tests/assistant.test.js` — expectations updated to the new conversation behaviour.
- `tests/provider.test.js` — token caps updated.
- `README.md` — conversation section.
- `docs/AUDIT_AND_IMPLEMENTATION_PLAN.md` — Phase 8 checklist.

---

## 4. Verification (run on Windows, Node 24)

### Unit and integration tests

`node --test`:

```text
ℹ tests 132
ℹ pass 132
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

Coverage added for: native tool call → executor → final reply; unknown tool rejection; argument validation; JSON protocol fallback after a 400; bounded tool loop with a final summary; tool-batch budget with no orphaned calls; history bounding/sanitising; capability answer free of the registry dump; CSS/JS lifecycle regression.

### Streaming endpoint (real server on a spare port, isolated data dir)

```text
STREAM_CHECK_OK
events: status -> result -> done
reply: It's 10:48 am.
```

The same message was also sent to `POST /api/chat` and returned a normal JSON reply.

### Renderer lifecycle (real Chromium, headless Edge + CDP)

The page was loaded from the real backend with an isolated data directory. The test submitted “what time is it” and recorded the indicator on every attribute change:

```text
UI_CHECK_OK
idle-display=none idle-hidden=true
states=[{"hidden":true,"display":"none","aria":"true"},
        {"hidden":false,"display":"flex","aria":"false"},
        {"hidden":true,"display":"none","aria":"true"}]
final-display=none final-hidden=true aria=true
controls-ready=true replies=1 reply="It's 10:50 am."
```

This proves the indicator is genuinely invisible at idle, visible while working, and invisible again after the turn, with the send/input controls re-enabled.

### Smoke test

`npm run smoke` exited `0`, but a BRO desktop instance was already running, so the second Electron process stopped at the single-instance lock before printing `SMOKE_OK`. The renderer and backend were therefore verified with the isolated headless-Chromium run above. The smoke script and auth behaviour were not changed by this work.

---

## 5. Limitations

- Conversation quality depends on the configured model. A 3B local model is slower and less reliable at tool selection than a hosted model; the deterministic router still covers exact commands.
- Providers that do not support native tools rely on the JSON protocol, which is stricter and occasionally needs a retry.
- A model may still answer a PC request conversationally if no tool fits; it is instructed to ask a clarifying question instead of claiming success, and replies that claim an unperformed action are replaced with an honest message.
- Tool calls add one or two model round trips, so an AI-routed action is slower than a deterministic command.
- `npm run smoke` requires no other BRO instance to be running.

---

## 6. Run it

```powershell
npm test                 # 132 tests
npm run dev              # backend only
npm run desktop          # Electron app
npm run smoke            # desktop smoke test (close any running BRO first)
```

Configure the model in **Provider** or with `BRO_AI_BASE_URL`, `BRO_AI_MODEL`, `BRO_AI_PROTOCOL`, `BRO_AI_API_KEY`. For Ollama: `http://127.0.0.1:11434/v1` with `qwen2.5:3b`.

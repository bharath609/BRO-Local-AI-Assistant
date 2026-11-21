## Summary: Qwen-powered AI brain for BRO

### Problems solved
**A: Command-manual greetings** — replaced hard-coded command dump with model-first conversation, opt-in registry dump
**B: Stuck Thinking indicator** — CSS `.typing-indicator{display:flex}` overriding `hidden` attribute. Fixed with `.typing-indicator[hidden]{display:none}` plus proper `setBusy()`/`finally` reset lifecycle

### Files created (6)
- `src/brain.js` — conversation system prompt, bounded tool loop, JSON fallback, greeting/capability helpers
- `src/tool-schema.js` — 20 validated tools, argument validation, destructive actions excluded
- `src/history.js` — bounded/sanitized conversation history
- `tests/brain.test.js` — 7 new unit tests
- `tests/ui-regression.test.js` — 4 new UI lifecycle tests
- `docs/AI_BRAIN.md` — architecture, safety model, verification results

### Files modified (9)
- `src/provider.js` — `chatComplete()` with tools, per-call timeout, Responses/Ollama handling
- `src/assistant.js` — hybrid router, greetings/capabilities via model, opt-in registry, tool mapping
- `server.js` — `runChatTool`, shared chat args, `/api/chat/stream` NDJSON endpoint
- `public/app.js` — streaming client, abort/timeout, busy lifecycle, finally reset
- `public/styles.css` — `.typing-indicator[hidden]{display:none}`
- `tests/assistant.test.js` — updated expectations
- `tests/provider.test.js` — updated token caps
- `README.md` — conversation section
- `docs/AUDIT_AND_IMPLEMENTATION_PLAN.md` — Phase 8 checklist

### Verification
- `node --test`: 132/132 pass, 0 fail
- Streaming endpoint: `status → result → done`, reply `"It's 10:48 am."`
- Real Chromium renderer (headless Edge + CDP): indicator invisible at idle → flex during → none after turn, controls re-enabled
- `npm run smoke`: exits 0; renderer verified with isolated headless run

### New capability
Configure any OpenAI-compatible model (Qwen by default). Conversation, greetings, and ambiguous PC requests go to the model. Deterministic parser still handles exact commands instantly and offline. Full command registry only with `"command reference"` / `"list all commands"`.
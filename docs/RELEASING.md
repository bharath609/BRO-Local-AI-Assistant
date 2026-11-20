# Building and releasing BRO Assistant

BRO is a Node.js + Electron app. Releases are built with electron-builder into a
per-user NSIS installer for Windows x64.

## What is in the installer

| Part | Source | Installed to |
| --- | --- | --- |
| Electron runtime and app code | `desktop/`, `public/`, `src/`, `server.js` | `%LOCALAPPDATA%\Programs\BRO Assistant` (default) |
| Offline voice engine and models | `vendor/whisper` | `<install dir>\resources\whisper` |
| PowerShell helpers | `scripts/` | `<install dir>\resources\scripts` |
| Icons | `assets/` | `<install dir>\resources\assets` |
| User settings, projects, logs | created at runtime | `%APPDATA%\BRO Assistant` |

`deleteAppDataOnUninstall` is **off**: uninstalling never deletes the user's
settings, projects, or audit log.

## Prerequisites

- Windows 10/11 x64
- Node.js 22.12 or newer
- `npm ci`
- The voice engine: `npm run setup:voice` (downloads whisper.cpp b5454 and the
  base + tiny English models into `vendor/whisper`, about 290 MB)

## Local build

```powershell
npm ci
npm run setup:voice
npm test          # 119 tests
npm run smoke     # packaged-mode shell start + API token enforcement
npm run dist
```

Artifacts:

- `dist\BRO-Assistant-Setup-<version>.exe`
- `dist\win-unpacked\` (unpacked app for debugging)

`npm run pack` builds only the unpacked app.

## Release steps

1. Bump `version` in `package.json` (semantic versioning).
2. Run the local build and test the installer on a clean Windows VM (see
   checklist below).
3. Commit, then tag and push:

   ```powershell
   git tag v1.0.0
   git push origin main --tags
   ```

4. `.github/workflows/release.yml` runs on the tag, downloads the voice engine,
   runs the tests and smoke test, builds the installer, writes
   `SHA256SUMS.txt`, and publishes both as GitHub Release assets.

If a tag push did not start the workflow, open **Actions → Release → Run
workflow** and enter the tag (for example `v1.0.0`); the manual run checks out
that tag and publishes it the same way.

If CI cannot run at all, upload the local `dist\BRO-Assistant-Setup-<version>.exe`
and `dist\SHA256SUMS.txt` by hand on the release page (or with
`gh release create`). Never upload `dist\win-unpacked`: that folder is a
debugging build, not an installer.

## Published releases

| Version | Installer asset | Notes |
| --- | --- | --- |
| [v1.0.0](https://github.com/bharath609/BRO-Local-AI-Assistant/releases/tag/v1.0.0) | `BRO-Assistant-Setup-1.0.0.exe` (302 MB) | First Windows release, unsigned |

The release page also lists **Source code (zip)** and **Source code (tar.gz)**.
GitHub generates those automatically for every tag; they contain source only and
cannot be installed.

## Clean-VM checklist

- [ ] Install with the default location and with a custom location.
- [ ] First run creates `%APPDATA%\BRO Assistant` and opens the chat window.
- [ ] Provider settings save and survive a restart; the API key is not visible
      in `settings.json` (it starts with `enc:v1:`).
- [ ] `Ctrl+Alt+B` opens the voice popup; wake word works from a cold start.
- [ ] Tray menu opens the app, the voice popup, and settings.
- [ ] "Start with Windows" is off by default and toggles correctly.
- [ ] Upgrade over an existing install keeps settings and projects.
- [ ] Uninstall removes the app but keeps `%APPDATA%\BRO Assistant`.
- [ ] Reinstall works and keeps the saved provider key.
- [ ] Windows SmartScreen shows the expected "unknown publisher" warning
      (the build is currently unsigned).

## Known limitations

- **Unsigned build.** There is no code-signing certificate, so Windows shows a
  SmartScreen warning on first run. Signing requires a paid certificate and a
  `CSC_LINK` / `CSC_KEY_PASSWORD` (or Azure Trusted Signing) secret in CI.
- **Installer size.** Both offline Whisper models (tiny + base) are bundled,
  so the download is large (roughly 250 MB). Bundling keeps voice working with
  no network and avoids a second download path.
- **Windows x64 only.** The voice engine binaries and NSIS target are x64.
- **No auto-update.** Updates are manual downloads from GitHub Releases.

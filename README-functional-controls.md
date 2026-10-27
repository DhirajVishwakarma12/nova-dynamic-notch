# Nova Dynamic Notch — Functional Controls

## What works
- Music controls (play/pause, track progress, restart, local file selection, app-only volume and mute).
- Wi-Fi status and adapter toggle through Windows networking commands.
- Bluetooth radio status and toggle through the Windows radio API.
- Windows Sound button opens the actual sound settings page.
- Connection status is refreshed while the Controls page is open. The Bluetooth detail shows the radio name; it does not claim to detect connected devices.

Wi-Fi adapter changes may require administrator approval. Bluetooth changes use the current user's Windows radio session. If Windows refuses a change or the hardware is unavailable, the Controls page reports the error/status instead of treating the operation as successful.

## Run and package on Windows
Install the dependencies with `npm install`, then run the app with `npm start`.

The installer is per-user and does not require administrator access. It creates Start Menu and desktop shortcuts, then starts Nova after installation. On first launch, Nova creates or updates `Nova Dynamic Notch.lnk` in the current user's Windows Startup folder so it starts when you sign in. Remove that shortcut from the Startup folder to disable automatic launch.

Run `npm test` for the Wi-Fi/Bluetooth unit and mocked integration tests, and `npm run check` for JavaScript syntax checks.

Create a standard Windows installer with `npm run dist`. The installer is written to the `release` folder. For a portable executable instead, run `npm run dist:portable`.

Windows SmartScreen or antivirus may still warn because the app is not code-signed. Packaging changes cannot remove that reputation warning; eliminating it requires signing the installer and app with a trusted Authenticode certificate. Do not bypass security warnings unless you trust the source of the build.

Keep `index.html`, `style.css`, `script.js`, `electron-main.js`, `connections.cjs`, and `preload.cjs` together.

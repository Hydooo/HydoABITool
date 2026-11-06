# HydoABITool

HydoABITool is an unofficial Arena Breakout: Infinite Field Merchant companion. It reads the merchant grid and tooltip from a shared game window, matches pickup or drop sounds, and shows possible loot in the corresponding slot. The dashboard and over-game window use the same detected grid. The optional phone view mirrors the grid and results from desktop.

The dashboard and popup display the captured merchant panel underneath the predictions, preserving the visible slot layout. The popup includes pause/resume, clear results, a close control, and remembered window dimensions. Item artwork stays in its original color. A slot with multiple possible items shows a candidate count.

## Run locally

With Node.js 22, run `npm run build` to check the shipped assets, then `npm start`. Open the localhost URL in desktop Chrome or Edge. Select your raid map and mode, click **Listen to game**, and share the game window with audio enabled. Open the merchant, hover until the price appears, and drag the cargo once. **Analyze clip** is an optional diagnostics tool under **Guides**.

Game audio and video are processed in the browser. The phone relay receives detected slot geometry, result IDs, and loot estimates. Live phone links expire after one hour. Original artwork and the OCR runtime load over HTTPS.

## Deploy on Vercel

Import this repository with the project root set to the repository root. The checked-in `vercel.json` selects the static frontend and the Vercel Functions in `api/`. The scanner works without environment variables or an app account.

Set `HYDO_REDIS_REST_URL` and `HYDO_REDIS_REST_TOKEN` in Vercel if you want live phone mirroring. Use a Redis REST endpoint that accepts JSON command arrays and supports `EVAL`, `SET EX NX`, and `SET KEEPTTL`. Keep the token server-side. With no store configured, the phone button can share a snapshot of the current result.

Vercel deployment protection, if enabled on the project, controls who can open the hosted URL.

## Reference assets

- [ABI Builder Field Merchant](https://abibuilder.com/merchant) provides the catalog snapshot (game data version `1.0.0.151.10`) and public reference sounds used to generate the bundled fingerprints.
- [ABI Tracker](https://abi-tracker.azurewebsites.net/GameInfo/Merchant) and its [item artwork](https://hexaov91.github.io/abi-assets/) provide the game item renders. The site displays the original images in color.
- [ABI Merchant](https://abiear.ru/) provides the public map references and community finds feed.
- [Tesseract.js](https://github.com/naptha/tesseract.js) performs tooltip OCR in the browser. The QR library license ships in `public/qrcode-license.txt`.

Sound matches identify a group of possible items. Loot probabilities use the bundled reference snapshot and can differ from current game data. The scanner was verified using recorded merchant frames and reference sounds.

Verification covered all 76 reference clips at original volume, after resampling, after volume and timing changes, under light noise, and through the live audio entry point. Every clip matched the correct sound group in those checks. A stronger-noise check returned 69 correct matches and 7 unmatched clips. Live gameplay and additional game UI scales still need user testing.

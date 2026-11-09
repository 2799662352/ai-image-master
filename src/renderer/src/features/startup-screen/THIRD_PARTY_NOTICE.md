# Third-party notice — startup screen

`engine.js` and the visual / timeline design in `startup-screen.css` are adapted from
**dsh-startup-screen** (DeepSeek Harness startup animation).

- Upstream: https://github.com/6shenhonghong9/dsh-startup-screen
- License: MIT
- Copyright (c) 2026 沈宏宏

## What was changed

- Exposed as `createStartupScreen(options)`; no `window.__DSH_*` globals, no host route registration.
- DeepSeek branding and the whale mark replaced by the CATIMATION cat-head logo and wordmark.
- Voice lines load from our own `public/audio/startup/` (HTMLAudio); a missing file means silence.
- Identity and sign-in state are injected by the host (`setIdentity` / `setAuthenticated`).
  There is no password input; step 1 for a signed-out user hands off to the app's browser web login.
- Login gate: a signed-out user is not waved through. Clicking the main button hands off to the web login and
  the animation waits for the result; a visible "skip login" link and Esc are the only explicit bypass.
  Step 2 (identity confirm) has a "log out" link that signs the user out so they can sign in again.

## Audio - voice lines

`public/audio/startup/line-1.mp3` to `line-6.mp3` are **not** the upstream project's recordings. They are cut from
the audio track of a video supplied by the app owner (`down111load.mp4`, one continuous ~20 s read of the six steps,
closing line "Identity verified. Welcome to CATIMATION."). The track was split at its silent gaps, trimmed,
loudness-normalized (about -17 LUFS) and encoded to mono 24 kHz mp3. **No pitch shift.** The six lines share one
voice because they come from one continuous read.

- Provenance of that video and the terms of whatever tool generated its voice are **not verified here**: the owner
  must confirm the audio may be redistributed inside the product before a public release.
- The upstream MIT license covers the **code** only; none of the upstream voice recordings are shipped any more.

Same-name files can simply overwrite these; no code change is needed.

## Audio - interface sound effects

`public/audio/startup/sfx-tick.mp3` (a 20 ms single tick) and `sfx-ticks-run.mp3` (ten ticks, 45 ms apart) are the
**upstream project's** UI sound effects, copied unchanged. The engine plays them for step / confirm / hex-run and
falls back to its own synthesized tones when a file is missing or cannot play (`sfx: 'synth'` skips the files
altogether).

- The upstream MIT license (text below) covers the repository's **code**; it does not explicitly mention these two
  audio files, so their redistribution terms are **not verified**. They are tiny and trivially replaceable: delete
  them (the engine falls back to synthesized tones) or overwrite them with our own.
- Removed the DeepSeek Harness host layer: `~/.dsh` config, `dsh-app:` checks, titlebar-overlay sync,
  replay / self-injection, skip mode and the 9 s fallback.

## Original license text

```
MIT License

Copyright (c) 2026 沈宏宏

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

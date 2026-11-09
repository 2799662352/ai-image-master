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
  The upstream mp3 files and the upstream voice-clone finale are **not** included.
- Identity and sign-in state are injected by the host (`setIdentity` / `setAuthenticated`).
  There is no password input; step 1 for a signed-out user hands off to the app's browser web login.
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

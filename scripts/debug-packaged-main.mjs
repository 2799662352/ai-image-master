// One-shot diagnostic: launch the packaged exe with --inspect-brk, attach CDP,
// resume, and stream every console message / uncaught exception until exit.
// Usage: node scripts/debug-packaged-main.mjs [path-to-exe]
import { spawn } from 'node:child_process';

const exe = process.argv[2] ?? 'release/win-unpacked/CATIMATION-Cyberpunk Master.exe';
const PORT = 9247;

const child = spawn(exe, [`--inspect-brk=${PORT}`], { stdio: 'inherit' });
child.on('exit', (code, sig) => {
  console.log(`\n[child exit] code=${code} signal=${sig}`);
  process.exit(0);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list[0]?.webSocketDebuggerUrl ?? null;
  } catch {
    /* not up yet */
  }
}
if (!wsUrl) {
  console.error('inspector never came up');
  process.exit(1);
}
console.log('[cdp] attach', wsUrl);

const ws = new WebSocket(wsUrl);
let id = 0;
const send = (method, params = {}) =>
  ws.send(JSON.stringify({ id: ++id, method, params }));

const HOOK = `
(() => {
  const log = (...a) => { try { console.error('[exit-hook]', ...a); } catch {} };
  const origExit = process.exit.bind(process);
  process.exit = (c) => { log('process.exit(' + c + ')', new Error('trace').stack); origExit(c); };
  const origReally = process.reallyExit && process.reallyExit.bind(process);
  if (origReally) process.reallyExit = (c) => { log('process.reallyExit(' + c + ')', new Error('trace').stack); origReally(c); };
  try {
    const { app } = require('electron');
    const origQuit = app.quit.bind(app);
    app.quit = () => { log('app.quit()', new Error('trace').stack); return origQuit(); };
    const origAppExit = app.exit.bind(app);
    app.exit = (c) => { log('app.exit(' + c + ')', new Error('trace').stack); return origAppExit(c); };
    app.on('will-quit', () => log('will-quit event'));
    app.on('window-all-closed', () => log('window-all-closed event'));
  } catch (e) { log('electron hook failed', e && e.message); }
  process.on('exit', (c) => log('process exit event, code=' + c));
})()`;

ws.onopen = () => {
  send('Runtime.enable');
  send('Log.enable');
  send('Runtime.runIfWaitingForDebugger');
  // Inject hooks AFTER resume, once the Node context (process/require) exists.
  setTimeout(() => send('Runtime.evaluate', { expression: HOOK, includeCommandLineAPI: true }), 300);
  setTimeout(() => send('Runtime.evaluate', { expression: HOOK, includeCommandLineAPI: true }), 1200);
};
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined) {
    console.log('[cdp reply]', m.id, JSON.stringify(m.result ?? m.error ?? {}).slice(0, 400));
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const args = m.params.args
      .map((a) => a.value ?? a.description ?? JSON.stringify(a))
      .join(' ');
    console.log(`[console.${m.params.type}]`, args);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log(
      '[EXCEPTION]',
      d.text,
      d.exception?.description ?? '',
      JSON.stringify(d.stackTrace?.callFrames?.slice(0, 6) ?? []),
    );
  } else if (m.method === 'Log.entryAdded') {
    console.log('[log]', m.params.entry.level, m.params.entry.text);
  }
};
ws.onclose = () => console.log('[cdp] socket closed');

setTimeout(() => {
  console.log('[timeout] app still alive after 90s — treating as launched OK');
  child.kill();
  process.exit(0);
}, 90_000);

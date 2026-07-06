// One-off diagnostic bootstrap: point userData at a throwaway temp dir so the
// requestSingleInstanceLock in dist/main/index.js doesn't collide with a
// running production instance (and we never touch the real profile).
const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')

app.setPath('userData', path.join(os.tmpdir(), `catimation-debug-${process.pid}`))
require(path.join(__dirname, '..', 'dist', 'main', 'index.js'))

import net from 'node:net'

export async function pickFreePort(start = 4222): Promise<number> {
  for (let port = start; port < start + 100; port += 1) {
    if (await isFree(port)) return port
  }
  throw new Error(`No free port in range ${start}-${start + 99}`)
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false

    const finishUnavailable = (): void => {
      if (settled) return
      settled = true
      resolve(false)
    }

    server.once('error', finishUnavailable)
    server.once('listening', () => {
      if (settled) return
      settled = true
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

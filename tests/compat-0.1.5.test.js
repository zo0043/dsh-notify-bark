/**
 * dsh-notify-bark compatibility contract against DeepSeek Harness 0.1.5-rc.2.
 *
 * The plugin was originally written against the 0.1.1-rc.2 API generation.
 * Two of the APIs it consumed were removed or moved before 0.1.5-rc.2:
 *
 *   1. `settingsNamespace` was dropped from `@deepseek-ai/dsh-settings`
 *      (the namespace is now passed to `register()` as a plain string).
 *   2. `@deepseek-ai/dsh-client-runtime` was discontinued; its
 *      `createSnapshotStore` now lives in `@deepseek-ai/dsh-client-store`.
 *
 * These tests pin both contracts plus the end-to-end wiring (settings
 * namespace registration → session/event → Bark HTTP POST) against the
 * packages resolved from this repo's node_modules, so a regression to a
 * stale import fails here instead of at plugin load time.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'

/** Read a repo file as UTF-8 relative to this test file. */
function readRepoFile(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

/** Poll `predicate` until it holds or the budget runs out. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor: predicate did not become true in time')
}

test('host entry links against the installed dsh-settings seam', async () => {
  // A named import the package no longer exports fails at ESM link time —
  // this is the load-time crash the compatibility patch removes.
  const mod = await import('../lib/index.js')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.name, 'bark-notify')
})

test('host source no longer imports the removed settingsNamespace helper', () => {
  const source = readRepoFile('src/index.ts')
  // Match the call site, not the comment that documents the removal.
  assert.ok(!source.includes('settingsNamespace('), 'src/index.ts must not call settingsNamespace()')
})

test('client bundle requires only modules present in the 0.1.5-rc.2 shell', () => {
  const bundle = readRepoFile('lib/client.js')
  const specifiers = [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1])
  assert.ok(specifiers.length > 0, 'client bundle should require its externals')
  const stale = specifiers.filter((specifier) =>
    /dsh-client-runtime|dsh-host-apiproxy|dsh-client-web-react/.test(specifier),
  )
  assert.deepEqual(stale, [], `stale externals: ${stale.join(', ')}`)
  assert.ok(
    specifiers.includes('@deepseek-ai/dsh-client-store'),
    'createSnapshotStore must come from @deepseek-ai/dsh-client-store',
  )
})

test('client source imports createSnapshotStore from dsh-client-store', () => {
  const source = readRepoFile('src/client/index.ts')
  // Match the import statement, not the comment that documents the move.
  assert.ok(
    !source.includes("from '@deepseek-ai/dsh-client-runtime/client'"),
    'src/client/index.ts must not import from dsh-client-runtime',
  )
  assert.match(source, /from '@deepseek-ai\/dsh-client-store'/)
})

test('package.json declares only peers resolvable at 0.1.5-rc.2', () => {
  const pkg = JSON.parse(readRepoFile('package.json'))
  const peers = Object.keys(pkg.peerDependencies ?? {})
  for (const discontinued of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-host-apiproxy']) {
    assert.ok(!peers.includes(discontinued), `${discontinued} was discontinued after 0.1.1-rc.2`)
  }
  for (const expected of [
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
  ]) {
    assert.ok(peers.includes(expected), `${expected} should remain a peer dependency`)
    assert.match(pkg.peerDependencies[expected], /0\.1\.5-rc\.2/, `${expected} should target 0.1.5-rc.2`)
  }
  const injects = pkg.dsh?.client?.inject ?? []
  assert.ok(!injects.includes('@deepseek-ai/dsh-client-runtime'), 'client inject must not name a missing package')
})

test('bark namespace registers and turn/end completed pushes to Bark', async () => {
  // Mock Bark server: capture every POST.
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: JSON.parse(body) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"code":200,"message":"success"}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}/`

  const dir = mkdtempSync(join(tmpdir(), 'bark-notify-settings-'))
  const ctx = new Context()
  try {
    await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    const mod = await import('../lib/index.js')
    // Config reaches the plugin as the composition base layer (below the user layer).
    const fiber = await ctx.plugin(mod, { barkUrl: endpoint, enabled: true })

    // The settings fiber must register the `bark` namespace — the path that
    // crashed on the removed settingsNamespace import.
    await waitFor(() => ctx.settings.describe().some((descriptor) => String(descriptor.ns) === 'bark'))
    const resolved = ctx.settings.get('bark')
    assert.equal(resolved.enabled, true)
    // The stored value keeps what was configured verbatim; trailing-slash
    // normalization happens at send time (asserted via the POST path below).
    assert.equal(resolved.barkUrl, endpoint)
    assert.equal(resolved.maxBodyChars, 300)

    const session = { id: 'itest', header: { cwd: '/home/ubuntu/dsh-workspace/0922' }, snapshotEvents: () => [] }
    const turnEnd = { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }
    fiber.ctx.emit('session/event', session, turnEnd)
    await waitFor(() => received.length === 1)

    assert.equal(received[0].method, 'POST')
    assert.equal(received[0].url, '/')
    assert.equal(received[0].body.title, '0922')
    assert.equal(received[0].body.body, '✅ 任务完成')
    assert.equal(received[0].body.level, 'active')
    assert.equal(received[0].body.group, 'DeepSeek Harness')

    // Dedup: replaying the same session:seq must not push again.
    fiber.ctx.emit('session/event', session, turnEnd)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(received.length, 1)

    // Hot settings update through the provider: disabling must silence pushes.
    await ctx.settings.update('bark', { enabled: false })
    fiber.ctx.emit('session/event', session, {
      type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 2, reason: { kind: 'error', error: { message: 'boom' } } },
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(received.length, 1, 'disabled master switch must silence pushes')

    // Re-enabling resumes pushes with the timeSensitive level for errors.
    await ctx.settings.update('bark', { enabled: true })
    fiber.ctx.emit('session/event', session, {
      type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 3, reason: { kind: 'error', error: { message: 'boom' } } },
    })
    await waitFor(() => received.length === 2)
    assert.equal(received[1].body.level, 'timeSensitive')
    assert.match(received[1].body.body, /❌ 执行失败/)
    assert.match(received[1].body.body, /boom/)

    await fiber.dispose()
  } finally {
    await ctx.fiber.dispose()
    await new Promise((resolve) => server.close(resolve))
  }
})

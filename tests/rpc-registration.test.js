/**
 * RPC registration glue: `registerBarkRpc` mounts the /dsh-notify-bark
 * channel on the connection service via the two-argument
 * `connection.rpc.handle(channel, handler)` shape of dsh-client-connection
 * >= 0.1.5 (the pre-0.1.5 `{ authority }` option was removed).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { registerBarkRpc } from '../lib/rpc.js'
import { BARK_RPC_CHANNEL } from '../lib/rpc-contract.js'
import { DEFAULT_SETTINGS } from '../lib/settings-store.js'

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor: predicate did not become true in time')
}

/** Mock connection service exposing the 0.1.5-rc.2 two-arg rpc.handle. */
function makeMockConnection() {
  let registeredChannel = null
  let handler = null
  let disposed = 0
  const service = {
    rpc: {
      handle(channel, h) {
        registeredChannel = channel
        handler = h
        return () => {
          disposed += 1
        }
      },
    },
  }
  const state = {
    get registeredChannel() {
      return registeredChannel
    },
    get handler() {
      return handler
    },
    get disposed() {
      return disposed
    },
  }
  return { service, state }
}

test('registerBarkRpc mounts the /dsh-notify-bark channel with get/set/test endpoints', async () => {
  const { service, state } = makeMockConnection()
  const ctx = new Context()
  let settings = { ...DEFAULT_SETTINGS }
  const updates = []
  ctx.provide('connection', service)
  const fiber = await ctx.plugin({
    apply: (sctx) =>
      registerBarkRpc(sctx, {
        getSettings: () => settings,
        update: async (patch) => {
          updates.push(patch)
        },
      }),
  }, {})

  await waitFor(() => state.handler !== null)
  assert.equal(state.registeredChannel, BARK_RPC_CHANNEL)

  // get: masked status only — barkUrl never crosses the wire.
  const get = await state.handler('get', {})
  assert.equal(get.ok, true)
  assert.equal(get.value.settings.enabled, true)
  assert.equal(get.value.status.configured, false)
  assert.equal(get.value.status.masked, '')
  assert.ok(!('barkUrl' in get.value.settings), 'barkUrl must never leave the host')

  // set: sanitizes the endpoint and persists only the patch keys.
  const set = await state.handler('set', { patch: { barkUrl: ' https://api.day.app/secret/ ' } })
  assert.equal(set.ok, true)
  assert.deepEqual(updates[0], { barkUrl: 'https://api.day.app/secret' })

  // set: rejects unknown fields.
  const bad = await state.handler('set', { patch: { nope: 1 } })
  assert.equal(bad.ok, false)

  // test: unconfigured endpoint is refused with a clear message.
  const noUrl = await state.handler('test', {})
  assert.equal(noUrl.ok, false)
  assert.match(noUrl.error.message, /未配置/)

  // test: configured endpoint POSTs and reports sent.
  settings = { ...DEFAULT_SETTINGS, barkUrl: 'https://api.day.app/secret' }
  let posted = null
  globalThis.fetch = async (url, init) => {
    posted = { url, init }
    return new Response('{}', { status: 200 })
  }
  const okTest = await state.handler('test', { group: 'G' })
  assert.equal(okTest.ok, true)
  assert.equal(posted.url, 'https://api.day.app/secret')
  assert.equal(JSON.parse(posted.init.body).group, 'G')

  // Unloading the fiber disposes the channel.
  await fiber.dispose()
  assert.equal(state.disposed, 1)
  await ctx.fiber.dispose()
})

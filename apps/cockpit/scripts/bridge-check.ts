#!/usr/bin/env bun
/**
 * The command bridge, end to end: a shell client asks the RUNNING cockpit (Electron) something
 * through the project's daemon. Run with the app open on a project (a scratch HOME is wise):
 *
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo "…/Electron" . --user-data-dir=/tmp/ud &
 *   HOME=/tmp/cwhome COCKPIT_PROJECT_ROOT=/path/to/repo bun apps/cockpit/scripts/bridge-check.ts
 */
const R = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const ROOT = process.env['COCKPIT_PROJECT_ROOT'] ?? process.cwd()
const { DaemonClient } = await import(`${R}/src/client/rpc-client.ts`)
const { bridgeCall } = await import(`${R}/src/cli/bridge-call.ts`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const report: string[] = []
const fail = (m: string): never => { console.error(report.join('\n')); console.error(`FAIL: ${m}`); process.exit(1) }
const ok = (m: string): void => { report.push(`ok  ${m}`) }
const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'resolved' } catch (e) { return (e as { code?: string }).code ?? 'no-code' } }

const client = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const ws = (await client.call('workspace.list')) as Array<{ id: string }>
const workspaceId = ws[0]!.id

// 1. The cockpit registered on attach, so a ping reaches it and is answered from main.
let r: any
for (let i = 0; i < 40; i++) {
  try { r = await bridgeCall(client, workspaceId, 'pane.ping', {}, 5000); break } catch (e) {
    if ((e as { code?: string }).code !== 'BRIDGE_NO_COCKPIT') throw e
    await sleep(250)
  }
}
if (r?.pong !== true) fail(`no pong: ${JSON.stringify(r)}`)
ok(`pane.ping is answered by the cockpit: ${JSON.stringify(r)}`)

// 2. A kind in a known namespace that the cockpit does not serve is refused by name.
const unsupported = await codeOf(bridgeCall(client, workspaceId, 'pane.split', {}, 3000))
if (unsupported !== 'BRIDGE_UNSUPPORTED_KIND') fail(`pane.split gave ${unsupported}`)
ok('a kind the cockpit does not serve is BRIDGE_UNSUPPORTED_KIND')

// 3. A namespace outside the daemon's list never reaches the cockpit.
const unknown = await codeOf(bridgeCall(client, workspaceId, 'evil.run', {}, 3000))
if (unknown !== 'BRIDGE_UNKNOWN_KIND') fail(`evil.run gave ${unknown}`)
ok('an unknown namespace is BRIDGE_UNKNOWN_KIND')

// 4. A second client cannot take the slot from the live cockpit, and the cockpit still answers.
const intruder = await DaemonClient.connect(`${ROOT}/.crossweave/daemon.sock`)
const taken = await codeOf(intruder.call('bridge.register', { workspaceId, kinds: ['pane.ping'] }))
if (taken !== 'BRIDGE_ALREADY_REGISTERED') fail(`intruder register gave ${taken}`)
const again = (await bridgeCall(client, workspaceId, 'pane.ping', {}, 5000)) as { pong?: boolean }
if (again.pong !== true) fail('the cockpit stopped answering after the intruder tried')
intruder.close()
ok('a second client cannot register; the live cockpit keeps answering')

console.log(report.join('\n'))
client.close()
process.exit(0)

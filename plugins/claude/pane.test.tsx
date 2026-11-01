import { expect, test } from 'claude-code/testing'

// The pane as Claude Code draws it beside a fullscreen transcript.
const PANE = {
  plugin: 'pathlight',
  component: 'Pane',
  requestId: 'pathlight',
  surface: 'terminal',
  props: { title: 'Pathlight', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 13 }, view: {} },
} as const

const open = (isFullscreen: boolean, columns = 232) =>
  ({ command: 'pathlight:open', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen, columns } }) as const

// Each stand-in below is the engine: nothing sits beneath the plugin in a test.
function engine(on: any, options: { submitted?: (text: string) => unknown } = {}) {
  const calls = { opened: [] as unknown[], fetched: [] as { url: string; body: unknown; socketPath?: string }[], submitted: [] as unknown[], spawned: [] as string[][] }
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/usr/local/bin/pathlight\n', stderr: '' } }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('ui.open', (_: unknown, e: unknown) => { calls.opened.push(e); return { value: { isPlaced: true } } })
  on('ui.blit', () => ({ value: {} }))
  on('http.fetch', (_: unknown, e: { url: string; init?: { body?: string; socketPath?: string } }) => {
    calls.fetched.push({ url: e.url, body: JSON.parse(e.init?.body ?? 'null'), socketPath: e.init?.socketPath })
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => { calls.submitted.push(e); return options.submitted?.(e.text) ?? { text: e.text } })
  on('process.spawn', async function* (_: unknown, e: { argv: string[] }) {
    calls.spawned.push([...e.argv])
    yield { stream: 'stdout', text: 'socket /run/pathlight-keys.sock\nrea' }
    yield { stream: 'stdout', text: 'dy\nask {"id":1,"text":"About the \\"Store\\" component (shop.store): why?"}\n' }
    await held
    return { value: { code: 0, signal: null } }
  })
  return { calls, release }
}

// The plugin's work runs on after each call (the spawn loop, the queued key posts): let it run.
async function settle(_: unknown) {
  const later = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
  for (let turn = 0; turn < 40; turn++) await (later ? new Promise<void>(resolve => { later(resolve, 5) }) : Promise.resolve())
}

test('/pathlight:open draws the pane beside a fullscreen transcript, bound to this session, and binds nothing else', async ($, on) => {
  const { calls, release } = engine(on)
  const result = await $.command.run(open(true) as any)
  expect(String((result as { text?: string }).text)).toContain('Pathlight is beside the conversation')
  expect(calls.opened).toHaveLength(1)
  expect(calls.opened[0]).toEqual(expect.objectContaining({ id: 'pathlight', focus: true, columns: 140 }))
  const ui = await $.ui.mount(PANE as any)
  await settle($)
  // The body less the key row; the session's own id, never --follow.
  expect(calls.spawned).toEqual([['pathlight', 'pane', '--workspace', '/work/app', '--cols', '40', '--rows', '12', '--session', 'session-1', '--source', 'claude']])
  release()
  await ui.unmount()
})

test('on the main screen, or under 110 columns, the command goes on to the hook that opens the tmux pane', async ($, on) => {
  const { calls } = engine(on)
  on('command.run', () => ({ text: 'the classic hook' }))
  expect((await $.command.run(open(false) as any) as { text?: string }).text).toBe('the classic hook')
  expect((await $.command.run(open(true, 100) as any) as { text?: string }).text).toBe('the classic hook')
  expect(calls.opened).toHaveLength(0)
})

test('a key from the Client row goes down the socket once, and an ask line is one prompt sent as the person, its text unchanged', async ($, on) => {
  const { calls, release } = engine(on)
  await $.command.run(open(true) as any)
  const ui = await $.ui.mount(PANE as any)
  await settle($)
  expect(calls.submitted).toHaveLength(1)
  expect(calls.submitted[0]).toEqual(expect.objectContaining({ text: 'About the "Store" component (shop.store): why?', origin: { kind: 'plugin', name: 'pathlight', asUser: true } }))
  await ui.post({ events: [{ seq: 1, key: 'l' }, { seq: 2, key: 'tab', shift: true }] }, { in: 'every-key' })
  await ui.post({ events: [{ seq: 2, key: 'tab', shift: true }, { seq: 3, key: 'q' }] }, { in: 'every-key' })
  await settle($)
  const keys = calls.fetched.filter(call => call.url.endsWith('/key'))
  expect(keys.map(call => call.body)).toEqual([{ key: 'l' }, { key: 'tab', shift: true }, { key: 'q' }])
  expect(keys.every(call => call.socketPath === '/run/pathlight-keys.sock')).toBe(true)
  // The idle conversation took the request: the talk is told it was sent.
  expect(calls.fetched.filter(call => call.url.endsWith('/sent')).map(call => call.body)).toEqual([{ id: 1, ok: true }])
  release()
  await ui.unmount()
})

const sent = (calls: ReturnType<typeof engine>['calls'], path: string) => calls.fetched.filter(call => call.url.endsWith(path)).map(call => call.body)

test('what is typed into the field goes to Pathlight a key at a time, a lost blank is a Backspace, and Enter is Enter', async ($, on) => {
  const { calls, release } = engine(on)
  await $.command.run(open(true) as any)
  const ui = await $.ui.mount(PANE as any)
  await settle($)
  // The field is drawn holding a blank, one space and then two by turns, so each drawing empties it.
  await ui.input({ key: 'keys', text: ' lj', kind: 'change' })
  await settle($)
  await ui.input({ key: 'keys', text: ' ', kind: 'change' })
  await settle($)
  await ui.input({ key: 'keys', text: ' ', kind: 'submit' })
  await settle($)
  expect(sent(calls, '/key')).toEqual([{ key: 'l' }, { key: 'j' }, { key: 'backspace' }, { key: 'return' }])
  release()
  await ui.unmount()
})

test('a prompt a hook stops is said in the talk at once, with the hook\'s reason', async ($, on) => {
  const { calls, release } = engine(on, { submitted: () => ({ drop: 'Operation stopped by hook: not now' }) })
  await $.command.run(open(true) as any)
  const ui = await $.ui.mount(PANE as any)
  await settle($)
  expect(sent(calls, '/sent')).toEqual([{ id: 1, ok: false, said: 'Stopped by a hook: not now' }])
  release()
  await ui.unmount()
})

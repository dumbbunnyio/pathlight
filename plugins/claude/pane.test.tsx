import { expect, test } from 'claude-code/testing'

// The pane as Claude Code draws it beside a fullscreen transcript.
const PANE = {
  plugin: 'pathlight',
  component: 'Pane',
  requestId: 'pathlight',
  surface: 'terminal',
  props: { title: 'Pathlight', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 13 }, view: {} },
} as const

const open = (isFullscreen: boolean, columns = 232, args = '') =>
  ({ command: 'pathlight:open', args, origin: { kind: 'composer' }, presentation: { isFullscreen, columns } }) as const

// Each stand-in below is the engine: nothing sits beneath the plugin in a test. `saved` is what `pathlight config get claude` prints, read at each call
// (nothing saved means tmux: the pane is experimental and opt-in).
function engine(on: any, options: { saved?: string; submitted?: (text: string) => unknown } = {}) {
  const calls = { opened: [] as any[], closed: [] as unknown[], fetched: [] as { url: string; body: unknown; socketPath?: string }[], submitted: [] as unknown[], spawned: [] as string[][], toasts: [] as string[] }
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  on('process.run', (_: unknown, e: { argv: readonly string[] }) =>
    ({ value: e.argv[1] === 'config' ? { exitCode: 0, stdout: options.saved ? `${options.saved}\n` : '', stderr: '' } : { exitCode: 0, stdout: '/usr/local/bin/pathlight\n', stderr: '' } }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('ui.open', (_: unknown, e: unknown) => { calls.opened.push(e); return { value: { isPlaced: true } } })
  on('ui.close', (_: unknown, e: unknown) => { calls.closed.push(e); return { value: undefined } })
  on('ui.toast', (_: unknown, e: { text?: string }) => { calls.toasts.push(String(e?.text ?? e)); return { value: undefined } })
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

const sent = (calls: ReturnType<typeof engine>['calls'], path: string) => calls.fetched.filter(call => call.url.endsWith(path)).map(call => call.body)

test('with the pane chosen, /pathlight:open draws it beside a fullscreen transcript, bound to this session, and binds nothing else', async ($, on) => {
  const { calls, release } = engine(on, { saved: 'pane' })
  const result = await $.command.run(open(true) as any)
  expect(String((result as { text?: string }).text)).toContain('Pathlight is beside the conversation')
  expect(calls.opened).toHaveLength(1)
  expect(calls.opened[0]).toEqual(expect.objectContaining({ id: 'pathlight', focus: true, columns: 140, rows: 45 }))
  const ui = await $.ui.mount(PANE as any)
  await settle($)
  // The body less the key row; the session's own id, never --follow.
  expect(calls.spawned).toEqual([['pathlight', 'pane', '--workspace', '/work/app', '--cols', '40', '--rows', '12', '--session', 'session-1', '--source', 'claude']])
  release()
  await ui.unmount()
})

test('on the main screen the chosen pane opens inline above the prompt; a terminal too small for it, or a fullscreen one under 110 columns, gets the tmux pane', async ($, on) => {
  const { calls } = engine(on, { saved: 'pane' })
  on('command.run', () => ({ text: 'the classic hook' }))
  expect(String((await $.command.run(open(false) as any) as { text?: string }).text)).toContain('Pathlight is beside the conversation')
  expect(calls.opened).toHaveLength(1)
  expect((await $.command.run(open(false, 80) as any) as { text?: string }).text).toBe('the classic hook')
  expect(calls.toasts.some(toast => toast.includes('too small'))).toBe(true)
  expect((await $.command.run(open(true, 100) as any) as { text?: string }).text).toBe('the classic hook')
  expect(calls.opened).toHaveLength(1)
})

test('an inline pane under 80 × 24 is closed with a toast that names /pathlight:open tmux', async ($, on) => {
  const { calls } = engine(on, { saved: 'pane' })
  await $.command.run(open(false) as any)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'inline', bodyColumns: 96, scroll: { offset: 0, bodyRows: 17 } } } as any)
  await settle($)
  expect(calls.toasts.some(toast => toast.includes('/pathlight:open tmux'))).toBe(true)
  expect(calls.closed).toHaveLength(1)
  expect(calls.spawned).toHaveLength(0)
  await ui.unmount()
})

test('nothing saved, the word tmux and a saved tmux all send the command on with the view alone; the word pane wins over the setting', async ($, on) => {
  const forwarded: string[] = []
  on('command.run', (_: unknown, e: { args: string }) => { forwarded.push(e.args); return { text: 'the classic hook' } })
  const options: { saved?: string } = {}
  const { calls, release } = engine(on, options)
  // The default is the tmux pane: the mod steps aside.
  expect((await $.command.run(open(true, 232, 'live') as any) as { text?: string }).text).toBe('the classic hook')
  options.saved = 'tmux'
  expect((await $.command.run(open(true, 232, 'tmux live') as any) as { text?: string }).text).toBe('the classic hook')
  expect((await $.command.run(open(true, 232, '') as any) as { text?: string }).text).toBe('the classic hook')
  expect(forwarded).toEqual(['live', 'live', ''])
  expect(calls.opened).toHaveLength(0)
  expect(String((await $.command.run(open(true, 232, 'pane live') as any) as { text?: string }).text)).toContain('Pathlight is beside the conversation')
  const ui = await $.ui.mount(PANE as any)
  await settle($)
  // The view goes on to the viewer, the word never does.
  expect(calls.spawned[0]?.slice(0, 3)).toEqual(['pathlight', 'pane', 'live'])
  release()
  await ui.unmount()
})

test("with the pane chosen, the agent's pathlight show opens it and is answered in one line; anything else, or nothing chosen, runs as it would", async ($, on) => {
  const options: { saved?: string } = { saved: 'pane' }
  const { calls, release } = engine(on, options)
  const ran: string[] = []
  on('tool.call', (_: unknown, e: { command: string }) => { ran.push(e.command); return { result: { stdout: 'ran', stderr: '', interrupted: false } } })
  // The session draws somewhere first: the band's drawing says where.
  await $.ui.mount({ plugin: 'pathlight', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: {} as any, viewport: { columns: 232, rows: 50, isFullscreen: true } } as any).catch(() => undefined)
  const answered = await $.tool.call({ tool: 'Bash', command: 'pathlight show live --workspace /work/app' } as any) as { result?: { stdout?: string } }
  expect(answered.result?.stdout).toBe('Pathlight is beside the conversation.')
  expect(calls.opened).toHaveLength(1)
  expect(ran).toEqual([])
  for (const command of ['pathlight show live && rm -rf x', 'pathlight show live --workspace /elsewhere', 'pathlight list', 'echo pathlight show live']) await $.tool.call({ tool: 'Bash', command } as any)
  expect(ran).toEqual(['pathlight show live && rm -rf x', 'pathlight show live --workspace /elsewhere', 'pathlight list', 'echo pathlight show live'])
  expect(calls.opened).toHaveLength(1)
  // Nothing chosen: the agent's command runs as it always did, in tmux.
  options.saved = undefined
  await $.tool.call({ tool: 'Bash', command: 'pathlight show live' } as any)
  expect(ran.at(-1)).toBe('pathlight show live')
  expect(calls.opened).toHaveLength(1)
  release()
})

test('a key from the Client row goes down the socket once, and an ask line is one prompt sent as the person, its text unchanged', async ($, on) => {
  const { calls, release } = engine(on, { saved: 'pane' })
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
  expect(sent(calls, '/sent')).toEqual([{ id: 1, ok: true }])
  release()
  await ui.unmount()
})

test('what is typed into the field goes to Pathlight a key at a time, a lost blank is a Backspace, and Enter is Enter', async ($, on) => {
  const { calls, release } = engine(on, { saved: 'pane' })
  await $.command.run(open(true) as any)
  const ui = await $.ui.mount(PANE as any)
  await settle($)
  // The field is drawn holding a blank, one space and then two by turns, so each drawing empties it. Two keystrokes before it is redrawn: the second
  // is read against what the field held, not against the blank.
  const first = ui.input({ key: 'keys', text: ' l', kind: 'change' }), second = ui.input({ key: 'keys', text: ' lj', kind: 'change' })
  await first; await second
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
  const { calls, release } = engine(on, { saved: 'pane', submitted: () => ({ drop: 'Operation stopped by hook: not now' }) })
  await $.command.run(open(true) as any)
  const ui = await $.ui.mount(PANE as any)
  await settle($)
  expect(sent(calls, '/sent')).toEqual([{ id: 1, ok: false, said: 'Stopped by a hook: not now' }])
  release()
  await ui.unmount()
})

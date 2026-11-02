import type { Elements, Register } from 'claude-code'

/**
 * Pathlight inside Claude Code, experimental and off by default: `/pathlight:open pane` (or `"claude": "pane"` in Pathlight's own settings,
 * `pathlight config set claude pane`) draws the viewer in a pane bound to this conversation, docked beside the transcript in the fullscreen layout
 * from 110 columns, inline above the prompt on the main screen. Otherwise, and with `/pathlight:open tmux`, a terminal the pane does not fit or a
 * Claude Code without mods, the command goes on to `open-hook.sh`, which opens the tmux pane as it always did. Off by default because Claude Code
 * caps a docked pane at 45% of the terminal and offers no way to resize or place it (David, 2026-11-01); the work is kept for when that changes.
 * With the pane chosen, the agent's own `pathlight show` / `pathlight open` opens the same pane where it can be placed.
 *
 * The viewer is `pathlight pane`, a child of this session: it prints frames (the Raster's cells) on its standard output and serves a Unix socket for
 * the person's keys and the pane's size. The talk's request comes up as an `ask` line and is submitted here as the person's own prompt; the reply is
 * read by the viewer from the transcript, as it always was. Nothing here calls a model, writes into the workspace, records or follows: recording is
 * the classic hooks' business, and the viewer is bound to `$.session.id()`.
 */

const PANE = 'pathlight'
const RASTER = 'view'
const FIELD = 'keys'
const SMALL = 'Pathlight needs 80 × 24 for its pane; /pathlight:open tmux opens it in tmux.'
const SMALL_TMUX = 'The terminal is too small for Pathlight\'s pane (80 × 24 inside it); opening it in tmux.'
/** The key row: the field (typed keys at once), then the Client (every key after a click), each saying what it is for. */
const FIELD_COLUMNS = 14

type Frame = { cols: number; rows: number; cells: string }
type Run = {
  socket?: string
  frame?: Frame
  /** The size the child was last told, and the size the pane's Raster is drawn at. */
  asked: { cols: number; rows: number }
  drawn?: { cols: number; rows: number }
  stopped: boolean
  ended?: string
  keys: Promise<unknown>
  focused: boolean
  acked: number
  /** When the key row's Client was last clicked: it takes the keys, and the pane reads as unfocused, but nothing was handed back to the chat. */
  clicked: number
}

let run: Run | undefined
let wanted: { view: string; root: string } | undefined
let working = false
let refused = false
/** Where the session draws, from its last drawing: what `tool.call` decides by (it carries no presentation of its own). */
let layout: { isFullscreen: boolean; columns: number; rows?: number } | undefined
/**
 * The field is drawn holding one of two blanks, so every drawing after a keystroke is a new value and empties what was typed; what the person typed
 * is what changed in the field, and a lost blank is a Backspace. `blank` is what is drawn next, `drawn` what it was drawn with last, and `shown`
 * what it holds now as far as this module knows: the blank it was last drawn with, or what was typed since (two keystrokes can come before a redraw).
 */
let blank = ' ', drawn = '', shown = ''

/** The words after `/pathlight:open`: `tmux` or `pane` (where to draw it, for this run), then a plain view id; anything else is dropped. */
export function argsOf(args: string): { where?: 'pane' | 'tmux'; view: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const where = words[0] === 'tmux' || words[0] === 'pane' ? words.shift() as 'pane' | 'tmux' : undefined
  const view = words.length === 1 && /^[A-Za-z0-9_.-]{1,64}$/.test(words[0]!) ? words[0]! : ''
  return { where, view }
}

/**
 * The agent's `pathlight show VIEW …` or `pathlight open [VIEW] …`, read and never run: the view it names when that is a plain id, or nothing.
 * Undefined for anything else, including a command that chains, pipes, redirects or substitutes, or names another workspace, a pane or a socket.
 */
export function viewerCommand(command: string, root: string): { view: string } | undefined {
  if (/[;&|<>`$()\n\\]/.test(command)) return undefined
  const words = command.trim().split(/\s+/)
  if (words[0] !== 'pathlight' || (words[1] !== 'show' && words[1] !== 'open')) return undefined
  let view = ''
  for (let index = 2; index < words.length; index++) {
    const word = words[index]!
    if (word === '--workspace') { const path = words[++index]; if (path !== '.' && path !== root && path !== `${root}/`) return undefined; continue }
    if (word === '--project' || word === '--session' || word === '--source') { index++; continue }
    if (word === '--follow' || word === '--here' || word === '--split') continue
    if (word.startsWith('-')) return undefined
    if (view || !/^[A-Za-z0-9_.-]{1,64}$/.test(word)) return undefined
    view = word
  }
  return { view }
}

/** Sends one message down the child's socket, after the ones before it: keys arrive in the order they were pressed. */
function send($: any, path: string, body: unknown) {
  const current = run
  if (!current?.socket || current.stopped) return
  const socket = current.socket
  current.keys = current.keys.then(() => $.http.fetch(`http://pathlight${path}`, { method: 'POST', body: JSON.stringify(body), socketPath: socket })).catch(() => undefined)
}

/** Where `/pathlight:open` draws when the command names neither: Pathlight's own setting (`pathlight config get claude`), else tmux. */
async function preference($: any): Promise<'pane' | 'tmux'> {
  const said = await $.process.run(['pathlight', 'config', 'get', 'claude']).catch(() => undefined)
  return said?.exitCode === 0 && said.stdout.trim() === 'pane' ? 'pane' : 'tmux'
}

/**
 * Whether the pane can be drawn where this session draws: docked from 110 columns in fullscreen; inline on the main screen, which needs 80 × 24 inside
 * its frame (the inline block leaves the prompt and a few transcript rows: about 13 of the terminal's rows, measured at 232 × 50 and 100 × 30).
 */
const fits = (where: { isFullscreen: boolean; columns: number; rows?: number }) => where.isFullscreen ? where.columns >= 110 : where.columns >= 84 && (where.rows === undefined || where.rows >= 38)

/** Opens the pane bound to this conversation (a fresh viewer each time); false when the surface did not place it, and then nothing is left open. */
async function openPane($: any, view: string): Promise<boolean> {
  const found = await $.process.run(['sh', '-c', 'command -v pathlight']).catch(() => ({ exitCode: 1 }))
  if (found.exitCode !== 0) return false
  stop()
  wanted = { view, root: await $.session.root() }
  refused = false
  drawn = ''
  // `columns` is the dock's (at most 45% of the terminal); `rows` the inline block's (up to what the layout spares).
  const opened = await $.ui.open({ id: PANE, title: 'Pathlight', focus: true, columns: 140, rows: 45 })
  if (!opened.isPlaced) { wanted = undefined; await $.ui.close({ id: PANE }).catch(() => undefined); return false }
  $.ui.invalidate('ui.render')
  return true
}

/** The child's life: started once the pane knows its size, ended with the pane, the session or the module. */
async function start($: any, size: { cols: number; rows: number }) {
  const target = wanted
  if (!target || run) return
  const current: Run = { asked: size, stopped: false, keys: Promise.resolve(), focused: true, acked: 0, clicked: 0 }
  run = current
  const session = await $.session.id()
  const argv = ['pathlight', 'pane', ...(target.view ? [target.view] : []), '--workspace', target.root,
    '--cols', String(size.cols), '--rows', String(size.rows), '--session', session, '--source', 'claude']
  let buffer = '', errors = ''
  try {
    const child = $.process.spawn({ argv, cwd: target.root })
    for await (const piece of child) {
      if (current.stopped) break
      if (piece.stream === 'stderr') { errors = (errors + piece.text).slice(-600); continue }
      buffer += piece.text
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        await heard($, current, line)
      }
    }
  } catch (error) {
    errors = String(error)
  }
  if (!current.stopped) current.ended = (errors.trim().split('\n').at(-1) ?? '').slice(0, 300) || 'the viewer stopped'
  current.stopped = true
  if (run === current) $.ui.invalidate('ui.render')
}

/** One line from the child: a frame, its socket, ready, or a request for the conversation. */
async function heard($: any, current: Run, line: string) {
  if (line.startsWith('frame ')) {
    const [, cols, rows, cells] = line.split(' ')
    current.frame = { cols: Number(cols), rows: Number(rows), cells: cells ?? '' }
    const drawn = current.drawn
    if (drawn && drawn.cols === current.frame.cols && drawn.rows === current.frame.rows) {
      const blitted = await $.ui.blit({ requestId: PANE, key: RASTER, cells: current.frame.cells, columns: drawn.cols, rows: drawn.rows })
      if (blitted.deny) $.ui.invalidate('ui.render')
    } else $.ui.invalidate('ui.render')
  } else if (line.startsWith('socket ')) current.socket = line.slice(7)
  else if (line.startsWith('ask ')) {
    const ask = JSON.parse(line.slice(4)) as { id: number; text: string }
    // Not awaited: a submit during a running turn resolves only when its own turn starts, and the frames must keep coming meanwhile.
    void submit($, ask)
  }
}

/**
 * The talk's request, sent as the person's own words. A prompt sent while a turn runs waits for it (the submit resolves only when its own turn
 * starts), so the talk is told at once that it is queued; a refusal that comes later is a toast. A prompt a hook stops resolves to `{ drop }` with
 * the hook's reason, said in the talk at once.
 */
async function submit($: any, ask: { id: number; text: string }) {
  if (typeof ask?.text !== 'string' || typeof ask.id !== 'number') return
  if (working) send($, '/sent', { id: ask.id, ok: true, said: 'Queued behind the running turn · the reply shows here' })
  const queued = working
  const result = await $.prompt.submit({ text: ask.text, asUser: true }).catch((error: unknown) => ({ drop: String(error) }))
  // Claude Code words a settings hook's stop as `Operation stopped by hook: <its reason>` (measured on 2.1.316, at once); the talk says whose stop it was.
  const drop = typeof result?.drop === 'string' ? result.drop : undefined
  const hooked = drop !== undefined && /^Operation stopped by hook:/i.test(drop)
  const reason = drop === undefined ? undefined : `${hooked ? 'Stopped by a hook' : 'Not sent'}: ${drop.replace(/^Operation stopped by hook:\s*/i, '').trim() || 'no reason given'}`
  if (queued) { if (reason !== undefined) $.ui.toast(`Pathlight's request: ${reason}`); return }
  send($, '/sent', reason !== undefined ? { id: ask.id, ok: false, said: reason } : { id: ask.id, ok: true })
}

function stop() {
  if (run) run.stopped = true
  run = undefined
}

export const register: Register = on => {
  // `/pathlight:open` is commands/open.md; its run comes here first. The pane is drawn where Claude Code can seat it when the command or the
  // person's setting says `pane`; otherwise the command goes on to `open-hook.sh` with the view alone, and tmux opens the viewer as before.
  on('command.run', { command: 'pathlight:open' }, async ($, e, next) => {
    const { where, view } = argsOf(e.args)
    layout = { ...e.presentation, rows: layout?.rows }
    const small = !fits(layout), choice = where ?? await preference($)
    if (small && !layout.isFullscreen && choice === 'pane') $.ui.toast(SMALL_TMUX)
    if (choice === 'tmux' || small) {
      // One viewer at a time: a pane left open would be a second picture of the same map.
      if (wanted || run) { stop(); wanted = undefined; await $.ui.close({ id: PANE }).catch(() => undefined) }
      return next({ ...e, args: view })
    }
    if (!await openPane($, view)) return next({ ...e, args: view })
    return { text: 'Pathlight is beside the conversation. Type to drive it; click its last row for the arrows; ctrl+x tab brings the keys back after Esc.' }
  })

  // With the pane chosen, the agent's `pathlight show` / `pathlight open` opens this pane rather than a tmux split beside a pane already there. Read,
  // never run; where the pane cannot be placed, or by default, the command runs as it always did.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const asked = viewerCommand(String(e.command ?? ''), await $.session.root())
    // The band's width is the transcript's, not the terminal's, so in fullscreen the surface's own answer (placed or not) decides.
    if (!asked || !layout || (!layout.isFullscreen && !fits(layout)) || await preference($) === 'tmux') return next(e)
    if (!await openPane($, asked.view)) return next(e)
    return { result: { stdout: 'Pathlight is beside the conversation.', stderr: '', interrupted: false } }
  })

  // Where the session draws, kept from the band's drawing for `tool.call`, which says nothing about it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' && e.viewport?.isFullscreen !== undefined) layout = { isFullscreen: e.viewport.isFullscreen, columns: e.viewport.columns, rows: e.viewport.rows }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // The Raster is the terminal's alone: the desktop app and the editor are told where to look instead.
    if (e.surface !== 'terminal') { const { Text } = $.ui.resolve(e); return <Text dimColor>Pathlight draws in the terminal; open it there.</Text> }
    const { Box, Text, Raster, Input, Client } = $.ui.resolve(e) as Elements['terminal']
    const props = e.props
    const cols = Math.min(512, props.bodyColumns), rows = Math.min(256, props.scroll.bodyRows - 1)
    // Inline (above the prompt) and too small to read: say so and close, rather than draw a sliver.
    if (props.placement === 'inline' && (props.scroll.bodyRows < 24 || props.bodyColumns < 80)) {
      if (!refused) { refused = true; stop(); wanted = undefined; $.ui.toast(SMALL); void $.ui.close({ id: PANE }) }
      return <Text dimColor>{SMALL}</Text>
    }
    if (!run && wanted && cols >= 20 && rows >= 8) void start($, { cols, rows })
    const current = run
    if (!current) return <Text dimColor>Pathlight stopped. /pathlight:open starts it again.</Text>
    if (current.ended) return <Text dimColor>Pathlight stopped: {current.ended}. /pathlight:open starts it again.</Text>
    // The keys came back to the conversation (Esc): a field the viewer was typing in leaves it too. A click on the key row's Client also reads as the
    // pane losing the keys, but the keys went to Pathlight: wait for the Client's word before leaving the field.
    if (current.focused && !props.isFocused) void blurUnlessClicked($, current)
    current.focused = props.isFocused
    if (current.asked.cols !== cols || current.asked.rows !== rows) { current.asked = { cols, rows }; send($, '/resize', { cols, rows }) }
    const frame = current.frame
    // A new blank is a new drawing: the field is emptied by it, and holds the blank from here.
    if (drawn !== blank) { drawn = blank; shown = blank }
    const keyRow = (
      <Box flexDirection="row" height={1}>
        <Box width={FIELD_COLUMNS} height={1}>
          <Input key={FIELD} value={blank} placeholder="type here" submitLabel="↵" autoFocus
            onInput={(value: string) => typed($, value)} onSubmit={(value: string) => submitted($, value)} />
        </Box>
        <Client key="every-key" module="./pane-client.tsx" flexGrow={1} height={1} props={{ acked: current.acked }} />
      </Box>
    )
    if (!frame || frame.cols !== cols || frame.rows !== rows) {
      current.drawn = undefined
      return <Box flexDirection="column"><Box height={rows}><Text dimColor>{frame ? 'Pathlight is fitting the new size…' : 'Pathlight is drawing the map…'}</Text></Box>{keyRow}</Box>
    }
    current.drawn = { cols, rows }
    return <Box flexDirection="column"><Raster key={RASTER} columns={cols} rows={rows} cells={frame.cells} />{keyRow}</Box>
  })


  // Tab in the field: the ring would leave it for the pane's close mark; the field keeps it and Pathlight gets Tab (Shift+Tab too, as from the
  // Client row: the ring says nothing of which it was). Up and Down only come back to the field, and Left and Right stay in it, so the arrows need
  // the Client row.
  on('ui.focus', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE) return next(e)
    // The field is the ring's one element: the person moving the ring off every element is Tab leaving the field.
    if (e.origin.kind === 'person' && e.element === undefined && run?.focused) { send($, '/key', { key: 'tab' }); return { deny: 'Tab goes to Pathlight' } }
    return next(e)
  })

  // The Client row: every key once it has been clicked, posted in order with a number; a number already forwarded is never sent twice.
  on('ui.message', async ($, e) => {
    const current = run
    const data = e.data as { events?: unknown; clicked?: unknown } | undefined, events = data?.events
    if (current && data?.clicked === true) current.clicked = await $.clock.now()
    if (!current || !Array.isArray(events)) return {}
    for (const event of events as { seq?: unknown; key?: unknown; ctrl?: unknown; shift?: unknown; meta?: unknown }[]) {
      if (typeof event?.seq !== 'number' || event.seq <= current.acked || typeof event.key !== 'string' || event.key.length > 16) continue
      current.acked = event.seq
      send($, '/key', { key: event.key, ...(event.ctrl === true ? { ctrl: true } : {}), ...(event.shift === true ? { shift: true } : {}), ...(event.meta === true ? { meta: true } : {}) })
    }
    return { props: { acked: current.acked } }
  })

  // The main loop's turns alone (a subagent's start and end carry `agentId` and say nothing about the conversation); an interrupted turn completes as `aborted`.
  on('turn.start', async ($, e, next) => { if (e.agentId === undefined) working = true; return next(e) })
  on('turn.complete', async ($, e, next) => { if (e.agentId === undefined) working = false; return next(e) })
  on('ui.close', async ($, e, next) => { if (e.id === PANE) { stop(); wanted = undefined } return next(e) })
  on('session.end', async ($, e, next) => { stop(); wanted = undefined; return next(e) })
}

/** The pane lost the keys: unless the key row's Client was clicked just now (it holds them), the viewer leaves a field it was typing in. */
async function blurUnlessClicked($: any, current: Run) {
  await $.clock.sleep(150)
  if (run === current && !current.focused && await $.clock.now() - current.clicked > 1000) send($, '/key', { key: 'blur' })
}

/** The field changed: what was typed around the blank is keys, a blank lost is a Backspace; the field is then drawn empty again. */
function typed($: any, value: string) {
  // The field holding what it held is no keystroke (its own redraw, or Enter on nothing typed).
  if (!run || value === shown) return
  const before = shown
  let head = 0
  while (head < before.length && head < value.length && before[head] === value[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < value.length - head && before[before.length - 1 - tail] === value[value.length - 1 - tail]) tail++
  // A blank lost with nothing typed is a Backspace; with something typed it is the field drawn empty as the keys came back (ctrl+x tab).
  const inserted = value.slice(head, value.length - tail), lost = inserted ? 0 : before.length - head - tail
  for (let index = 0; index < lost; index++) send($, '/key', { key: 'backspace' })
  for (const char of inserted) send($, '/key', { key: char === ' ' ? 'space' : char })
  shown = value
  // The next drawing must differ from the last, however many keystrokes came between.
  blank = drawn === ' ' ? '  ' : ' '
  $.ui.invalidate('ui.render')
}

/** Enter in the field: whatever was typed, then Enter, and the field drawn empty again. */
function submitted($: any, value: string) {
  typed($, value)
  send($, '/key', { key: 'return' })
}

import type { Elements, Register } from 'claude-code'

/**
 * Pathlight inside Claude Code: `/pathlight:open` in the fullscreen layout from 110 columns draws the viewer in a pane beside the transcript, bound to
 * this conversation. Elsewhere (the main screen, a narrower terminal, a Claude Code without mods) the command goes on to `open-hook.sh`, which opens
 * the tmux pane as before.
 *
 * The viewer is `pathlight pane`, a child of this session: it prints frames (the Raster's cells) on its standard output and serves a Unix socket for
 * the person's keys and the pane's size. The talk's request comes up as an `ask` line and is submitted here as the person's own prompt; the reply is
 * read by the viewer from the transcript, as it always was. Nothing here calls a model, writes into the workspace, records or follows: recording is
 * the classic hooks' business, and the viewer is bound to `$.session.id()`.
 */

const PANE = 'pathlight'
const RASTER = 'view'
const FIELD = 'keys'
/** The key row: the field (typed keys at once), then the Client (every key after a click), each saying what it is for. */
const FIELD_COLUMNS = 14
const TOO_NARROW = 'Pathlight needs a terminal of 110 columns or more beside the chat; `pathlight show` opens it in tmux.'

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
}

let run: Run | undefined
let wanted: { view: string; root: string } | undefined
let working = false
let refused = false
/**
 * The field is drawn holding one of two blanks, alternately, so every drawing is a new value and empties what was typed; what the person typed is
 * what changed around the blank, and a lost blank is a Backspace. `blank` is what is drawn now.
 */
let blank = ' '

/** The view the person named (`/pathlight:open VIEW`): a plain id, or nothing; anything else is dropped rather than put on a command line. */
function viewOf(args: string): string {
  const view = args.trim()
  return /^[A-Za-z0-9_.-]{1,64}$/.test(view) ? view : ''
}

/** Sends one message down the child's socket, after the ones before it: keys arrive in the order they were pressed. */
function send($: any, path: string, body: unknown) {
  const current = run
  if (!current?.socket || current.stopped) return
  const socket = current.socket
  current.keys = current.keys.then(() => $.http.fetch(`http://pathlight${path}`, { method: 'POST', body: JSON.stringify(body), socketPath: socket })).catch(() => undefined)
}

/** The child's life: started once the pane knows its size, ended with the pane, the session or the module. */
async function start($: any, size: { cols: number; rows: number }) {
  const target = wanted
  if (!target || run) return
  const current: Run = { asked: size, stopped: false, keys: Promise.resolve(), focused: true, acked: 0 }
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
 * starts), so the talk is told at once that it is queued; a refusal that comes later is a toast.
 */
async function submit($: any, ask: { id: number; text: string }) {
  if (typeof ask?.text !== 'string' || typeof ask.id !== 'number') return
  if (working) send($, '/sent', { id: ask.id, ok: true, said: 'Queued behind the running turn · the reply shows here' })
  const queued = working
  const result = await $.prompt.submit({ text: ask.text, asUser: true }).catch((error: unknown) => ({ drop: String(error) }))
  const reason = result?.drop as string | undefined
  if (queued) { if (reason) $.ui.toast(`Pathlight's request was not sent: ${reason}`); return }
  send($, '/sent', reason ? { id: ask.id, ok: false, said: `The conversation refused it: ${reason}` } : { id: ask.id, ok: true })
}

function stop() {
  if (run) run.stopped = true
  run = undefined
}

export const register: Register = on => {
  // `/pathlight:open` is commands/open.md; its run comes here first. The pane is drawn only where it is docked beside the transcript.
  on('command.run', { command: 'pathlight:open' }, async ($, e, next) => {
    if (!e.presentation.isFullscreen || e.presentation.columns < 110) return next(e)
    const found = await $.process.run(['sh', '-c', 'command -v pathlight']).catch(() => ({ exitCode: 1 }))
    if (found.exitCode !== 0) return next(e)
    stop()
    wanted = { view: viewOf(e.args), root: await $.session.root() }
    refused = false
    const opened = await $.ui.open({ id: PANE, title: 'Pathlight', focus: true, columns: 140 })
    if (!opened.isPlaced) { wanted = undefined; return next(e) }
    $.ui.invalidate('ui.render')
    return { text: 'Pathlight is beside the conversation. Type to drive it; click its last row for Tab, the arrows and PgUp/PgDn; Esc comes back here.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // The Raster is the terminal's alone: the desktop app and the editor are told where to look instead.
    if (e.surface !== 'terminal') { const { Text } = $.ui.resolve(e); return <Text dimColor>Pathlight draws in the terminal; open it there.</Text> }
    const { Box, Text, Raster, Input, Client } = $.ui.resolve(e) as Elements['terminal']
    const props = e.props
    const cols = Math.min(512, props.bodyColumns), rows = Math.min(256, props.scroll.bodyRows - 1)
    // Inline (above the prompt) is too small to read; the dock is where the pane belongs.
    if (props.placement === 'inline' && (props.scroll.bodyRows < 24 || props.bodyColumns < 80)) {
      if (!refused) { refused = true; stop(); wanted = undefined; $.ui.toast(TOO_NARROW); void $.ui.close({ id: PANE }) }
      return <Text dimColor>{TOO_NARROW}</Text>
    }
    if (!run && wanted && cols >= 20 && rows >= 8) void start($, { cols, rows })
    const current = run
    if (!current) return <Text dimColor>Pathlight stopped. /pathlight:open starts it again.</Text>
    if (current.ended) return <Text dimColor>Pathlight stopped: {current.ended}. /pathlight:open starts it again.</Text>
    // The keys came back to the conversation (Esc): a field the viewer was typing in leaves it too.
    if (current.focused && !props.isFocused) send($, '/key', { key: 'blur' })
    current.focused = props.isFocused
    if (current.asked.cols !== cols || current.asked.rows !== rows) { current.asked = { cols, rows }; send($, '/resize', { cols, rows }) }
    const frame = current.frame
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

  // The Client row: every key once it has been clicked, posted in order with a number; a number already forwarded is never sent twice.
  on('ui.message', async ($, e) => {
    const current = run
    const events = (e.data as { events?: unknown } | undefined)?.events
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

/** The field changed: what was typed around the blank is keys, a blank lost is a Backspace; the field is then drawn empty again. */
function typed($: any, value: string) {
  // The field holding a blank as drawn is no keystroke (its own redraw, or Enter on nothing typed).
  if (!run || value === blank) return
  const before = blank
  let head = 0
  while (head < before.length && head < value.length && before[head] === value[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < value.length - head && before[before.length - 1 - tail] === value[value.length - 1 - tail]) tail++
  // A blank lost with nothing typed is a Backspace; with something typed it is the field drawn empty as the keys came back (ctrl+x tab).
  const inserted = value.slice(head, value.length - tail), lost = inserted ? 0 : before.length - head - tail
  for (let index = 0; index < lost; index++) send($, '/key', { key: 'backspace' })
  for (const char of inserted) send($, '/key', { key: char === ' ' ? 'space' : char })
  blank = before === ' ' ? '  ' : ' '
  $.ui.invalidate('ui.render')
}

/** Enter in the field: whatever was typed, then Enter, and the field drawn empty again. */
function submitted($: any, value: string) {
  typed($, value)
  send($, '/key', { key: 'return' })
}

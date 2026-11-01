import type { ClientModule } from 'claude-code'

/**
 * The pane's last row: once clicked it holds the keyboard and every key reaches Pathlight (Tab, the arrows, PgUp/PgDn, Home/End, a Backspace with
 * nothing typed, ctrl chords), which the Input beside it cannot pass. Esc gives the keys back to the conversation; it never arrives here.
 *
 * Keys are posted with a number, all the ones not yet forwarded each time (a post replaces one not yet delivered), and the hooks module answers the
 * last number it forwarded.
 */
type Key = { seq: number; key: string; ctrl?: true; shift?: true; meta?: true }
type State = { pending: Key[]; seq: number; holding: boolean }

const KeyRow: ClientModule<{ acked?: number }, State> = (props, surface) => {
  const { Text } = surface.elements
  const acked = props.acked ?? 0
  if (surface.state === undefined) {
    surface.setState({ pending: [], seq: 0, holding: false })
    surface.onKey(event => {
      const now = surface.state ?? { pending: [], seq: 0, holding: false }
      const seq = now.seq + 1
      const pending = [...now.pending.filter(key => key.seq > (props.acked ?? 0)), { seq, ...event }].slice(-64)
      surface.setState({ pending, seq, holding: true })
      surface.post({ events: pending })
    })
    surface.onPointer(event => {
      if (event.type === 'down' && !surface.state?.holding) surface.setState({ ...(surface.state ?? { pending: [], seq: 0 }), holding: true })
    })
  }
  const holding = surface.state?.holding === true && acked >= 0
  return <Text dimColor wrap="truncate">{holding ? ' every key goes to Pathlight · esc returns to the chat · q leaves a mode' : ' click here for tab, arrows and pgup · esc returns to the chat · q leaves a mode'}</Text>
}

export default KeyRow

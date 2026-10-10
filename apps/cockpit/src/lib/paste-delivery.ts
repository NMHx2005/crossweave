import { plainErrorMessage } from './cockpit-host'
import { planSend, type SendTarget } from './prompt-send'

export type Delivery = { ok: boolean; message: string }

/**
 * Pastes text into a session's shell WITHOUT Enter. `planSend` decides first: an agent gets one bracketed paste, a plain shell is
 * refused (a multi-line paste would run each line), a closed shell is refused, and every control character is cleaned.
 * `done` is what the person is told when it went through.
 */
export async function deliverText(o: {
  text: string
  target: SendTarget
  send: (id: string, data: string) => Promise<unknown>
  done: string
}): Promise<Delivery> {
  const item = planSend(o.text, [o.target], { enter: false }).items[0]
  if (item === undefined || item.how === 'refused') return { ok: false, message: `Not sent to ${o.target.name}: ${item?.reason ?? 'there is nothing to send'}` }
  try {
    await o.send(item.id, item.data)
  } catch (err) {
    return { ok: false, message: plainErrorMessage(err) }
  }
  return { ok: true, message: o.done }
}

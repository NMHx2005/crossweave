import type { ClientTransport } from '../client/transport.js';

/**
 * WebSocket transport for DaemonClient — the remote side of the gateway.
 *
 * Uses the platform WebSocket (Bun + browsers) — no extra dependency. The gateway
 * speaks newline-delimited JSON-RPC over WS text frames; this transport does the
 * same framing, just over WS instead of a unix socket.
 */
export function wsTransport(url: string): Promise<ClientTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const dataSubs: Array<(chunk: Buffer | string) => void> = [];
    const endSubs: Array<() => void> = [];
    const errorSubs: Array<(err: Error) => void> = [];
    const closeSubs: Array<() => void> = [];
    let writable = false;



    ws.addEventListener('open', () => {
      writable = true;
      resolve({
        write(frame: string) { ws.send(frame); },
        onData(cb) { dataSubs.push(cb); },
        onEnd(cb) { endSubs.push(cb); },
        onError(cb) { errorSubs.push(cb); },
        onClose(cb) { closeSubs.push(cb); },
        isWritable() { return writable && ws.readyState === WebSocket.OPEN; },
        close() { writable = false; try { ws.close(); } catch {} },
      });
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      for (const cb of dataSubs) try { cb(text); } catch {}
    });
    ws.addEventListener('error', () => {
      writable = false;
      for (const cb of errorSubs) try { cb(new Error('WebSocket error')); } catch {}
    });
    ws.addEventListener('close', () => {
      writable = false;
      for (const cb of closeSubs) try { cb(); } catch {}
      // WS close is also an End for the pending-call guarantee
      for (const cb of endSubs) try { cb(); } catch {}
    });
    ws.addEventListener('close', () => {});
    // Fail connect
    setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        // still connecting after timeout handled by caller; error event will reject via close
      }
    }, 0);
    ws.addEventListener('error', (ev) => {
      if (!writable) reject(new Error('WebSocket connect failed'));
    });
  });
}

/**
 * In-memory paired WebSocket-like transports for tests — no network.
 * Mirrors MemoryTransport but speaks as a pair so gateway shuttling can be tested.
 */
export function createMemoryWsPair(): [ClientTransport, ClientTransport] {
  const aToB: string[] = [];
  const bToA: string[] = [];
  let aWritable = true, bWritable = true;
  const aData: Array<(c: Buffer | string) => void> = [];
  const bData: Array<(c: Buffer | string) => void> = [];
  const aEnd: Array<() => void> = [], bEnd: Array<() => void> = [];
  const aErr: Array<(e: Error) => void> = [], bErr: Array<(e: Error) => void> = [];
  const aClose: Array<() => void> = [], bClose: Array<() => void> = [];
  const a: ClientTransport = {
    write(f) { for (const cb of bData) try { cb(f); } catch {} },
    onData(cb) { aData.push(cb); }, onEnd(cb) { aEnd.push(cb); }, onError(cb) { aErr.push(cb); }, onClose(cb) { aClose.push(cb); },
    isWritable() { return aWritable; }, close() { aWritable = false; for (const cb of bEnd) try { cb(); } catch {}; for (const cb of bClose) try { cb(); } catch {}; bWritable = false; for (const cb of aClose) try { cb(); } catch {} },
  };
  const b: ClientTransport = {
    write(f) { for (const cb of aData) try { cb(f); } catch {} },
    onData(cb) { bData.push(cb); }, onEnd(cb) { bEnd.push(cb); }, onError(cb) { bErr.push(cb); }, onClose(cb) { bClose.push(cb); },
    isWritable() { return bWritable; }, close() { bWritable = false; for (const cb of aEnd) try { cb(); } catch {}; for (const cb of bClose) try { cb(); } catch {}; aWritable = false; for (const cb of bClose) try { cb(); } catch {} },
  };
  return [a, b];
}

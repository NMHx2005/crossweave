import { StringDecoder } from 'node:string_decoder';

/**
 * Bounds an UNTERMINATED line that keeps growing — the memory-exhaustion vector,
 * since both the daemon's RPC socket and every session's MCP socket accept
 * connections from a semi-trusted peer (an agent process; see the `trust` column).
 * A peer that writes without ever sending a newline would otherwise grow the
 * daemon's heap without limit, long before any per-message size cap downstream gets
 * a chance to look at the payload.
 *
 * It does NOT bound a complete oversized frame that arrives with its own newline:
 * the loop drains that as an ordinary line before the length check runs. Set far
 * above any legitimate frame; session scrollback and diffs are the largest payloads.
 */
export const MAX_LINE_LENGTH = 16 * 1024 * 1024;

/**
 * Reassembles a byte stream into newline-delimited lines, dropping any line that
 * exceeds `MAX_LINE_LENGTH` and resynchronising at the next newline.
 *
 * One decoder per framer instance, reused across every call: a multi-byte UTF-8
 * codepoint can straddle two socket chunks, and `StringDecoder` buffers the dangling
 * partial sequence internally until the rest arrives. Calling `chunk.toString('utf8')`
 * per chunk instead decodes each half independently and bakes U+FFFD into the payload
 * — still valid JSON, silently wrong content, and no error to catch. Real sockets
 * split anywhere, so this is reachable in normal operation.
 *
 * Shared by `src/daemon/rpc.ts` and `src/mcp/protocol.ts` so the cap cannot drift
 * apart between the two transports again: the MCP framer was hand-rolled from this
 * logic and silently lost the cap.
 */
export function createLineFramer(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let discarding = false;

  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (discarding) {
        discarding = false; // This newline ends the over-long line we dropped.
      } else if (line.length > 0) {
        onLine(line);
      }
      index = buffer.indexOf('\n');
    }

    if (buffer.length > MAX_LINE_LENGTH) {
      buffer = '';
      discarding = true;
    }
  };
}

import { TARGET_RATE, concatChunks, downsample, encodeWav16 } from './wav'
import { audioStats, type AudioStats } from './voice-audio'

export interface RecordedAudio {
  wav: Uint8Array
  /** How loud it was: a silent take must not be sent to a model that will invent words. */
  stats: AudioStats
}

export interface Recording {
  /** Stop and return the audio as a 16 kHz mono WAV, with its level. */
  stop(): Promise<RecordedAudio>
  /** The loudest sample of the most recent moment, 0..1, for a level meter. */
  level(): number
  /** Stop and throw the audio away. */
  cancel(): void
  /** Milliseconds recorded so far. */
  elapsedMs(): number
}

export interface RecorderOptions {
  /** Called once when the length cap is reached; the caller then stops the recording. */
  onLimit: () => void
  maxSeconds: number
}

/**
 * Record the microphone as raw samples and encode them ourselves. Chromium's
 * MediaRecorder only produces compressed WebM/Opus, which whisper-style tools cannot
 * read; taking the samples directly gives a plain WAV with no converter installed.
 * The stream's tracks are always stopped, so the macOS microphone indicator goes out the
 * moment recording ends.
 */
export async function startRecording(opts: RecorderOptions): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  // ScriptProcessor is deprecated but present and simple; an AudioWorklet would need a
  // module URL, and this runs for seconds at a time.
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  const started = performance.now()
  let limited = false
  let closed = false
  let recent = 0

  processor.onaudioprocess = (event) => {
    if (closed) return
    const chunk = new Float32Array(event.inputBuffer.getChannelData(0))
    chunks.push(chunk)
    recent = audioStats(chunk).peak
    if (!limited && performance.now() - started >= opts.maxSeconds * 1000) {
      limited = true
      opts.onLimit()
    }
  }
  source.connect(processor)
  // A processor only runs while connected onward; its output is silent.
  processor.connect(context.destination)

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    processor.disconnect()
    source.disconnect()
    for (const track of stream.getTracks()) track.stop()
    await context.close().catch(() => undefined)
  }

  return {
    elapsedMs: () => performance.now() - started,
    level: () => recent,
    cancel: () => { void close() },
    async stop() {
      const rate = context.sampleRate
      await close()
      const samples = downsample(concatChunks(chunks), rate, TARGET_RATE)
      return { wav: encodeWav16(samples, Math.min(rate, TARGET_RATE)), stats: audioStats(samples) }
    },
  }
}

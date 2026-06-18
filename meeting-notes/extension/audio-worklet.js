// audio-worklet.js — runs on the realtime audio thread.
//
// It receives the mixed (tab + mic), down-mixed-to-mono signal one render
// quantum (128 frames) at a time, batches a few quanta together to cut down on
// postMessage churn, and ships raw Float32 PCM to the main thread (offscreen.js),
// which handles resampling to 16 kHz, WAV encoding, and upload.
//
// We collect raw PCM (NOT sliced webm/opus) on purpose: webm timeslices after
// the first lack container headers and can't be transcribed standalone.

class PCMCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._count = 0;
    // ~2048 samples (~43 ms @ 48 kHz) per message: smooth without being chatty.
    this._batch = 2048;
  }

  process(inputs) {
    const input = inputs[0];
    // input is an array of channels. We configured the node for mono, so the
    // engine has already down-mixed tab+mic to a single channel for us.
    if (input && input.length > 0) {
      const channel = input[0];
      if (channel && channel.length > 0) {
        // The engine reuses the underlying buffer, so copy before keeping it.
        this._buf.push(new Float32Array(channel));
        this._count += channel.length;

        if (this._count >= this._batch) {
          const out = new Float32Array(this._count);
          let offset = 0;
          for (const a of this._buf) {
            out.set(a, offset);
            offset += a.length;
          }
          // Transfer the buffer (zero-copy) to the main thread.
          this.port.postMessage(out, [out.buffer]);
          this._buf = [];
          this._count = 0;
        }
      }
    }
    // Return true to keep the processor alive. We never write to outputs, so the
    // node emits silence — it's connected to destination only to stay scheduled.
    return true;
  }
}

registerProcessor("pcm-collector", PCMCollector);

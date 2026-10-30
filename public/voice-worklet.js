// Runs on the audio thread. It batches render quanta into ~1024-sample blocks
// so the UI thread only receives a handful of messages per second.
class BroCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      this.buffer[this.filled] = channel[index];
      this.filled += 1;
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer);
        this.buffer = new Float32Array(1024);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('bro-capture', BroCaptureProcessor);

/**
 * 브라우저 오디오 유틸
 * - 모든 오디오를 16kHz mono로 변환 (Whisper 입력 규격)
 * - 100초 단위 WAV 청크(약 3.2MB)로 잘라서 Vercel 요청 크기 제한(4.5MB)을 피함
 */

export const TARGET_RATE = 16000;
export const CHUNK_SEC = 100;

/* ---------- PCM / WAV ---------- */

export function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function encodeWav(pcm: Int16Array, rate = TARGET_RATE): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

export function concatInt16(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 0~1 범위 RMS. 무음 청크 판별용 (Whisper는 무음에서 헛소리를 만들어냄) */
export function rmsInt16(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / pcm.length);
}

/* ---------- 스트리밍 리샘플러 (녹음용) ---------- */

/** 박스 필터(간이 저역통과) + 선형 보간. 버퍼 경계에서도 샘플이 새거나 튀지 않도록 상태 유지 */
export class StreamResampler {
  private ratio: number;
  private t = 0;
  private prev = 0;
  private k: number;
  private hist: number[] = [];
  private sum = 0;

  constructor(inRate: number, outRate = TARGET_RATE) {
    this.ratio = inRate / outRate;
    this.k = Math.max(1, Math.round(this.ratio));
  }

  process(input: Float32Array): Float32Array {
    // 1) 박스 필터
    const x = new Float32Array(input.length);
    for (let n = 0; n < input.length; n++) {
      this.hist.push(input[n]);
      this.sum += input[n];
      if (this.hist.length > this.k) this.sum -= this.hist.shift()!;
      x[n] = this.sum / this.hist.length;
    }
    if (this.ratio === 1) return x;

    // 2) 선형 보간 다운샘플
    const out: number[] = [];
    const len = x.length;
    while (this.t < len - 1) {
      const i = Math.floor(this.t);
      const frac = this.t - i;
      const a = i < 0 ? this.prev : x[i];
      const b = x[i + 1];
      out.push(a + (b - a) * frac);
      this.t += this.ratio;
    }
    this.t -= len;
    if (len) this.prev = x[len - 1];
    return Float32Array.from(out);
  }
}

/* ---------- 마이크 녹음 ---------- */

const WORKLET_SRC = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export type ChunkHandler = (pcm: Int16Array, startSec: number) => void;

export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private resampler: StreamResampler | null = null;
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private emitted = 0; // 지금까지 내보낸 샘플 수 (16kHz 기준)
  private chunkSamples = CHUNK_SEC * TARGET_RATE;
  private paused = false;

  constructor(
    private onChunk: ChunkHandler,
    private onInterrupt: (reason: string) => void
  ) {}

  get seconds(): number {
    return (this.emitted + this.pendingLen) / TARGET_RATE;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const AC: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;
    await ctx.resume();
    this.resampler = new StreamResampler(ctx.sampleRate);

    const src = ctx.createMediaStreamSource(this.stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);

    const feed = (f: Float32Array) => {
      if (this.paused) return;
      this.push(this.resampler!.process(f));
    };

    let capture: AudioNode;
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, "pcm-capture");
      node.port.onmessage = (e) => feed(e.data as Float32Array);
      capture = node;
    } catch {
      // 구형 브라우저 fallback
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => feed(new Float32Array(e.inputBuffer.getChannelData(0)));
      capture = sp;
    }
    src.connect(capture);
    capture.connect(mute);
    this.nodes = [src, capture, mute];

    this.stream.getAudioTracks()[0]?.addEventListener("ended", () =>
      this.onInterrupt("마이크 연결이 끊겼습니다.")
    );
    ctx.addEventListener("statechange", () => {
      if (ctx.state !== "running" && ctx.state !== "closed") {
        this.onInterrupt("화면이 꺼지거나 다른 앱으로 전환되어 녹음이 일시 중단됐을 수 있습니다.");
      }
    });
  }

  setPaused(p: boolean) {
    this.paused = p;
  }

  async resumeContext() {
    if (this.ctx && this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
  }

  private push(f: Float32Array) {
    if (!f.length) return;
    this.pending.push(f);
    this.pendingLen += f.length;
    while (this.pendingLen >= this.chunkSamples) this.emit(this.chunkSamples);
  }

  private emit(n: number) {
    const out = new Float32Array(n);
    let o = 0;
    while (o < n) {
      const head = this.pending[0];
      const take = Math.min(head.length, n - o);
      out.set(head.subarray(0, take), o);
      o += take;
      if (take === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(take);
    }
    this.pendingLen -= n;
    const start = this.emitted / TARGET_RATE;
    this.emitted += n;
    this.onChunk(floatToInt16(out), start);
  }

  async stop() {
    if (this.pendingLen > TARGET_RATE * 0.5) this.emit(this.pendingLen);
    this.pending = [];
    this.pendingLen = 0;
    this.nodes.forEach((n) => {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    });
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

/* ---------- 파일 디코딩 ---------- */

/** 업로드한 오디오/비디오 파일 → 16kHz mono Float32 */
export async function decodeFileTo16k(file: File): Promise<Float32Array> {
  const data = await file.arrayBuffer();

  // 1차: 16kHz 컨텍스트로 바로 디코딩 (메모리 절약, 브라우저가 고품질 리샘플)
  try {
    const off = new OfflineAudioContext(1, 1, TARGET_RATE);
    const buf = await off.decodeAudioData(data.slice(0));
    return mixdown(buf);
  } catch {
    /* Safari 구버전 등에서 16kHz 컨텍스트 미지원 → fallback */
  }

  const AC: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(data.slice(0));
    const mono = mixdown(buf);
    if (buf.sampleRate === TARGET_RATE) return mono;
    const rs = new StreamResampler(buf.sampleRate);
    const parts: Float32Array[] = [];
    const STEP = 1 << 16;
    for (let i = 0; i < mono.length; i += STEP) parts.push(rs.process(mono.subarray(i, i + STEP)));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  } finally {
    ctx.close().catch(() => {});
  }
}

function mixdown(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

export function splitToChunks(f: Float32Array): { pcm: Int16Array; startSec: number }[] {
  const n = CHUNK_SEC * TARGET_RATE;
  const out: { pcm: Int16Array; startSec: number }[] = [];
  for (let i = 0; i < f.length; i += n) {
    const part = f.subarray(i, i + n);
    if (part.length < TARGET_RATE * 0.5) break;
    out.push({ pcm: floatToInt16(part), startSec: i / TARGET_RATE });
  }
  return out;
}

export function fmtTime(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

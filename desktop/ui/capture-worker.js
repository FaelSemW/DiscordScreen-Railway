/**
 * DC Screen Sharing — Native Capture Worker
 *
 * Runs in the hidden BrowserWindow (show:false, backgroundThrottling:false).
 * This renderer is NOT a user-visible tab. It cannot be minimized, backgrounded,
 * or throttled as a browser tab would be.
 *
 * CAPTURE ENGINE:
 *   - Uses Electron's desktopCapturer source ID via chromeMediaSourceId
 *   - Uses MediaStreamTrackProcessor for push-based frame delivery
 *   - The OS delivers frames directly — NO requestAnimationFrame, NO setInterval
 *   - VideoEncoder (WebCodecs) encodes frames with hardware acceleration
 *   - AudioEncoder (WebCodecs) encodes Opus audio at 48kHz
 *
 * AUDIO:
 *   - If nativeAudio=true: PCM arrives from main via IPC (DCSS.AudioCapture.exe)
 *   - If nativeAudio=false + audio=true: captured from the media stream (getDisplayMedia)
 *
 * IPC PROTOCOL (via captureAPI contextBridge):
 *   main → renderer: { type: 'capture-start', sourceId, fps, width, height, bitrate, audio, nativeAudio }
 *   main → renderer: { type: 'capture-stop' }
 *   main → renderer: { type: 'capture-keyframe' }
 *   renderer → main: captureAPI.sendMessage({ type: 'capture-ready' })
 *   renderer → main: captureAPI.sendMessage({ type: 'capture-started' })
 *   renderer → main: captureAPI.sendMessage({ type: 'capture-config', config })
 *   renderer → main: captureAPI.sendMessage({ type: 'audio-config', config })
 *   renderer → main: captureAPI.sendMessage({ type: 'capture-stats', stats })
 *   renderer → main: captureAPI.sendMessage({ type: 'capture-error', message })
 *   renderer → main: captureAPI.sendChunk(ArrayBuffer)   ← encoded video/audio
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const TIPO_KEYFRAME = 1;
const TIPO_DELTA    = 2;
const TIPO_AUDIO    = 3;

const AUDIO_BITRATE   = 96_000; // 96 kbps Opus — transparent for app audio
const KEYFRAME_EVERY_MS = 8_000;
const MAX_H264_PROFILES = [
  { profile: '6400', label: 'High' },
  { profile: '4d40', label: 'Main' },
  { profile: '42e0', label: 'Baseline' },
];

// H.264 levels table (macroblocks)
const H264_LEVELS = [
  { level: 0x1e, maxFS: 1620,  maxMBPS: 40500    }, // 3.0
  { level: 0x1f, maxFS: 3600,  maxMBPS: 108000   }, // 3.1
  { level: 0x20, maxFS: 5120,  maxMBPS: 216000   }, // 3.2
  { level: 0x28, maxFS: 8192,  maxMBPS: 245760   }, // 4.0
  { level: 0x2a, maxFS: 8704,  maxMBPS: 522240   }, // 4.2
  { level: 0x32, maxFS: 22080, maxMBPS: 589824   }, // 5.0
  { level: 0x33, maxFS: 36864, maxMBPS: 983040   }, // 5.1
  { level: 0x34, maxFS: 36864, maxMBPS: 2073600  }, // 5.2
];

function h264Level(w, h, fps) {
  const mb = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbps = mb * fps;
  return (H264_LEVELS.find((l) => mb <= l.maxFS && mbps <= l.maxMBPS) ?? H264_LEVELS.at(-1)).level;
}

function makeCodecCandidates(w, h, fps) {
  const level = h264Level(w, h, fps).toString(16).padStart(2, '0');
  const h264 = MAX_H264_PROFILES.flatMap(({ profile }) => {
    const codec = `avc1.${profile}${level}`;
    return [{ codec, avc: { format: 'annexb' } }, { codec }];
  });
  return [...h264, { codec: 'vp8' }, { codec: 'vp09.00.10.08' }];
}

function even(n) { return Math.max(2, n - (n % 2)); }
function fitWithin(w, h, maxW = 3840, maxH = 2160) {
  // No artificial 1080p cap — support 4K if hardware allows
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
}

// ── State ─────────────────────────────────────────────────────────────────────
let running = false;
let captureGeneration = 0;
let fallbackAudioStream = null;
let lastFrameWallTime = null;
let requestedQuality = null;
let qualityLevel = 0;
let pressureSeconds = 0;
let healthySeconds = 0;
let nextAdmissionAt = 0;
let stream  = null;
let encoder = null;
let audioEncoder = null;
let reader  = null;
let audioReader = null;
let stopPcmListener = null;

let config = null;       // current VideoEncoder config
let srcW = 0, srcH = 0;
let targetWidth = 1920, targetHeight = 1080;
let wantKeyframe  = true;
let lastKeyframeAt = 0;
let assignedSlot   = 0;
let cachedFrame    = null;

// Frame pacing & backpressure
let lastTimestampUs = null;
let consecutiveHighQueue = 0;
let transportBackpressure = false;
let encoderBackpressure = false; // declared here to avoid ReferenceError in strict mode
let afogado = false;              // legacy alias used in dequeue listener
let lastFrameArrivalTime = null;
const intervalSamples = [];
let gap25Count = 0, gap33Count = 0, gap50Count = 0, gap100Count = 0;
const frameEncodeStartMap = new Map();
let totalEncodeLatencyMs = 0, encodeLatencySamples = 0;

// Stats
let framesCapture = 0, framesAdmitted = 0, framesEncoded = 0, framesSent = 0;
let droppedDuplicate = 0, droppedObsolete = 0, droppedEncoderPressure = 0, droppedTransportPressure = 0, droppedInvalid = 0;
let keyframeCount = 0;
let audioChunks = 0;
let statsTimer = null;
let lastStatsEmit = performance.now();

// Audio
let nativeAudioMode = false;
let pcmTimestampUs = 0;

// ── IPC bridge ────────────────────────────────────────────────────────────────
const api = window.captureAPI;
if (!api) {
  console.error('[CaptureWorker] captureAPI not available — missing preload?');
}

// Announce readiness to main process
api?.ready();

// Listen for commands from main process
api?.onCommand((msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'capture-start') {
    const start = handleStart(msg);
    const generation = captureGeneration;
    start.catch((err) => {
      if (generation !== captureGeneration) return;
      console.error('[CaptureWorker] Start error:', err);
      handleStop();
      api.sendMessage({ type: 'capture-error', message: err.message });
    });
  } else if (msg.type === 'capture-stop') {
    handleStop();
  } else if (msg.type === 'set-slot') {
    assignedSlot = Number(msg.slot) || 0;
  } else if (msg.type === 'capture-keyframe') {
    wantKeyframe = true;
    dispatchImmediateKeyframe();
  } else if (msg.type === 'transport-pressure') {
    transportBackpressure = Boolean(msg.active);
    if (!transportBackpressure) wantKeyframe = true;
  }
});

function dispatchImmediateKeyframe() {
  if (!running || transportBackpressure || !encoder || encoder.state !== 'configured' || !cachedFrame || encoder.encodeQueueSize > 6) return;
  try {
    const nowWall = Date.now();
    // Stay in the capture track's clock domain. performance.now() is not
    // guaranteed to share its origin; mixing clocks can discard all later frames.
    const tsUs = (lastTimestampUs ?? cachedFrame.timestamp ?? 0) + 1;
    rememberEncode(tsUs, performance.now());
    const frameCopy = new VideoFrame(cachedFrame, { timestamp: tsUs });
    try { encoder.encode(frameCopy, { keyFrame: true }); } finally { frameCopy.close(); }
    lastKeyframeAt = nowWall;
    wantKeyframe = false;
    keyframeCount++;
    console.info('[CaptureWorker] Immediate keyframe dispatched from cached frame on request.');
  } catch (err) {
    console.warn('[CaptureWorker] Immediate keyframe dispatch failed:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function handleStart(opts) {
  handleStop();
  const generation = captureGeneration;

  running = true;
  wantKeyframe = true;
  lastKeyframeAt = 0;
  srcW = 0; srcH = 0;
  framesCapture = 0; framesAdmitted = 0; framesEncoded = 0; framesSent = 0;
  droppedDuplicate = 0; droppedObsolete = 0; droppedEncoderPressure = 0; droppedTransportPressure = 0; droppedInvalid = 0;
  lastTimestampUs = null; consecutiveHighQueue = 0; transportBackpressure = false;
  lastFrameArrivalTime = null; intervalSamples.length = 0;
  gap25Count = 0; gap33Count = 0; gap50Count = 0; gap100Count = 0;
  frameEncodeStartMap.clear(); totalEncodeLatencyMs = 0; encodeLatencySamples = 0;
  nativeAudioMode = Boolean(opts.nativeAudio);
  lastFrameWallTime = null;
  qualityLevel = 0; pressureSeconds = 0; healthySeconds = 0; nextAdmissionAt = 0;

  const fps = Number(opts.fps) || 60;
  targetWidth  = Number(opts.width)  || 1920;
  targetHeight = Number(opts.height) || 1080;
  const bitrate      = Number(opts.bitrate) || 8_000_000;
  requestedQuality = { width: targetWidth, height: targetHeight, fps, bitrate };

  // ── 1. Acquire media stream via Electron desktopCapturer ────────────────
  // We ALWAYS set audio: false for getUserMedia.
  // Audio is captured natively via WASAPI (DCSS.AudioCapture.exe) to avoid
  // Chromium desktop audio capture lockups, deadlocks, and lack of window isolation.
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: opts.sourceId,
        maxWidth:     targetWidth,
        maxHeight:    targetHeight,
        maxFrameRate: fps,
      },
    },
  };

  const acquiredStream = await navigator.mediaDevices.getUserMedia(constraints);
  if (generation !== captureGeneration) {
    acquiredStream.getTracks().forEach((t) => t.stop());
    return;
  }
  stream = acquiredStream;

  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('No video track from getUserMedia.');

  // contentHint 'motion' unlocks Chromium's native 60 FPS capture
  track.contentHint = 'motion';

  track.addEventListener('ended', () => {
    if (running && generation === captureGeneration) {
      api.sendMessage({ type: 'capture-error', message: 'Fonte de captura encerrada pelo sistema.' });
      handleStop();
    }
  });

  // ── 2. Create MediaStreamTrackProcessor ─────────────────────────────────
  const MSTProcessor = typeof MediaStreamTrackProcessor !== 'undefined'
    ? MediaStreamTrackProcessor
    : window.MediaStreamTrackProcessor;

  if (!MSTProcessor) {
    throw new Error('MediaStreamTrackProcessor unavailable in this Electron build.');
  }

  reader = new MSTProcessor({ track }).readable.getReader();
  const captureReader = reader;

  // Try reading initial physical frame with a 500ms timeout
  let firstFrame = null;
  let pendingRead = captureReader.read();
  let firstReadTimer;
  try {
    const firstRead = await Promise.race([
      pendingRead,
      new Promise((_, reject) => { firstReadTimer = setTimeout(() => reject(new Error('init-timeout')), 500); }),
    ]);
    pendingRead = null;
    if (firstRead && !firstRead.done && firstRead.value) {
      firstFrame = firstRead.value;
    }
  } catch {
    console.info('[CaptureWorker] Initial physical frame deferred to stream pump.');
  } finally { clearTimeout(firstReadTimer); }
  if (generation !== captureGeneration) {
    firstFrame?.close();
    pendingRead?.then(({ value }) => value?.close()).catch(() => {});
    return;
  }

  const fw = firstFrame?.displayWidth || targetWidth;
  const fh = firstFrame?.displayHeight || targetHeight;
  srcW = fw;
  srcH = fh;
  const actual = fitWithin(fw, fh, targetWidth, targetHeight);
  console.info('[CaptureWorker] Initial geometry:', fw, 'x', fh, '=> configuring codec at', actual.width, 'x', actual.height);

  // ── 3. Pick codec with dimensions ───────────────────────────────────────
  const selectedConfig = await pickConfig(actual.width, actual.height, fps, bitrate);
  if (generation !== captureGeneration) {
    firstFrame?.close();
    pendingRead?.then(({ value }) => value?.close()).catch(() => {});
    return;
  }
  config = selectedConfig;
  if (!config) {
    firstFrame?.close();
    pendingRead?.then(({ value }) => value?.close()).catch(() => {});
    throw new Error('No supported video codec found.');
  }

  api.sendMessage({ type: 'capture-config', config: { codec: config.codec, width: config.width, height: config.height, framerate: fps } });

  // ── 4. Create VideoEncoder ───────────────────────────────────────────────
  encoder = new VideoEncoder({
    output: onEncoded,
    error: (err) => {
      console.error('[CaptureWorker] Encoder error:', err.message);
      wantKeyframe = true;
      try {
        if (config && running) {
          encoder = new VideoEncoder({
            output: onEncoded,
            error: (e) => console.error('[CaptureWorker] Recovered encoder error:', e.message),
          });
          encoder.configure(config);
          wantKeyframe = true;
        }
      } catch (recErr) {
        console.error('[CaptureWorker] Encoder recovery failed:', recErr.message);
      }
    },
  });

  encoder.addEventListener?.('dequeue', () => {
    const q = encoder.encodeQueueSize;
    if (q <= 1) { afogado = false; encoderBackpressure = false; }
  });

  encoder.configure(config);

  // Encode the first frame immediately if available
  if (firstFrame) {
    framesCapture++;
    lastFrameArrivalTime = performance.now();
    lastFrameWallTime = Date.now();
    encodeFrame(firstFrame);
  }

  // ── 5. Start audio ───────────────────────────────────────────────────────
  if (opts.audio) {
    if (nativeAudioMode) {
      // Primary path: PCM from DCSS.AudioCapture.exe via IPC
      startNativeAudio();
    } else {
      // Fallback path: capture audio track from the display media stream.
      // This fires when nativeAudio=false (e.g. AudioExclusion helper failed
      // or Discord is not running and no helper is needed), OR when running
      // in a context where the exe is unavailable.
      // Re-acquire the stream with audio=true for loopback capture.
      try {
        const audioConstraints = {
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: opts.sourceId,
            },
          },
          video: false,
        };
        let audioStream = null;
        try {
          audioStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
          if (generation !== captureGeneration) {
            audioStream.getTracks().forEach((t) => t.stop());
            pendingRead?.then(({ value }) => value?.close()).catch(() => {});
            return;
          }
          fallbackAudioStream = audioStream;
        } catch (audioErr) {
          // getUserMedia with audio:desktop may fail for window sources — expected
          console.info('[CaptureWorker] Desktop audio capture not available for this source:', audioErr.message);
        }
        const audioTrack = audioStream?.getAudioTracks()[0];
        if (audioTrack) {
          console.info('[CaptureWorker] Fallback: starting audio encoder from display media stream.');
          startAudioEncoder(audioTrack).catch(err => console.warn('[CaptureWorker] Audio pump failed:', err.message));
        } else {
          console.info('[CaptureWorker] No audio track available from stream — audio disabled for this capture.');
        }
      } catch (fallbackErr) {
        console.warn('[CaptureWorker] Audio fallback failed:', fallbackErr.message);
      }
    }
  }

  // ── 6. Start frame pump (push-based, not RAF) ────────────────────────────
  pumpDirect(track, captureReader, pendingRead, generation);

  api.sendMessage({ type: 'capture-started' });
  startStatsTimer();
}

// ── Stop ──────────────────────────────────────────────────────────────────────
function handleStop() {
  captureGeneration++;
  running = false;

  stopStatsTimer();

  if (reader)   { reader.cancel().catch(() => {}); reader = null; }
  if (audioReader) { audioReader.cancel().catch(() => {}); audioReader = null; }

  if (stopPcmListener) { stopPcmListener(); stopPcmListener = null; }

  if (encoder && encoder.state !== 'closed') {
    try { encoder.close(); } catch {}
    encoder = null;
  }
  if (audioEncoder && audioEncoder.state !== 'closed') {
    try { audioEncoder.close(); } catch {}
    audioEncoder = null;
  }

  if (stream) {
    stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    stream = null;
  }
  fallbackAudioStream?.getTracks().forEach((t) => t.stop());
  fallbackAudioStream = null;
  frameEncodeStartMap.clear();

  if (cachedFrame) {
    try { cachedFrame.close(); } catch {}
    cachedFrame = null;
  }

  config = null;
  console.info('[CaptureWorker] Stopped.');
}

// ── MediaStreamTrackProcessor (push-based frame delivery) ────────────────────
async function pumpDirect(track, captureReader, pendingRead, generation) {
  while (running && generation === captureGeneration) {
    let frame;
    try {
      const { done, value } = await (pendingRead || captureReader.read());
      pendingRead = null;
      if (generation !== captureGeneration) { value?.close(); return; }
      if (done) break;
      frame = value;
    } catch {
      break;
    }
    const now = performance.now();
    framesCapture++;

    if (lastFrameArrivalTime !== null) {
      const intervalMs = now - lastFrameArrivalTime;
      intervalSamples.push(intervalMs);
      if (intervalSamples.length > 240) intervalSamples.shift();

      if (intervalMs > 100) gap100Count++;
      else if (intervalMs > 50) gap50Count++;
      else if (intervalMs > 33) gap33Count++;
      else if (intervalMs > 25) gap25Count++;
    }
    lastFrameArrivalTime = now;
    lastFrameWallTime = Date.now();

    encodeFrame(frame);
  }
  if (running && generation === captureGeneration) {
    api.sendMessage({ type: 'capture-error', message: 'Fluxo de captura interrompido; tentando recuperar.' });
  }
}

function rememberEncode(timestamp, now) {
  // Failed/reset encoders may never emit their pending chunks.
  while (frameEncodeStartMap.size >= 120) frameEncodeStartMap.delete(frameEncodeStartMap.keys().next().value);
  frameEncodeStartMap.set(timestamp, now);
}

// ── Frame encoding ────────────────────────────────────────────────────────────
function encodeFrame(frame) {
  if (!running) {
    frame.close();
    return false;
  }

  if (!encoder || encoder.state !== 'configured') {
    if (config && (!encoder || encoder.state === 'closed')) {
      try {
        console.warn('[CaptureWorker] Re-creating VideoEncoder...');
        encoder = new VideoEncoder({
          output: onEncoded,
          error: (err) => {
            console.error('[CaptureWorker] Encoder error:', err.message);
            wantKeyframe = true;
          },
        });
        encoder.configure(config);
        wantKeyframe = true;
      } catch (err) {
        console.error('[CaptureWorker] Encoder recovery failed:', err.message);
        frame.close();
        return false;
      }
    } else {
      frame.close();
      return false;
    }
  }

  const now = performance.now();
  if (now + 1 < nextAdmissionAt) { frame.close(); return true; }
  const framePeriod = 1000 / (config.framerate || 60);
  nextAdmissionAt = nextAdmissionAt ? Math.max(now, nextAdmissionAt + framePeriod) : now + framePeriod;

  // Validate frame integrity
  if (!frame.displayWidth || !frame.displayHeight) {
    droppedInvalid++;
    frame.close();
    return true;
  }

  const currentQueue = encoder.encodeQueueSize;

  // Track sustained queue depth (hardware encoders routinely have 2-4 frames in flight)
  if (currentQueue > 6) {
    consecutiveHighQueue++;
  } else {
    consecutiveHighQueue = 0;
  }

  // Multi-factor backpressure: only drop if queue is severely backed up or transport congested
  let dropReason = null;
  if (currentQueue > 8 || consecutiveHighQueue >= 4) {
    dropReason = 'DROP_ENCODER_PRESSURE';
  } else if (transportBackpressure) {
    dropReason = 'DROP_TRANSPORT_PRESSURE';
  }

  if (dropReason) {
    if (dropReason === 'DROP_ENCODER_PRESSURE') droppedEncoderPressure++;
    else droppedTransportPressure++;
    frame.close();
    return true;
  }

  // Monotonic timestamp check
  const tsUs = frame.timestamp ?? (now * 1000);
  if (lastTimestampUs !== null && tsUs <= lastTimestampUs) {
    if (tsUs < lastTimestampUs) {
      droppedObsolete++;
    } else {
      droppedDuplicate++;
    }
    frame.close();
    return true;
  }

  lastTimestampUs = tsUs;
  framesAdmitted++;
  rememberEncode(tsUs, now);

  // Periodic forced keyframe
  const nowWall = Date.now();
  if (nowWall - lastKeyframeAt > KEYFRAME_EVERY_MS) wantKeyframe = true;

  // Resize check
  syncSize(frame);

  // Cache the admitted frame for instantaneous keyframe dispatch when requested by new viewers
  if (cachedFrame) {
    try { cachedFrame.close(); } catch {}
  }
  try {
    cachedFrame = frame.clone();
  } catch {
    cachedFrame = null;
  }

  try {
    encoder.encode(frame, { keyFrame: wantKeyframe });
    if (wantKeyframe) { lastKeyframeAt = nowWall; wantKeyframe = false; keyframeCount++; }
  } catch (err) {
    frameEncodeStartMap.delete(tsUs);
    console.error('[CaptureWorker] encode() error:', err.message);
  }

  frame.close();
  return true;
}

// ── Dynamic resize (4K-capable) ───────────────────────────────────────────────
function syncSize(frame) {
  const fw = frame.displayWidth;
  const fh = frame.displayHeight;
  if (!fw || !fh || (fw === srcW && fh === srcH)) return;
  srcW = fw; srcH = fh;

  const target = fitWithin(fw, fh, targetWidth, targetHeight);
  if (target.width === config.width && target.height === config.height) return;

  const level = h264Level(target.width, target.height, config.framerate || 60).toString(16).padStart(2, '0');
  const newCodec = config.codec?.startsWith('avc1.')
    ? config.codec.slice(0, 9) + level
    : config.codec;

  const newConfig = { ...config, width: target.width, height: target.height, codec: newCodec };
  try {
    encoder.configure(newConfig);
    config = newConfig;
    wantKeyframe = true;
    api.sendMessage({ type: 'capture-config', config: { codec: config.codec, width: config.width, height: config.height } });
  } catch (err) {
    console.warn('[CaptureWorker] Resize encoder configure failed:', err.message);
  }
}

// ── Encoded frame → main process ──────────────────────────────────────────────
function onEncoded(chunk, metadata) {
  if (!running) return;
  framesEncoded++;
  const isKey  = chunk.type === 'key';

  if (isKey && metadata?.decoderConfig) {
    const dc = metadata.decoderConfig;
    const cfg = {
      codec: dc.codec || config?.codec,
      width: dc.codedWidth || config?.width,
      height: dc.codedHeight || config?.height,
      framerate: config?.framerate || 60,
    };
    if (dc.description) {
      const b = new Uint8Array(
        dc.description instanceof ArrayBuffer ? dc.description : dc.description.buffer,
      );
      let bin = '';
      for (const x of b) bin += String.fromCharCode(x);
      cfg.description = btoa(bin);
    }
    api.sendMessage({ type: 'capture-config', config: cfg });
  }

  const tsUs   = chunk.timestamp ?? 0;
  const sentAt = Date.now();

  const startT = frameEncodeStartMap.get(tsUs);
  if (startT !== undefined) {
    totalEncodeLatencyMs += (performance.now() - startT);
    encodeLatencySamples++;
    frameEncodeStartMap.delete(tsUs);
  }

  // Binary packet format (matches shared/broadcaster.js + server/rooms.js):
  // [0]      slot byte (0 = native broadcaster, slot assigned by server)
  // [1]      type: 1=keyframe, 2=delta, 3=audio
  // [2..9]   captureTimestamp (Float64, microseconds)
  // [10..17] sentAt (Float64, milliseconds wall clock)
  // [18..]   encoded data
  const data    = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);

  const header = new ArrayBuffer(18);
  const dv     = new DataView(header);
  dv.setUint8(0, assignedSlot);             // slot assigned by server
  dv.setUint8(1, isKey ? TIPO_KEYFRAME : TIPO_DELTA);
  dv.setFloat64(2, tsUs, false);            // big-endian timestamp µs
  dv.setFloat64(10, sentAt, false);         // big-endian sent-at ms

  const packet = new Uint8Array(18 + data.byteLength);
  packet.set(new Uint8Array(header), 0);
  packet.set(data, 18);

  api.sendChunk(packet.buffer);
  framesSent++;
}

// ── Audio (native PCM from DCSS.AudioCapture.exe) ─────────────────────────────
function startNativeAudio() {
  const SAMPLE_RATE = 48_000;
  const CHANNELS    = 2;

  try {
    audioEncoder = new AudioEncoder({
      output: onAudioEncoded,
      error: (err) => console.warn('[CaptureWorker] Audio encoder error:', err.message),
    });
    audioEncoder.configure({
      codec:            'opus',
      sampleRate:       SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate:          AUDIO_BITRATE,
    });
  } catch (err) {
    console.warn('[CaptureWorker] AudioEncoder configure failed:', err.message);
    audioEncoder = null;
    return;
  }

  api.sendMessage({ type: 'audio-config', config: { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS } });

  pcmTimestampUs = performance.now() * 1000;

  stopPcmListener = api.onAudioPcmChunk((chunk) => {
    if (!running || !audioEncoder || audioEncoder.state !== 'configured') return;
    if (audioEncoder.encodeQueueSize > 10 || transportBackpressure) return;
    try {
      const rawBytes = chunk?.byteLength ?? chunk?.length ?? 0;
      if (!rawBytes) return;
      // PCM is 16-bit stereo (s16 interleaved) from DCSS.AudioCapture.exe
      const frames = Math.floor(rawBytes / 4); // 2 channels × 2 bytes per sample
      let u8;
      if (chunk instanceof Uint8Array) u8 = chunk;
      else if (chunk?.buffer instanceof ArrayBuffer) u8 = new Uint8Array(chunk.buffer, chunk.byteOffset || 0, rawBytes);
      else u8 = new Uint8Array(chunk);

      // Resync timestamp with wall-clock if gap exceeds 150ms (prevents IPC jitter from causing micro-resyncs)
      const nowUs = performance.now() * 1000;
      if (Math.abs(nowUs - pcmTimestampUs) > 150_000) {
        pcmTimestampUs = nowUs;
      }

      const audioData = new AudioData({
        format:           's16',
        sampleRate:       SAMPLE_RATE,
        numberOfChannels: CHANNELS,
        numberOfFrames:   frames,
        timestamp:        pcmTimestampUs,
        data:             u8,
      });
      pcmTimestampUs += Math.round((frames / SAMPLE_RATE) * 1_000_000);
      try { audioEncoder.encode(audioData); } finally { audioData.close(); }
      audioChunks++;
    } catch (err) {
      console.warn('[CaptureWorker] PCM encode error:', err.message);
    }
  });
}

// ── Audio (from display media stream) ─────────────────────────────────────────
async function startAudioEncoder(track) {
  const s = track.getSettings?.() || {};
  const OPUS_RATES = new Set([8000, 12000, 16000, 24000, 48000]);
  const inputRate  = s.sampleRate || 48_000;
  const encRate    = OPUS_RATES.has(inputRate) ? inputRate : 48_000;
  const channels   = Math.min(2, s.channelCount || 2);

  try {
    audioEncoder = new AudioEncoder({
      output: onAudioEncoded,
      error: (err) => console.warn('[CaptureWorker] Audio encoder error:', err.message),
    });
    audioEncoder.configure({ codec: 'opus', sampleRate: encRate, numberOfChannels: channels, bitrate: AUDIO_BITRATE });
  } catch (err) {
    console.warn('[CaptureWorker] AudioEncoder configure failed:', err.message);
    return;
  }

  api.sendMessage({ type: 'audio-config', config: { codec: 'opus', sampleRate: encRate, numberOfChannels: channels } });

  audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const currentAudioReader = audioReader;
  const generation = captureGeneration;
  while (running && generation === captureGeneration) {
    let data;
    try {
      const { done, value } = await currentAudioReader.read();
      if (generation !== captureGeneration) { value?.close(); return; }
      if (done) break;
      data = value;
    } catch { break; }

    if (audioEncoder?.state === 'configured' && audioEncoder.encodeQueueSize <= 10 && !transportBackpressure) {
      try {
        const toEncode = (data.sampleRate === encRate)
          ? data
          : resample(data, encRate);
        audioEncoder.encode(toEncode);
        if (toEncode !== data) toEncode.close();
        data.close();
        audioChunks++;
      } catch (err) {
        console.warn('[CaptureWorker] Audio encode error:', err.message);
        data.close();
      }
    } else {
      data.close();
    }
  }
}

function onAudioEncoded(chunk) {
  if (!running) return;
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const tsUs   = chunk.timestamp ?? 0;
  const sentAt = Date.now();

  const header = new ArrayBuffer(18);
  const dv     = new DataView(header);
  dv.setUint8(0, assignedSlot);
  dv.setUint8(1, TIPO_AUDIO);
  dv.setFloat64(2, tsUs, false);
  dv.setFloat64(10, sentAt, false);

  const packet = new Uint8Array(18 + data.byteLength);
  packet.set(new Uint8Array(header), 0);
  packet.set(data, 18);
  api.sendChunk(packet.buffer);
}

function resample(audioData, targetRate) {
  const inFrames = audioData.numberOfFrames;
  const inRate   = audioData.sampleRate;
  const channels = audioData.numberOfChannels;
  const outFrames = Math.max(1, Math.round((inFrames * targetRate) / inRate));
  const buf = new Float32Array(outFrames * channels);
  const tmp = new Float32Array(inFrames);
  for (let c = 0; c < channels; c++) {
    audioData.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
    for (let i = 0; i < outFrames; i++) {
      const pos  = (i * (inFrames - 1)) / (outFrames - 1 || 1);
      const idx0 = Math.floor(pos);
      const idx1 = Math.min(idx0 + 1, inFrames - 1);
      const frac = pos - idx0;
      buf[c * outFrames + i] = tmp[idx0] * (1 - frac) + tmp[idx1] * frac;
    }
  }
  return new AudioData({
    format: 'f32-planar', sampleRate: targetRate, numberOfChannels: channels,
    numberOfFrames: outFrames, timestamp: audioData.timestamp, data: buf,
  });
}

// ── Codec negotiation ─────────────────────────────────────────────────────────
async function pickConfig(width, height, fps, bitrate) {
  for (const hw of ['prefer-hardware', 'no-preference']) {
    for (const candidate of makeCodecCandidates(width, height, fps)) {
      for (const realtime of [true, false]) {
        const cfg = {
          ...candidate,
          width, height, bitrate, framerate: fps,
          hardwareAcceleration: hw,
          latencyMode: realtime ? 'realtime' : undefined,
          bitrateMode: 'constant',
        };
        try {
          const { supported } = await VideoEncoder.isConfigSupported(cfg);
          if (supported) {
            console.info(`[CaptureWorker] Codec selected: ${cfg.codec} ${hw} realtime=${realtime}`);
            return cfg;
          }
        } catch {}
      }
    }
  }
  return null;
}

// ── Frame interval percentile helper ───────────────────────────────────────────
function calculatePercentiles(samples) {
  if (!samples.length) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))];
  return {
    p50: Number(p(0.50).toFixed(1)),
    p95: Number(p(0.95).toFixed(1)),
    p99: Number(p(0.99).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
  };
}

function adaptQuality(elapsed) {
  if (!config || !requestedQuality || encoder?.state !== 'configured') return;
  const overloaded = transportBackpressure ||
    droppedEncoderPressure > Math.max(2, framesCapture * 0.08) || encoder.encodeQueueSize > 6;
  pressureSeconds = overloaded ? pressureSeconds + elapsed : 0;
  // Only increase quality when there is evidence of headroom, not on a static screen.
  const healthy = !overloaded && framesCapture / elapsed >= Math.min(30, config.framerate * 0.6) &&
    framesEncoded >= Math.max(1, framesAdmitted) * 0.95 &&
    encoder.encodeQueueSize <= 2;
  healthySeconds = healthy ? healthySeconds + elapsed : 0;
  const nextLevel = pressureSeconds >= 3 ? Math.min(3, qualityLevel + 1)
    : healthySeconds >= 45 ? Math.max(0, qualityLevel - 1) : qualityLevel;
  if (nextLevel === qualityLevel) return;
  const scale = [1, 0.85, 2 / 3, 0.5][nextLevel];
  const fps = Math.min(requestedQuality.fps, [120, 60, 45, 30][nextLevel]);
  const width = even(Math.round(requestedQuality.width * scale));
  const height = even(Math.round(requestedQuality.height * scale));
  const size = fitWithin(srcW || width, srcH || height, width, height);
  const level = h264Level(size.width, size.height, fps).toString(16).padStart(2, '0');
  const nextConfig = {
    ...config, ...size, framerate: fps,
    bitrate: Math.max(250_000, Math.round(requestedQuality.bitrate * scale * scale * fps / requestedQuality.fps)),
    codec: config.codec.startsWith('avc1.') ? config.codec.slice(0, 9) + level : config.codec,
  };
  try {
    encoder.configure(nextConfig);
    config = nextConfig;
    targetWidth = width; targetHeight = height;
    qualityLevel = nextLevel;
    wantKeyframe = true;
    pressureSeconds = 0; healthySeconds = 0;
    api.sendMessage({ type: 'capture-config', config: {
      codec: config.codec, width: config.width, height: config.height, framerate: fps,
    } });
    // Reduce acquisition work too, where the capture backend supports it.
    stream?.getVideoTracks()[0]?.applyConstraints?.({ frameRate: { max: fps } }).catch(() => {});
  } catch (err) {
    pressureSeconds = 0; healthySeconds = 0;
    console.warn('[CaptureWorker] Quality adaptation deferred:', err.message);
  }
}

// ── Stats timer ───────────────────────────────────────────────────────────────
function startStatsTimer() {
  stopStatsTimer();
  lastStatsEmit = performance.now();
  statsTimer = setInterval(() => {
    const now = performance.now();
    const elapsed = Math.max(0.1, (now - lastStatsEmit) / 1000);
    lastStatsEmit = now;

    const percentiles = calculatePercentiles(intervalSamples);
    const avgLatency = encodeLatencySamples ? Number((totalEncodeLatencyMs / encodeLatencySamples).toFixed(2)) : 0;
    const vidTrack = stream?.getVideoTracks()[0];
    const sourceFps = vidTrack?.getSettings()?.frameRate || (config?.framerate || 60);
    adaptQuality(elapsed);

    api.sendMessage({
      type: 'capture-stats',
      stats: {
        lastFrameAt:              lastFrameWallTime,
        captureFps:               Math.round(framesCapture / elapsed),
        admittedFps:              Math.round(framesAdmitted / elapsed),
        encodedFps:               Math.round(framesEncoded / elapsed),
        sentFps:                  Math.round(framesSent / elapsed),
        requestedFps:             config?.framerate || 60,
        qualityLevel,
        targetFps:                requestedQuality?.fps || 60,
        sourceFps:                Math.round(sourceFps),
        droppedDuplicate,
        droppedObsolete,
        droppedEncoderPressure,
        droppedTransportPressure,
        droppedInvalid,
        dropCount:                droppedDuplicate + droppedObsolete + droppedEncoderPressure + droppedTransportPressure + droppedInvalid,
        encoderQueueSize:         encoder?.encodeQueueSize ?? 0,
        p50IntervalMs:            percentiles.p50,
        p95IntervalMs:            percentiles.p95,
        p99IntervalMs:            percentiles.p99,
        maxIntervalMs:            percentiles.max,
        gap25Ms:                  gap25Count,
        gap33Ms:                  gap33Count,
        gap50Ms:                  gap50Count,
        gap100Ms:                 gap100Count,
        avgEncodeLatencyMs:       avgLatency,
        codec:                    config?.codec ?? 'unknown',
        width:                    config?.width ?? 0,
        height:                   config?.height ?? 0,
        hardwareStatus:           (config?.hardwareAcceleration === 'prefer-hardware')
          ? 'Hardware requested / runtime confirmation unavailable'
          : 'Software / fallback',
        audioChunks,
        keyframeCount,
      },
    });

    framesCapture = 0; framesAdmitted = 0; framesEncoded = 0; framesSent = 0;
    droppedDuplicate = 0; droppedObsolete = 0; droppedEncoderPressure = 0; droppedTransportPressure = 0; droppedInvalid = 0;
    gap25Count = 0; gap33Count = 0; gap50Count = 0; gap100Count = 0;
    totalEncodeLatencyMs = 0; encodeLatencySamples = 0;
    audioChunks = 0;
  }, 1_000);
}

function stopStatsTimer() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
}

console.info('[CaptureWorker] Ready. Waiting for capture-start command.');

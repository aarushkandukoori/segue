// MediaRecorder wrapper for "record the set". Safe to construct anywhere: when MediaRecorder (or the
// stream) is missing, `supported` is false, start() returns false and stop() resolves an empty Blob.

const CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm'];

/** First container/codec this browser can record, or '' (let the browser choose / unsupported). */
export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const type of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* keep looking */
    }
  }
  return '';
}

/** File extension for a recorded mime type ("audio/webm;codecs=opus" → "webm"). */
export function extensionFor(mimeType) {
  if (/mp4|m4a|aac/.test(mimeType)) return 'm4a';
  if (/ogg/.test(mimeType)) return 'ogg';
  return 'webm';
}

/**
 * @param {MediaStream|null} stream  engine.recordStream()
 * @returns {{start(): boolean, stop(): Promise<Blob>, readonly recording: boolean, readonly supported: boolean, readonly mimeType: string}}
 */
export function createRecorder(stream) {
  const supported = typeof MediaRecorder !== 'undefined' && !!stream;
  let mimeType = supported ? pickMimeType() : '';
  /** @type {MediaRecorder|null} */
  let rec = null;
  let chunks = [];
  /** @type {Promise<Blob>|null} */
  let stopping = null;

  return {
    get supported() {
      return supported;
    },
    get mimeType() {
      return mimeType;
    },
    get recording() {
      return !!rec && rec.state === 'recording';
    },
    /** @returns {boolean} true if recording started */
    start() {
      if (!supported || rec) return false;
      chunks = [];
      try {
        rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch {
        try {
          rec = new MediaRecorder(stream);
        } catch {
          rec = null;
          return false;
        }
      }
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      try {
        rec.start(1000); // 1 s slices: a crash or tab close loses at most the last second
      } catch {
        rec = null;
        return false;
      }
      if (rec.mimeType) mimeType = rec.mimeType;
      return true;
    },
    /** Resolves the recording (empty Blob when nothing was recorded). Never rejects. */
    stop() {
      if (stopping) return stopping;
      if (!rec) return Promise.resolve(new Blob([], { type: mimeType || 'application/octet-stream' }));
      const active = rec;
      stopping = new Promise((resolve) => {
        const finish = () => {
          const blob = new Blob(chunks, { type: active.mimeType || mimeType || 'application/octet-stream' });
          chunks = [];
          rec = null;
          stopping = null;
          resolve(blob);
        };
        active.onstop = finish;
        active.onerror = finish;
        try {
          if (active.state === 'inactive') finish();
          else active.stop();
        } catch {
          finish();
        }
      });
      return stopping;
    },
  };
}

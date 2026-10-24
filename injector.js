/* Runs in the page's MAIN world.
 * ChatGPT sometimes plays Read Aloud audio through a detached `new Audio()` object
 * that never enters the DOM, so the isolated content script can't see it.
 * Patch HTMLMediaElement.play so any detached audio gets adopted into the DOM
 * (hidden), where the content script's MutationObserver picks it up.
 */
(() => {
  const REWIND_HISTORY_SECONDS = 60;
  const mediaSourcesByUrl = new Map();
  const mediaSourceByBuffer = new WeakMap();
  const audioByMediaSource = new WeakMap();

  // ChatGPT feeds Read Aloud through a MediaSource and continually removes
  // audio just behind the playhead. Its seekable range still starts at zero,
  // so seeking into that discarded section stalls the element. Keep a bounded
  // minute of real media available for the extension's rewind control.
  if (
    typeof MediaSource !== 'undefined' &&
    typeof SourceBuffer !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (object) {
      const url = origCreateObjectURL.apply(this, arguments);
      if (object instanceof MediaSource) mediaSourcesByUrl.set(url, object);
      return url;
    };

    const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (...args) {
      const buffer = origAddSourceBuffer.apply(this, args);
      mediaSourceByBuffer.set(buffer, this);
      return buffer;
    };

    const origRemove = SourceBuffer.prototype.remove;
    SourceBuffer.prototype.remove = function (start, end) {
      try {
        const mediaSource = mediaSourceByBuffer.get(this);
        const audio = mediaSource && audioByMediaSource.get(mediaSource);
        if (audio && Number.isFinite(audio.currentTime)) {
          const historyStart = Math.max(0, audio.currentTime - REWIND_HISTORY_SECONDS);
          const overlapsHistory = start < audio.currentTime && end > historyStart;

          if (overlapsHistory) {
            if (start < historyStart) {
              // Trim only media older than the history window.
              end = Math.min(end, historyStart);
            } else {
              // Preserve SourceBuffer's async update/updateend contract. The
              // site waits for it before appending more data, so perform a
              // harmless removal in the already-old edge of the timeline.
              start = 0;
              end = 0.001;
            }
          }
        }
      } catch (_) {
        /* fall through to the native removal */
      }
      return origRemove.call(this, start, end);
    };
  }

  // ChatGPT appends Read Aloud to its MediaSource a little ahead of the
  // playhead, so the element reports an infinite duration until the last
  // chunk is in, most of the way through playback. The download itself
  // finishes within seconds, and it is a plain ADTS stream whose frames each
  // hold a fixed number of samples, so the real length can be counted from
  // the response and handed to the content script on the element.
  const SYNTHESIZE_PATH = '/backend-api/synthesize';
  const DURATION_ATTR = 'data-cgpt-ah-duration';
  const ADTS_SAMPLE_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];
  const ADTS_HEADER_BYTES = 7;
  const SAMPLES_PER_AAC_BLOCK = 1024;

  function adtsDurationSeconds(bytes) {
    let samples = 0;
    let sampleRate = 0;
    let i = 0;
    while (i + ADTS_HEADER_BYTES <= bytes.length) {
      const isFrameStart = bytes[i] === 0xff && (bytes[i + 1] & 0xf6) === 0xf0;
      const frameBytes = isFrameStart
        ? ((bytes[i + 3] & 0x03) << 11) | (bytes[i + 4] << 3) | (bytes[i + 5] >> 5)
        : 0;
      const rate = isFrameStart ? ADTS_SAMPLE_RATES[(bytes[i + 2] >> 2) & 0x0f] : 0;
      if (frameBytes < ADTS_HEADER_BYTES || !rate) {
        i += 1;
        continue;
      }
      sampleRate = rate;
      samples += ((bytes[i + 6] & 0x03) + 1) * SAMPLES_PER_AAC_BLOCK;
      i += frameBytes;
    }
    return sampleRate ? samples / sampleRate : 0;
  }

  // Only one Read Aloud plays at a time, so the latest download belongs to
  // the latest MediaSource-backed element. Each side is tied to the other
  // once, by source URL, so a finished download is never applied to the next
  // clip when the site reuses its element.
  let synth = null;
  let streamAudio = null;
  const linkedSrcs = new Set();

  function syncDuration() {
    if (!streamAudio) return;
    const src = streamAudio.currentSrc || streamAudio.src;
    if (synth && !synth.src && src && !linkedSrcs.has(src)) {
      synth.src = src;
      linkedSrcs.add(src);
    }
    if (synth && synth.src === src && synth.seconds > 0) {
      streamAudio.setAttribute(DURATION_ATTR, String(synth.seconds));
    } else {
      streamAudio.removeAttribute(DURATION_ATTR);
    }
  }

  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const request = origFetch.apply(this, args);
      try {
        const url = String(args[0]?.url ?? args[0]);
        if (url.includes(SYNTHESIZE_PATH)) {
          const download = { src: null, seconds: 0 };
          synth = download;
          syncDuration();
          // The site receives the untouched promise; this reads a clone taken
          // before the site's own handler can consume the body.
          request
            .then((response) => (response.ok ? response.clone().arrayBuffer() : null))
            .then((buffer) => {
              if (!buffer) return;
              download.seconds = adtsDurationSeconds(new Uint8Array(buffer));
              if (download === synth) syncDuration();
            })
            .catch(() => {
              /* an aborted or failed download just leaves the length unknown */
            });
        }
      } catch (_) {
        /* never break the site's request */
      }
      return request;
    };
  }

  // Once Read Aloud starts, ChatGPT assigns `audio.onpause` a handler that
  // tears playback down (aborts the stream, clears `src`, rewinds to zero), so
  // a pause from the extension's controls left nothing to resume. The site
  // stops playback by calling that teardown directly and only reaches it
  // through `onpause` for pauses it did not start, so shadow the property on
  // the element: assignments still succeed but never register a listener.
  const pauseGuarded = new WeakSet();
  function guardPauseHandler(audio) {
    if (pauseGuarded.has(audio)) return;
    pauseGuarded.add(audio);

    let siteHandler = audio.onpause;
    audio.onpause = null;
    Object.defineProperty(audio, 'onpause', {
      configurable: true,
      enumerable: true,
      get() {
        return siteHandler;
      },
      set(handler) {
        siteHandler = typeof handler === 'function' ? handler : null;
      },
    });
  }

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      if (this.tagName === 'AUDIO' && !this.isConnected && document.body) {
        this.style.display = 'none';
        this.setAttribute('data-cgpt-ah-adopted', '1');
        document.body.appendChild(this);
      }

      // Voice mode plays a live MediaStream, which is not ours to manage.
      if (this.tagName === 'AUDIO' && !this.srcObject) guardPauseHandler(this);

      if (this.tagName === 'AUDIO') {
        const mediaSource = mediaSourcesByUrl.get(this.currentSrc || this.src);
        if (mediaSource) {
          audioByMediaSource.set(mediaSource, this);
          streamAudio = this;
          syncDuration();
        }
      }
    } catch (_) {
      /* never break playback */
    }
    return origPlay.apply(this, args);
  };
})();

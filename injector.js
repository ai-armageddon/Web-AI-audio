/* Runs in the page's MAIN world, after the site adapters in sites/.
 *
 * Sites play Read Aloud through a detached `new Audio()` object that never
 * enters the DOM, so the isolated content script can't see it. Patch
 * HTMLMediaElement.play so any detached audio gets adopted into the DOM
 * (hidden), where the content script's MutationObserver picks it up. The
 * rest keeps the element seekable, resumable and measured: see each block.
 *
 * Everything site-specific comes from the adapter's `page` block:
 *   isTtsRequest(url)             fetch requests that carry the clip, whose
 *   durationFromResponse(bytes)   body gives the clip's length in seconds
 *   isAudioSrc(src)               element sources whose length can instead be
 *   durationForSrc(src)           probed from the server, returning seconds
 */
(() => {
  const REWIND_HISTORY_SECONDS = 60;
  const DURATION_ATTR = 'data-cgpt-ah-duration';
  const ADOPTED_ATTR = 'data-cgpt-ah-adopted';
  const DURATION_PROBE_INTERVAL_MS = 2000;
  const DURATION_PROBE_ATTEMPTS = 15;

  const host = location.hostname;
  const site = (globalThis.__ahSites || []).find((s) =>
    s.hosts.some((h) => host === h || host.endsWith(`.${h}`))
  );
  if (!site) return;
  const page = site.page || {};

  const mediaSourcesByUrl = new Map();
  const mediaSourceByBuffer = new WeakMap();
  const audioByMediaSource = new WeakMap();

  // A site that feeds Read Aloud through a MediaSource may continually remove
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

  /* ---------------- clip length ---------------- */

  // A streamed clip reports an infinite duration until its last chunk is in,
  // most of the way through playback. The adapter knows where the real length
  // can be read early; it is left on the element for the content script.
  function setDuration(audio, seconds) {
    if (seconds > 0) audio.setAttribute(DURATION_ATTR, String(seconds));
    else audio.removeAttribute(DURATION_ATTR);
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
    setDuration(streamAudio, synth && synth.src === src ? synth.seconds : 0);
  }

  if (typeof page.isTtsRequest === 'function' && typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const request = origFetch.apply(this, args);
      try {
        const url = String(args[0]?.url ?? args[0]);
        if (page.isTtsRequest(url)) {
          const download = { src: null, seconds: 0 };
          synth = download;
          syncDuration();
          // The site receives the untouched promise; this reads a clone taken
          // before the site's own handler can consume the body.
          request
            .then((response) => (response.ok ? response.clone().arrayBuffer() : null))
            .then((buffer) => {
              if (!buffer) return;
              download.seconds = page.durationFromResponse(new Uint8Array(buffer));
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

  // A clip served as a plain file can be measured from the server while it
  // plays. The file may still be growing on the first probe, so keep asking
  // until the element learns its own length or the probes run out.
  const probedSrcs = new WeakMap();

  function probeDuration(audio) {
    const src = audio.currentSrc || audio.src;
    if (!src || !page.isAudioSrc(src) || probedSrcs.get(audio) === src) return;
    probedSrcs.set(audio, src);

    let attempts = 0;
    const probe = async () => {
      if ((audio.currentSrc || audio.src) !== src) return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) return;
      attempts += 1;
      try {
        const seconds = await page.durationForSrc(src);
        if ((audio.currentSrc || audio.src) === src) setDuration(audio, seconds);
      } catch (_) {
        /* a failed probe just leaves the length unknown */
      }
      if (attempts < DURATION_PROBE_ATTEMPTS) setTimeout(probe, DURATION_PROBE_INTERVAL_MS);
    };
    probe();
  }

  /* ---------------- playback hooks ---------------- */

  // Once Read Aloud starts, a site may assign `audio.onpause` a handler that
  // tears playback down (aborts the stream, clears `src`, rewinds to zero), so
  // a pause from the extension's controls would leave nothing to resume. The
  // site stops playback by calling that teardown directly and only reaches it
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
      if (this.tagName === 'AUDIO') {
        if (!this.isConnected && document.body) {
          this.style.display = 'none';
          this.setAttribute(ADOPTED_ATTR, '1');
          document.body.appendChild(this);
        }

        // Voice mode plays a live MediaStream, which is not ours to manage.
        if (!this.srcObject) guardPauseHandler(this);

        const mediaSource = mediaSourcesByUrl.get(this.currentSrc || this.src);
        if (mediaSource) {
          audioByMediaSource.set(mediaSource, this);
          streamAudio = this;
          syncDuration();
        } else if (typeof page.durationForSrc === 'function' && typeof page.isAudioSrc === 'function') {
          probeDuration(this);
        }
      }
    } catch (_) {
      /* never break playback */
    }
    return origPlay.apply(this, args);
  };
})();

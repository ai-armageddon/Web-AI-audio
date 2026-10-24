/* Site adapter: Grok (grok.com).
 *
 * Loaded ahead of injector.js in the page's MAIN world and ahead of content.js
 * in the isolated world. See sites/chatgpt.js for the shape of an adapter.
 *
 * How Grok reads a response aloud (observed October 2026):
 * - "Read Aloud" sits in each response's "More actions" menu (Radix), and the
 *   same item reads "Stop Reading" while that response plays. There is no
 *   direct button in the action row.
 * - Playback is a detached `new Audio(url)` whose source is a same-origin WAV
 *   stream at /http/app-chat/read-response-audio-file/<response id>. The
 *   response container carries that id (`#response-<id>`), which ties an
 *   element to the row it belongs to. The server honours Range requests, so
 *   seeking is native and the file's total size is in the Content-Range
 *   header long before the element learns its own duration.
 * - Pausing the element does not tear it down, and a Grok mini player (play,
 *   voice, rate, stop) appears above the composer while reading.
 */
(() => {
  'use strict';

  const TURN_SELECTOR = '[id^="response-"]';
  const ACTION_ROW_SELECTOR = '.action-buttons';
  const ASSISTANT_ROW_BUTTONS =
    'button[aria-label="Copy response" i], button[aria-label="Regenerate" i]';
  const NATIVE_PLAYER_ANCHOR = 'button[aria-label="Voice" i][aria-haspopup="menu"]';
  const AUDIO_SRC_PATTERN = /\/read-response-audio-file\/([0-9a-f-]+)/i;

  function responseIdOf(row) {
    const id = row?.closest(TURN_SELECTOR)?.id || '';
    return id.startsWith('response-') ? id.slice('response-'.length) : '';
  }

  function audioResponseId(audio) {
    const src = audio?.currentSrc || audio?.getAttribute?.('src') || '';
    return (AUDIO_SRC_PATTERN.exec(src) || [])[1] || '';
  }

  /* ---------------- Read Aloud audio (page world) ---------------- */

  // Walk the RIFF chunks in the head of the file for the format block and the
  // start of the samples. A streamed WAV carries placeholder sizes, so the
  // real length comes from the byte count the server reports instead.
  const WAV_HEADER_PROBE_BYTES = 256;

  function wavDurationSeconds(headerBytes, totalBytes) {
    const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    const tag = (offset) =>
      offset + 4 <= view.byteLength
        ? String.fromCharCode(
            view.getUint8(offset),
            view.getUint8(offset + 1),
            view.getUint8(offset + 2),
            view.getUint8(offset + 3)
          )
        : '';
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return 0;

    let byteRate = 0;
    let dataOffset = 0;
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const chunk = tag(offset);
      const size = view.getUint32(offset + 4, true);
      if (chunk === 'fmt ' && offset + 8 + 16 <= view.byteLength) {
        byteRate = view.getUint32(offset + 8 + 8, true);
      }
      if (chunk === 'data') {
        dataOffset = offset + 8;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!byteRate || !dataOffset || !(totalBytes > dataOffset)) return 0;
    return (totalBytes - dataOffset) / byteRate;
  }

  async function durationForSrc(src, fetchFn = fetch) {
    const response = await fetchFn(src, {
      headers: { Range: `bytes=0-${WAV_HEADER_PROBE_BYTES - 1}` },
    });
    if (!response.ok) return 0;
    // Content-Range carries the full size on a 206; a server that ignores the
    // range sends the whole file with its Content-Length instead.
    const total =
      response.status === 206
        ? Number((response.headers.get('content-range') || '').split('/')[1])
        : Number(response.headers.get('content-length'));
    const bytes = new Uint8Array(await response.arrayBuffer());
    return Number.isFinite(total) ? wavDurationSeconds(bytes, total) : 0;
  }

  const adapter = {
    id: 'grok',
    name: 'Grok',
    hosts: ['grok.com'],

    actionRowSelector: ACTION_ROW_SELECTOR,
    turnSelector: TURN_SELECTOR,

    // The action group wraps the buttons in a hover-revealed span; the button
    // goes in there so it shows and hides with its neighbours.
    buttonMount(row) {
      return row.querySelector(ASSISTANT_ROW_BUTTONS)?.parentElement || row;
    },

    // User turns carry Edit / Copy / Save; only Grok's replies can be
    // regenerated or have their response copied.
    isAssistantRowShape(row) {
      return Boolean(row.querySelector(ASSISTANT_ROW_BUTTONS));
    },

    assistantContentText(_row, turn, textOf) {
      const body = turn?.querySelector('.message-bubble');
      return body ? textOf(body).trim() : '';
    },

    // Read Aloud has no button of its own on Grok, so there is nothing to hide.
    findNativeReadAloudButton() {
      return null;
    },
    isNativePlaying() {
      return false;
    },

    rowOwnsAudio(row, audio) {
      const id = responseIdOf(row);
      return Boolean(id && audioResponseId(audio) === id);
    },

    findOverflowButton(scope) {
      return (
        scope.querySelector('button[aria-label="More actions" i]') ||
        Array.from(scope.querySelectorAll('button[aria-haspopup="menu"]')).pop() ||
        null
      );
    },
    readAloudMenuItem: /^\s*read aloud\s*$/i,

    // Grok's own mini player sits where the pill docks and duplicates the
    // extension's controls. Tag its pill-shaped bar for styles.css to hide.
    markNativeUi(root, attr) {
      const anchors = [
        ...(root.matches?.(NATIVE_PLAYER_ANCHOR) ? [root] : []),
        ...(root.querySelectorAll?.(NATIVE_PLAYER_ANCHOR) || []),
      ];
      anchors.forEach((anchor) => {
        const bar = anchor.closest('.rounded-full');
        if (bar && !bar.hasAttribute(attr)) bar.setAttribute(attr, '');
      });
    },

    findComposer() {
      return document.querySelector('[contenteditable="true"][role="textbox"], textarea');
    },
    chatColumn() {
      return document.querySelector('[data-transcript-renderer], main');
    },

    page: {
      isAudioSrc(src) {
        return AUDIO_SRC_PATTERN.test(src);
      },
      durationForSrc,
      // Exposed for tests.
      wavDurationSeconds,
    },
  };

  (globalThis.__ahSites = globalThis.__ahSites || []).push(adapter);
})();

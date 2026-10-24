/* Site adapter: ChatGPT (chatgpt.com).
 *
 * Loaded ahead of injector.js in the page's MAIN world and ahead of content.js
 * in the isolated world. Everything that depends on ChatGPT's DOM or on how it
 * delivers Read Aloud audio lives here, so the two core scripts stay
 * site-agnostic. The `page` block is the only part injector.js reads.
 */
(() => {
  'use strict';

  // ChatGPT currently serves two conversation renderers. The classic one uses
  // `.turn-action-controls`; the newer renderer exposes a semantic Response
  // actions group. Keep both here so DOM changes stay isolated to discovery.
  const ACTION_ROW_SELECTOR = [
    '[data-assistant-message-actions]',
    '[data-message-actions][aria-label*="response action" i]',
    '[role="group"][aria-label*="response action" i]',
    '.turn-action-controls',
  ].join(', ');
  const TURN_SELECTOR = [
    '[data-testid^="conversation-turn"]',
    'article',
    'li[data-message-role]',
    '[data-message-author-role]',
    '[data-turn]',
  ].join(', ');
  // The native button's label follows its state: "Read aloud",
  // "Loading audio…", then "Stop reading aloud" while playing.
  const NATIVE_READ_ALOUD_LABEL = /read(ing)? aloud|loading audio/i;

  function turnRole(turn) {
    return (
      turn?.getAttribute('data-message-role') ||
      turn?.getAttribute('data-turn') ||
      turn?.getAttribute('data-message-author-role') ||
      ''
    ).toLowerCase();
  }

  function findNativeReadAloudButton(scope, { btnClass }) {
    // Direct button in the action row (present on wider layouts).
    // Never match our own injected button.
    return (
      scope.querySelector(`button[data-testid="voice-play-turn-action-button"]:not(.${btnClass})`) ||
      Array.from(scope.querySelectorAll(`button:not(.${btnClass})`)).find((b) =>
        NATIVE_READ_ALOUD_LABEL.test(b.getAttribute('aria-label') || '')
      ) ||
      null
    );
  }

  // The native button is a toggle, so once the site considers a turn to be
  // playing another click on it stops playback instead of starting it.
  function isNativePlaying(button) {
    return (
      button.getAttribute('aria-pressed') === 'true' ||
      /stop/i.test(button.getAttribute('aria-label') || '')
    );
  }

  /* ---------------- Read Aloud audio (page world) ---------------- */

  // ChatGPT appends Read Aloud to its MediaSource a little ahead of the
  // playhead, so the element reports an infinite duration until the last
  // chunk is in, most of the way through playback. The download itself
  // finishes within seconds, and it is a plain ADTS stream whose frames each
  // hold a fixed number of samples, so the real length can be counted from
  // the response.
  const SYNTHESIZE_PATH = '/backend-api/synthesize';
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

  const adapter = {
    id: 'chatgpt',
    name: 'ChatGPT',
    hosts: ['chatgpt.com'],

    actionRowSelector: ACTION_ROW_SELECTOR,
    turnSelector: TURN_SELECTOR,
    // Compatibility fallback for the original renderer, whose action row had
    // no stable attribute of its own and was located through the Copy button.
    legacyAnchorSelector:
      'button[data-testid="copy-turn-action-button"], button[aria-label="Copy response" i]',

    // Whether the row belongs to an assistant turn, judged from its structure
    // alone and not from what the turn currently says.
    isAssistantRowShape(row, { nativeBtnAttr }) {
      const role = turnRole(row.closest(TURN_SELECTOR));
      if (role && role !== 'assistant') return false;
      return (
        row.hasAttribute('data-assistant-message-actions') ||
        /response action/i.test(row.getAttribute('aria-label') || '') ||
        Boolean(
          row.querySelector(
            [
              'button[data-testid="copy-turn-action-button"]',
              'button[data-testid="voice-play-turn-action-button"]',
              'button[aria-label="Copy response" i]',
              'button[aria-label="Copy" i]',
              'button[aria-label="Rate response" i]',
              'button[aria-label="Regenerate response" i]',
              `button[${nativeBtnAttr}]`,
            ].join(', ')
          )
        )
      );
    },

    assistantContentText(row, turn, textOf) {
      // Older turns put the role on the message body; the newer list renderer
      // puts the role on the <li> and marks its Markdown body explicitly.
      const content = turn?.querySelector(
        '[data-assistant-markdown], [data-message-author-role="assistant"]'
      );
      const contentText = content ? textOf(content).trim() : '';
      if (contentText) return contentText;

      // The current signed-in renderer groups a user prompt and assistant reply
      // into one turn. Its assistant attribution is a sibling of the response
      // body, while the action row sits just after that message block.
      const actionOwner = row.parentElement;
      const attribution = actionOwner?.querySelector('[data-conversation-role="assistant"]');
      if (attribution?.parentElement) {
        const text = Array.from(attribution.parentElement.children)
          .filter((element) => element !== attribution)
          .map(textOf)
          .join(' ')
          .trim();
        if (text) return text;
      }

      // Some variants expose only the role on the turn. Remove the accessible
      // attribution before checking its text so an empty/image-only response is
      // not mistaken for readable content.
      if (turnRole(turn) === 'assistant') {
        return Array.from(turn.children)
          .filter(
            (element) =>
              element !== row &&
              !element.matches(ACTION_ROW_SELECTOR) &&
              !element.matches('[data-message-attribution], [data-conversation-role="assistant"]')
          )
          .map(textOf)
          .join(' ')
          .replace(/^\s*chatgpt said:\s*/i, '')
          .trim();
      }
      return '';
    },

    findNativeReadAloudButton,
    isNativePlaying,

    // This turn is already loaded (playing or paused) when the site's own
    // toggle shows its playing state and the element still has a source.
    rowOwnsAudio(row, audio, ctx) {
      const native = findNativeReadAloudButton(row, ctx);
      return Boolean(native && isNativePlaying(native) && audio?.hasAttribute('src'));
    },

    findOverflowButton(scope) {
      return (
        scope.querySelector('button[data-testid="more-actions-button"]') ||
        scope.querySelector('button[aria-label*="more" i][aria-haspopup]') ||
        Array.from(scope.querySelectorAll('button[aria-haspopup="menu"]')).pop() ||
        null
      );
    },
    readAloudMenuItem: /read aloud/i,

    findComposer() {
      return document.querySelector(
        '#prompt-textarea, textarea, [contenteditable="true"][role="textbox"]'
      );
    },
    // The conversation column: the pill re-centres on it when the sidebar or
    // canvas changes its width.
    chatColumn() {
      return document.querySelector('main');
    },

    page: {
      isTtsRequest(url) {
        return url.includes(SYNTHESIZE_PATH);
      },
      durationFromResponse: adtsDurationSeconds,
    },
  };

  (globalThis.__ahSites = globalThis.__ahSites || []).push(adapter);
})();

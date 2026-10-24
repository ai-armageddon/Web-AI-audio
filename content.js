/* ChatGPT-web-audio — content script
 * 1. Injects a speaker button into playable assistant text response action rows.
 * 2. Clicking it triggers the site's native "Read Aloud" (directly or via the overflow menu).
 * 3. Hijacks the native <audio> element and routes control to a floating, draggable media panel.
 * 4. Persists playback speed and panel position in chrome.storage.local.
 *
 * Everything that depends on a particular site's DOM comes from the adapter
 * in sites/ that registered for this hostname; see sites/chatgpt.js for the
 * contract. This file never names a site.
 */
(() => {
  'use strict';

  const host = location.hostname;
  const SITE = (globalThis.__ahSites || []).find((s) =>
    s.hosts.some((h) => host === h || host.endsWith(`.${h}`))
  );
  if (!SITE) return;

  const BTN_CLASS = 'cgpt-audio-hijacker-btn';
  const NATIVE_BTN_ATTR = 'data-cgpt-ah-native';
  const NATIVE_PLAYER_ATTR = 'data-cgpt-ah-native-player';
  // Handed to adapter hooks that must tell the site's elements from ours.
  const SITE_CTX = { btnClass: BTN_CLASS, nativeBtnAttr: NATIVE_BTN_ATTR };
  const PANEL_ID = 'cgpt-audio-hijacker-panel';
  const SPEED_OPTIONS = [1, 1.25, 1.5, 1.75, 2];
  const DEFAULT_SPEED = 1.5;
  const STORAGE_KEYS = {
    speed: 'preferredSpeed',
    pos: 'panelPosition',
    mode: 'uiMode',
    pillPos: 'pillPosition',
    pillSize: 'pillSize',
    shortcuts: 'keyboardShortcuts',
  };
  const ONBOARD_KEY = 'onboardingPending';
  const PILL_DOCK_ID = 'cgpt-ah-pilldock';
  const PILL_MAX_WIDTH = 460;
  const PILL_MIN_WIDTH = 280;
  const PILL_COMPACT_WIDTH = 380;
  // Clearance kept between the pill and whatever it floats above, so it does
  // not sit on top of the composer or the message action row.
  const PILL_GAP = 6;
  const RESCAN_DELAY_MS = 150;
  // Set by injector.js on a streamed <audio> once its real length is known.
  const DURATION_ATTR = 'data-cgpt-ah-duration';
  const UNKNOWN_TIME = '--:--';
  const RING_R = 23;
  const RING_C = 2 * Math.PI * RING_R;
  const FINE_POINTER = window.matchMedia('(hover: hover) and (pointer: fine)');
  // Browser zoom reduces the CSS viewport, just like a small window. Keep a
  // reachable transport when the response actions or saved panel no longer fit.
  const COMPACT_VIEWPORT = window.matchMedia('(max-width: 768px), (max-height: 480px)');
  const ACTION_ROW_SELECTOR = SITE.actionRowSelector;
  const TURN_SELECTOR = SITE.turnSelector;

  let preferredSpeed = DEFAULT_SPEED;
  let activeAudio = null;
  let panel = null;
  let ui = {};
  let savedPanelPos = null;
  let uiMode = 'panel';
  let pillPosition = 'bottom';
  let pillSize = 'medium';
  let keyboardShortcuts = {
    toggle: 'Alt+Space',
    back: 'Alt+ArrowLeft',
    forward: 'Alt+ArrowRight',
  };
  let pillDock = null;
  let pillUi = {};
  let pillExpanded = false;
  let pillHovered = false;
  let pillPinned = false;
  let pillPosTimer = null;
  let pillResizeObserver = null;
  let pillResizeTarget = null;

  /* ---------------- storage ---------------- */

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [
          STORAGE_KEYS.speed,
          STORAGE_KEYS.pos,
          STORAGE_KEYS.mode,
          STORAGE_KEYS.pillPos,
          STORAGE_KEYS.pillSize,
          STORAGE_KEYS.shortcuts,
          ONBOARD_KEY,
        ],
        (res) => {
          if (typeof res[STORAGE_KEYS.speed] === 'number') {
            preferredSpeed = res[STORAGE_KEYS.speed];
          }
          resolve({
            pos: res[STORAGE_KEYS.pos] || null,
            mode:
              res[STORAGE_KEYS.mode] === 'panel' || res[STORAGE_KEYS.mode] === 'pill'
                ? res[STORAGE_KEYS.mode]
                : null,
            pillPos:
              res[STORAGE_KEYS.pillPos] === 'top' || res[STORAGE_KEYS.pillPos] === 'bottom'
                ? res[STORAGE_KEYS.pillPos]
                : null,
            pillSize: ['small', 'medium', 'large'].includes(res[STORAGE_KEYS.pillSize])
              ? res[STORAGE_KEYS.pillSize]
              : null,
            shortcuts:
              res[STORAGE_KEYS.shortcuts] && typeof res[STORAGE_KEYS.shortcuts] === 'object'
                ? res[STORAGE_KEYS.shortcuts]
                : null,
            onboardingPending: res[ONBOARD_KEY] === true,
          });
        }
      );
    });
  }

  function saveSpeed(speed) {
    preferredSpeed = speed;
    chrome.storage.local.set({ [STORAGE_KEYS.speed]: speed });
  }

  function savePosition(top, left) {
    savedPanelPos = { top, left };
    chrome.storage.local.set({ [STORAGE_KEYS.pos]: savedPanelPos });
  }

  /* ---------------- native Read Aloud trigger ---------------- */

  // Radix UI buttons/menus often ignore plain .click();
  // dispatch a full pointer-event sequence instead.
  function simulateClick(el) {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function findNativeReadAloudButton(scope) {
    return SITE.findNativeReadAloudButton(scope, SITE_CTX);
  }

  // Our button replaces the site's own. The native one has to stay in the DOM
  // (clicking it is how playback starts), so tag it and let styles.css hide it;
  // the tag survives the label changing between its states.
  function hideNativeReadAloud(row) {
    const native = findNativeReadAloudButton(row);
    if (native && !native.hasAttribute(NATIVE_BTN_ATTR)) native.setAttribute(NATIVE_BTN_ATTR, '');
  }

  // Some sites show a player of their own while reading. The adapter tags it
  // and styles.css hides it, the same way as the native button.
  function hideNativePlayer(root) {
    SITE.markNativeUi?.(root, NATIVE_PLAYER_ATTR);
  }

  function clickMenuItemReadAloud() {
    // Radix menus render in a portal at document.body level.
    const items = document.querySelectorAll('[role="menuitem"], [role="option"]');
    for (const item of items) {
      if (SITE.readAloudMenuItem.test(item.textContent || '')) {
        simulateClick(item);
        return true;
      }
    }
    return false;
  }

  function triggerReadAloud(actionRow) {
    const scope = actionRow.closest(TURN_SELECTOR) || actionRow;

    const direct = findNativeReadAloudButton(scope);
    if (direct) {
      simulateClick(direct);
      return;
    }

    // Fall back: open the three-dot overflow menu, then click "Read aloud".
    const overflow = SITE.findOverflowButton(scope);
    if (!overflow) return;
    simulateClick(overflow);

    let attempts = 0;
    const poll = setInterval(() => {
      attempts += 1;
      if (clickMenuItemReadAloud() || attempts > 20) {
        clearInterval(poll);
        if (attempts > 20) {
          // Close the menu again if we never found the item.
          document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
          );
        }
      }
    }, 50);
  }

  /* ---------------- button injection ---------------- */

  // The artwork is a raster image, so the button holds an empty element that
  // styles.css paints with it.
  const BTN_ICON_HTML = '<span class="cgpt-ah-icon" aria-hidden="true"></span>';

  const GRIP_SVG =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>';

  const SPINNER_HTML = '<span class="cgpt-ah-spinner" aria-hidden="true"></span>';

  // The skip interval is drawn inside the arc: a label layered over the arrow
  // is unreadable and collides with the icon at these button sizes.
  const skipSvg = (paths) =>
    `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}<text class="cgpt-ah-skip-num" x="12" y="12">10</text></svg>`;

  const SKIP_BACK_SVG = skipSvg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>');
  const SKIP_FWD_SVG = skipSvg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>');

  /* Loading state on the injected button while Read Aloud fetches audio */
  let loadingBtn = null;
  let loadingTimer = null;

  function setBtnLoading(btn) {
    clearBtnLoading();
    loadingBtn = btn;
    btn.classList.add('cgpt-ah-loading');
    btn.innerHTML = SPINNER_HTML;
    // Safety net in case playback never starts (e.g. Read Aloud failed).
    loadingTimer = setTimeout(clearBtnLoading, 8000);
  }

  function clearBtnLoading() {
    if (loadingTimer) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
    if (loadingBtn) {
      loadingBtn.classList.remove('cgpt-ah-loading');
      loadingBtn.innerHTML = BTN_ICON_HTML;
      loadingBtn = null;
    }
  }

  const renderedText = (element) => element.innerText || '';
  const sourceText = (element) => element.textContent || '';

  function assistantContentText(row, turn, textOf = renderedText) {
    return SITE.assistantContentText(row, turn, textOf) || '';
  }

  // Whether the row belongs to an assistant turn, judged from its structure
  // alone and not from what the turn currently says.
  function isAssistantRowShape(row) {
    return Boolean(row) && SITE.isAssistantRowShape(row, SITE_CTX);
  }

  function isAssistantActionRow(row) {
    // Read Aloud is only available when the assistant turn contains readable
    // text. Image-only generations can still receive an action row.
    return (
      isAssistantRowShape(row) &&
      Boolean(assistantContentText(row, row.closest(TURN_SELECTOR)))
    );
  }

  // innerText is empty for text that exists but is not being rendered at this
  // instant, which is different from a reply with nothing to read. A row in
  // that state keeps whatever it already has: it must not lose its button, or
  // ChatGPT's own button would resurface in its place.
  function hasUnrenderedText(row) {
    return (
      isAssistantRowShape(row) &&
      Boolean(assistantContentText(row, row.closest(TURN_SELECTOR), sourceText))
    );
  }

  function candidateRows(root) {
    const rows = new Set();
    if (root.matches?.(ACTION_ROW_SELECTOR)) rows.add(root);
    const containingRow = root.closest?.(ACTION_ROW_SELECTOR);
    if (containingRow) rows.add(containingRow);
    root.querySelectorAll?.(ACTION_ROW_SELECTOR).forEach((row) => rows.add(row));

    // Some renderers give the action row no stable attribute of its own; the
    // adapter then names a button whose parent is the row.
    const legacyAnchorSelector = SITE.legacyAnchorSelector;
    if (legacyAnchorSelector) {
      const legacyAnchors = [
        ...(root.matches?.(legacyAnchorSelector) ? [root] : []),
        ...(root.querySelectorAll?.(legacyAnchorSelector) || []),
      ];
      legacyAnchors.forEach((button) => rows.add(button.parentElement));
    }
    return rows;
  }

  function findActionRows(root) {
    const rows = candidateRows(root);
    for (const row of rows) {
      if (isAssistantActionRow(row)) continue;
      rows.delete(row);
      if (hasUnrenderedText(row)) continue;
      // Clean up a button injected before a turn's role/content was available,
      // or when the site reuses DOM while navigating between conversations.
      row?.querySelector(`.${BTN_CLASS}`)?.remove();
      row?.querySelector(`[${NATIVE_BTN_ATTR}]`)?.removeAttribute(NATIVE_BTN_ATTR);
    }
    return rows;
  }

  function injectButton(row) {
    if (row.querySelector(`.${BTN_CLASS}`)) return;
    const btn = document.createElement('button');
    btn.className = BTN_CLASS;
    btn.type = 'button';
    btn.title = 'Play audio';
    btn.setAttribute('aria-label', 'Play audio with floating player');
    btn.innerHTML = BTN_ICON_HTML;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // This turn is already loaded (playing or paused): resume or pause it
      // rather than clicking the native toggle, which would stop it.
      if (activeAudio && SITE.rowOwnsAudio(row, activeAudio, SITE_CTX)) {
        togglePlay();
        return;
      }
      setBtnLoading(btn);
      triggerReadAloud(row);
    });
    const mount = SITE.buttonMount?.(row) || row;
    mount.insertBefore(btn, mount.firstChild);
  }

  function scanAndInject(root) {
    findActionRows(root).forEach((row) => {
      injectButton(row);
      hideNativeReadAloud(row);
    });
    hideNativePlayer(root);
  }

  // Page-wide pass that only ever adds: rows that already carry our button are
  // left alone, so it stays cheap enough to run while a reply is streaming.
  function restoreMissingButtons() {
    for (const row of candidateRows(document.body)) {
      if (!row) continue;
      if (!row.querySelector(`.${BTN_CLASS}`)) {
        if (!isAssistantActionRow(row)) continue;
        injectButton(row);
      }
      hideNativeReadAloud(row);
    }
    hideNativePlayer(document.body);
  }

  /* ---------------- audio hijacking ---------------- */

  function hijackAudio(audio) {
    if (audio.dataset.cgptHijacked) return;
    audio.dataset.cgptHijacked = '1';

    activeAudio = audio;
    audio.controls = false; // keep the site's layout hidden
    applyPreferredSpeed(audio);
    bindAudioToPanel(audio);
    if (!audio.paused) {
      setPlayIcon(false);
      showPanel();
    }
  }

  function applyPreferredSpeed(audio) {
    if (Math.abs(audio.playbackRate - preferredSpeed) > 0.001) {
      audio.playbackRate = preferredSpeed;
    }
  }

  function bindAudioToPanel(audio) {
    const onLoaded = () => {
      applyPreferredSpeed(audio);
      updateTimeline();
    };
    const onPlay = () => {
      activeAudio = audio;
      applyPreferredSpeed(audio);
      clearBtnLoading();
      setPlayIcon(false);
      updateLoopBtn();
      showPanel();
    };
    const onPause = () => {
      if (audio === activeAudio) setPlayIcon(true);
    };
    const onTime = () => {
      if (audio === activeAudio) updateTimeline();
    };
    const onRateChange = () => {
      // Sticky speed: never let the site reset us to 1x.
      if (audio === activeAudio) applyPreferredSpeed(audio);
    };
    const onEnded = () => {
      if (audio === activeAudio) {
        setPlayIcon(true);
        updateLoopBtn();
      }
    };

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('durationchange', onLoaded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('playing', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ratechange', onRateChange);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('emptied', onEnded);
    // The streamed length arrives on its own schedule, possibly while paused.
    new MutationObserver(onTime).observe(audio, {
      attributes: true,
      attributeFilter: [DURATION_ATTR],
    });
  }

  function hijackExistingAudio(root) {
    root.querySelectorAll('audio').forEach(hijackAudio);
  }

  /* ---------------- floating media panel ---------------- */

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function setPlayIcon(showPlay) {
    if (ui.playBtn) {
      ui.playBtn.innerHTML = showPlay
        ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>'
        : '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>';
    }
    // Collapsed pill cross-fades between the animated waveform and a play icon.
    if (pillDock) {
      pillDock.classList.toggle('cgpt-ah-playing', !showPlay);
      refreshPillExpanded();
    }
  }

  function updateSpeedBtn() {
    if (!ui.speedBtn) return;
    ui.speedBtn.textContent = `${preferredSpeed}x`;
    ui.speedBtn.setAttribute(
      'aria-label',
      `Playback speed ${preferredSpeed}x, click to cycle`
    );
  }

  function updateLoopBtn() {
    if (!ui.loopBtn) return;
    const enabled = Boolean(activeAudio?.loop);
    ui.loopBtn.classList.toggle('cgpt-ah-loop-active', enabled);
    ui.loopBtn.setAttribute('aria-pressed', String(enabled));
    ui.loopBtn.setAttribute('title', enabled ? 'Loop playback on' : 'Loop playback off');
  }

  // Read Aloud is streamed, so the element reports an infinite duration for
  // most of playback. injector.js works the real length out from the download
  // and leaves it on the element; until that lands the length is unknown.
  function totalDuration(audio) {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    const streamed = parseFloat(audio.getAttribute(DURATION_ATTR));
    return Number.isFinite(streamed) && streamed > 0 ? streamed : null;
  }

  function updateTimeline() {
    if (!activeAudio || !ui.scrubber) return;
    const { currentTime } = activeAudio;
    const duration = totalDuration(activeAudio);
    const progress = duration ? Math.min(1, currentTime / duration) : 0;
    ui.current.textContent = fmtTime(currentTime);
    ui.total.textContent = duration ? fmtTime(duration) : UNKNOWN_TIME;
    if (!ui.scrubber.matches(':active')) {
      const pct = progress * 100;
      ui.scrubber.value = String(pct);
      ui.scrubber.style.setProperty('--ah-pct', `${pct}%`);
    }
    if (pillUi.ringFg) {
      pillUi.ringFg.style.strokeDashoffset = String(RING_C * (1 - progress));
    }
  }

  function buildPanel(savedPos) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="cgpt-ah-header">
        <span class="cgpt-ah-grip">${GRIP_SVG}</span>
        <span class="cgpt-ah-title">ChatGPT Audio</span>
        <button class="cgpt-ah-close" title="Hide panel" aria-label="Hide panel">×</button>
      </div>
      <div class="cgpt-ah-timeline">
        <span class="cgpt-ah-current">0:00</span>
        <input class="cgpt-ah-scrubber" type="range" min="0" max="100" step="0.1" value="0" aria-label="Seek" />
        <span class="cgpt-ah-total">0:00</span>
      </div>
      <div class="cgpt-ah-controls">
        <button class="cgpt-ah-back" title="Back 10s" aria-label="Skip back 10 seconds">${SKIP_BACK_SVG}</button>
        <button class="cgpt-ah-play" title="Play / Pause" aria-label="Play or pause"></button>
        <button class="cgpt-ah-fwd" title="Forward 10s" aria-label="Skip forward 10 seconds">${SKIP_FWD_SVG}</button>
        <button class="cgpt-ah-loop" type="button" title="Loop playback off" aria-label="Loop playback" aria-pressed="false">↻<span>Loop</span></button>
        <button class="cgpt-ah-speed" type="button" title="Playback speed (click to cycle)"></button>
      </div>
    `;
    document.documentElement.appendChild(panel);

    ui = {
      header: panel.querySelector('.cgpt-ah-header'),
      closeBtn: panel.querySelector('.cgpt-ah-close'),
      current: panel.querySelector('.cgpt-ah-current'),
      total: panel.querySelector('.cgpt-ah-total'),
      scrubber: panel.querySelector('.cgpt-ah-scrubber'),
      backBtn: panel.querySelector('.cgpt-ah-back'),
      playBtn: panel.querySelector('.cgpt-ah-play'),
      fwdBtn: panel.querySelector('.cgpt-ah-fwd'),
      loopBtn: panel.querySelector('.cgpt-ah-loop'),
      speedBtn: panel.querySelector('.cgpt-ah-speed'),
    };

    // Speed pill: click cycles through SPEED_OPTIONS
    updateSpeedBtn();
    updateLoopBtn();
    setPlayIcon(true);
    wireTransportControls();

    // Restore saved position
    if (savedPos && typeof savedPos.top === 'number' && typeof savedPos.left === 'number') {
      applyPosition(savedPos.top, savedPos.left);
    }

    makeDraggable();
    // Panel starts hidden via CSS; showPanel() adds .cgpt-ah-visible.
  }

  function applyPosition(top, left) {
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth - 4);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight - 4);
    panel.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function makeDraggable() {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    ui.header.addEventListener('mousedown', (e) => {
      if (e.target === ui.closeBtn) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      panel.classList.add('cgpt-ah-dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      applyPosition(e.clientY - offsetY, e.clientX - offsetX);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('cgpt-ah-dragging');
      const rect = panel.getBoundingClientRect();
      savePosition(Math.round(rect.top), Math.round(rect.left));
    });
  }

  function togglePlay() {
    if (!activeAudio || !(activeAudio.currentSrc || activeAudio.getAttribute('src'))) {
      const rows = Array.from(candidateRows(document.body)).filter((row) =>
        isAssistantActionRow(row) || hasUnrenderedText(row)
      );
      const row = rows[rows.length - 1];
      if (row) {
        const button = row.querySelector(`.${BTN_CLASS}`);
        if (button) setBtnLoading(button);
        triggerReadAloud(row);
      }
      return;
    }
    if (activeAudio.paused) activeAudio.play();
    else activeAudio.pause();
  }

  function cycleSpeed() {
    const idx = SPEED_OPTIONS.indexOf(preferredSpeed);
    const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    saveSpeed(next);
    updateSpeedBtn();
    if (activeAudio) activeAudio.playbackRate = next;
  }

  function toggleLoop() {
    if (!activeAudio) return;
    activeAudio.loop = !activeAudio.loop;
    updateLoopBtn();
  }

  function clampToBuffered(audio, time) {
    const ranges = audio.buffered;
    if (!ranges?.length) return time;

    let closest = null;
    let closestDistance = Infinity;

    try {
      for (let i = 0; i < ranges.length; i += 1) {
        const start = ranges.start(i);
        const end = ranges.end(i);
        // Stay slightly inside a range: seeking to its exact end can stall
        // while the next streaming chunk is being appended.
        const safeStart = Math.min(end, start + 0.01);
        const safeEnd = Math.max(safeStart, end - 0.01);
        if (time >= safeStart && time <= safeEnd) return time;

        for (const boundary of [safeStart, safeEnd]) {
          const distance = Math.abs(time - boundary);
          if (distance < closestDistance) {
            closest = boundary;
            closestDistance = distance;
          }
        }
      }
    } catch (_) {
      // A live TimeRanges object can change while it is being read.
      return time;
    }

    return closest ?? time;
  }

  function seekLimit(audio) {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;

    // Streaming media can report an infinite/unknown duration while still
    // exposing a seekable range. Use the latest available range in that case.
    const ranges = audio.seekable;
    if (ranges?.length) {
      try {
        return ranges.end(ranges.length - 1);
      } catch (_) {
        // The range may change between reading length and end(); seeking below
        // still works without an upper clamp.
      }
    }
    return null;
  }

  function seekTo(time) {
    if (!activeAudio || !Number.isFinite(time)) return false;

    const audio = activeAudio;
    const upper = seekLimit(audio);
    const limited = Math.max(0, upper === null ? time : Math.min(upper, time));
    const target = clampToBuffered(audio, limited);

    try {
      audio.currentTime = target;
      updateTimeline();
      return true;
    } catch (_) {
      // Metadata may not be ready on the first interaction. Retry once as soon
      // as the media becomes seekable rather than silently dropping the click.
      audio.addEventListener('loadedmetadata', () => {
        if (audio === activeAudio) seekTo(target);
      }, { once: true });
      return false;
    }
  }

  function seekBy(seconds) {
    if (!activeAudio) return false;
    const current = Number.isFinite(activeAudio.currentTime) ? activeAudio.currentTime : 0;
    return seekTo(current + seconds);
  }

  // Transport wiring shared by the floating panel and the micro pill: both
  // UIs populate the same `ui` refs, so one set of handlers serves either.
  function wireTransportControls() {
    ui.speedBtn.addEventListener('click', cycleSpeed);
    ui.playBtn.addEventListener('click', togglePlay);
    ui.backBtn.addEventListener('click', () => seekBy(-10));
    ui.fwdBtn.addEventListener('click', () => seekBy(10));
    ui.loopBtn.addEventListener('click', toggleLoop);
    ui.scrubber.addEventListener('input', () => {
      // Keep the progress fill in sync while dragging.
      ui.scrubber.style.setProperty('--ah-pct', `${ui.scrubber.value}%`);
      const duration = activeAudio && totalDuration(activeAudio);
      if (duration) seekTo((parseFloat(ui.scrubber.value) / 100) * duration);
    });
    ui.closeBtn.addEventListener('click', hidePanel);
  }

  /* ---------------- micro pill player ---------------- */

  function usesPill() {
    return COMPACT_VIEWPORT.matches || uiMode === 'pill';
  }

  function activeUiRoot() {
    return usesPill() ? pillDock : panel;
  }

  function showPanel() {
    const root = activeUiRoot();
    if (!root) return;
    root.classList.add('cgpt-ah-visible');
    if (usesPill()) {
      startPillPositioning();
      refreshPillExpanded();
    }
  }

  function hidePanel() {
    if (COMPACT_VIEWPORT.matches) return;
    const root = activeUiRoot();
    if (!root) return;
    root.classList.remove('cgpt-ah-visible');
    if (usesPill()) {
      pillHovered = false;
      pillPinned = false;
      setPillExpanded(false);
      stopPillPositioning();
    }
  }

  function applyUiMode() {
    const wasVisible = (panel || pillDock)?.classList.contains('cgpt-ah-visible');
    stopPillPositioning();
    if (panel) {
      panel.remove();
      panel = null;
    }
    if (pillDock) {
      pillDock.remove();
      pillDock = null;
    }
    // The pill is rebuilt from scratch, so its interaction state has to reset
    // with it or setPillExpanded() would skip the fresh element.
    document.removeEventListener('pointerdown', onPillOutsidePointer, true);
    pillExpanded = false;
    pillHovered = false;
    pillPinned = false;
    ui = {};
    pillUi = {};

    if (usesPill()) buildPill();
    else buildPanel(savedPanelPos);

    // Re-sync the fresh UI with whatever the audio is doing right now.
    updateSpeedBtn();
    updateTimeline();
    setPlayIcon(!isPlaying());
    updateLoopBtn();
    if (COMPACT_VIEWPORT.matches || isPlaying() || (wasVisible && activeAudio)) showPanel();
  }

  function buildPill() {
    pillDock = document.createElement('div');
    pillDock.id = PILL_DOCK_ID;
    pillDock.classList.add(
      pillPosition === 'top' ? 'cgpt-ah-pos-top' : 'cgpt-ah-pos-bottom',
      `cgpt-ah-pill-size-${pillSize}`
    );
    pillDock.classList.toggle('cgpt-ah-compact-viewport', COMPACT_VIEWPORT.matches);
    // The expanded row is a 1fr / auto / 1fr grid so the play button lands on
    // the pill's exact center — the same point the collapsed ball occupies.
    // Hovering therefore grows the pill *around* the pointer instead of moving
    // the button out from under it.
    pillDock.innerHTML = `
      <div class="cgpt-ah-pill">
        <button class="cgpt-ah-ball" type="button" title="Play / pause" aria-label="Audio player" aria-expanded="false">
          <svg class="cgpt-ah-ring" viewBox="0 0 52 52" aria-hidden="true">
            <circle class="cgpt-ah-ring-bg" cx="26" cy="26" r="${RING_R}"></circle>
            <circle class="cgpt-ah-ring-fg" cx="26" cy="26" r="${RING_R}"></circle>
          </svg>
          <span class="cgpt-ah-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span class="cgpt-ah-ball-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4"/></svg>
          </span>
        </button>
        <div class="cgpt-ah-controls cgpt-ah-pill-controls">
          <div class="cgpt-ah-pill-side">
            <span class="cgpt-ah-pill-time">
              <span class="cgpt-ah-current">0:00</span>
              <span class="cgpt-ah-sep">/</span>
              <span class="cgpt-ah-total">0:00</span>
            </span>
            <button class="cgpt-ah-speed" type="button" title="Playback speed (click to cycle)"></button>
          </div>
          <div class="cgpt-ah-pill-center">
            <button class="cgpt-ah-back" title="Back 10s" aria-label="Skip back 10 seconds">${SKIP_BACK_SVG}</button>
            <button class="cgpt-ah-play" title="Play / Pause" aria-label="Play or pause"></button>
            <button class="cgpt-ah-fwd" title="Forward 10s" aria-label="Skip forward 10 seconds">${SKIP_FWD_SVG}</button>
          </div>
          <div class="cgpt-ah-pill-side cgpt-ah-pill-side-end">
            <button class="cgpt-ah-loop" type="button" title="Loop playback off" aria-label="Loop playback" aria-pressed="false">↻<span>Loop</span></button>
            <button class="cgpt-ah-close" title="Hide player" aria-label="Hide player">×</button>
          </div>
        </div>
        <div class="cgpt-ah-pill-timeline">
          <input class="cgpt-ah-scrubber" type="range" min="0" max="100" step="0.1" value="0" aria-label="Seek" />
        </div>
      </div>
    `;
    document.documentElement.appendChild(pillDock);

    pillUi = {
      pill: pillDock.querySelector('.cgpt-ah-pill'),
      ball: pillDock.querySelector('.cgpt-ah-ball'),
      ringFg: pillDock.querySelector('.cgpt-ah-ring-fg'),
    };
    ui = {
      closeBtn: pillDock.querySelector('.cgpt-ah-close'),
      current: pillDock.querySelector('.cgpt-ah-current'),
      total: pillDock.querySelector('.cgpt-ah-total'),
      scrubber: pillDock.querySelector('.cgpt-ah-scrubber'),
      backBtn: pillDock.querySelector('.cgpt-ah-back'),
      playBtn: pillDock.querySelector('.cgpt-ah-play'),
      fwdBtn: pillDock.querySelector('.cgpt-ah-fwd'),
      loopBtn: pillDock.querySelector('.cgpt-ah-loop'),
      speedBtn: pillDock.querySelector('.cgpt-ah-speed'),
    };

    updateSpeedBtn();
    updateLoopBtn();
    setPlayIcon(true);
    wireTransportControls();
    wirePillExpand();
    refreshPillExpanded();
    positionPill();
  }

  // Hover expands the ball into the full pill on desktops; on touch devices a
  // tap expands it and an outside tap (or the × button) collapses it again.
  function wirePillExpand() {
    pillDock.addEventListener('mouseenter', () => {
      if (!FINE_POINTER.matches) return;
      pillHovered = true;
      refreshPillExpanded();
    });
    pillDock.addEventListener('mouseleave', () => {
      pillHovered = false;
      refreshPillExpanded();
    });
    pillUi.ball.addEventListener('click', () => {
      // The play button sits exactly where the ball is, so on hover-capable
      // pointers a ball click is always "play/pause"; touch taps open the row.
      if (FINE_POINTER.matches) {
        togglePlay();
      } else {
        pillPinned = true;
        refreshPillExpanded();
      }
    });
  }

  function isPlaying() {
    return Boolean(activeAudio && !activeAudio.paused && !activeAudio.ended);
  }

  // The pill stays open while audio plays (transport always one click away),
  // while it is hovered, and while a touch user has tapped it open.
  function refreshPillExpanded() {
    if (!usesPill() || !pillDock) return;
    setPillExpanded(COMPACT_VIEWPORT.matches || pillPosition === 'top' || pillHovered || pillPinned || isPlaying());
  }

  function setPillExpanded(expanded) {
    if (!pillDock || expanded === pillExpanded) return;
    pillExpanded = expanded;
    pillDock.classList.toggle('cgpt-ah-expanded', expanded);
    pillUi.ball.setAttribute('aria-expanded', String(expanded));
    if (expanded) document.addEventListener('pointerdown', onPillOutsidePointer, true);
    else document.removeEventListener('pointerdown', onPillOutsidePointer, true);
  }

  function onPillOutsidePointer(e) {
    if (!pillDock || pillDock.contains(e.target)) return;
    pillPinned = false;
    refreshPillExpanded();
  }

  function findScrollDownButton() {
    const candidates = Array.from(document.querySelectorAll(
      'button[data-testid*="scroll" i], button[aria-label*="scroll" i]'
    ));

    // Avoid matching unrelated scroll controls in the sidebar or dialogs.
    return candidates.find((button) => {
      const label = `${button.getAttribute('data-testid') || ''} ${button.getAttribute('aria-label') || ''}`;
      const rect = button.getBoundingClientRect();
      return /scroll.*(bottom|down)|(bottom|down).*scroll/i.test(label) &&
        rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.top < window.innerHeight;
    }) || null;
  }

  function findComposer() {
    return SITE.findComposer();
  }

  // Sites center the composer inside the conversation column, so its box is
  // the best proxy for "the middle of the chat" — unlike the viewport center it
  // moves when the sidebar opens or closes.
  function composerRect() {
    const composer = findComposer();
    const rect = (composer?.closest('form') || composer)?.getBoundingClientRect();
    return rect && rect.width > 120 ? rect : null;
  }

  // Re-centre whenever the conversation column resizes (sidebar toggles,
  // canvas opens) instead of waiting for the slow polling fallback.
  function observeChatResize() {
    const target = SITE.chatColumn();
    if (!target || target === pillResizeTarget) return;
    if (!pillResizeObserver) pillResizeObserver = new ResizeObserver(() => positionPill());
    pillResizeObserver.disconnect();
    pillResizeObserver.observe(target);
    pillResizeTarget = target;
  }

  function positionPill() {
    if (!pillDock || !pillUi.pill) return;
    observeChatResize();

    const height =
      parseFloat(getComputedStyle(pillUi.pill).getPropertyValue('--ah-pill-height')) || 64;
    const composer = composerRect();
    if (COMPACT_VIEWPORT.matches) {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      const width = Math.max(0, Math.min(PILL_MAX_WIDTH, (viewport?.width || window.innerWidth) - 16));
      const bottom = top + (viewport?.height || window.innerHeight);
      // Stay above the composer where possible; clamp both edges when zoom
      // pushes it outside the visible viewport or it grows taller than usual.
      const cy = Math.max(top + height / 2 + 8, Math.min(
        (composer?.top ?? bottom) - PILL_GAP - height / 2,
        bottom - height / 2 - 8
      ));
      pillDock.classList.add('cgpt-ah-pill-compact');
      pillDock.style.setProperty('--ah-pill-w', `${width}px`);
      pillDock.style.left = `${left + (viewport?.width || window.innerWidth) / 2}px`;
      pillDock.style.top = `${cy}px`;
      return;
    }
    const column = composer || SITE.chatColumn()?.getBoundingClientRect() || null;
    const vw = window.innerWidth;
    const centerX = column ? column.left + column.width / 2 : vw / 2;

    // When space runs out the pill shrinks rather than slides: staying centred
    // is what keeps the play button under the pointer.
    const width = Math.max(
      PILL_MIN_WIDTH,
      Math.min(
        PILL_MAX_WIDTH,
        2 * Math.min(centerX, vw - centerX) - 16,
        column ? column.width : PILL_MAX_WIDTH
      )
    );
    let cx = Math.min(Math.max(centerX, width / 2 + 8), Math.max(width / 2, vw - width / 2 - 8));

    let cy;
    if (pillPosition === 'top') {
      cy = 14 + height / 2;
    } else {
      const scrollBtn = findScrollDownButton()?.getBoundingClientRect();
      const composerTop = composer ? composer.top : window.innerHeight - 130;
      cy = Math.max(height / 2 + 8, composerTop - PILL_GAP - height / 2);

      if (scrollBtn) {
        // The scroll-to-bottom button shares the center line with the pill.
        // Put the expanded pill beside it while there is enough room, then
        // automatically return to the normal centered position when it hides.
        const edgeGap = 12;
        const viewportMargin = 8;
        const leftRoom = scrollBtn.left - edgeGap - viewportMargin;
        const rightRoom = vw - scrollBtn.right - edgeGap - viewportMargin;

        if (Math.max(leftRoom, rightRoom) >= width) {
          const useRight = rightRoom >= width && rightRoom >= leftRoom;
          cx = useRight
            ? scrollBtn.right + edgeGap + width / 2
            : scrollBtn.left - edgeGap - width / 2;
          cy = Math.max(height / 2 + viewportMargin, scrollBtn.top + scrollBtn.height / 2);
        } else {
          // A phone-sized viewport cannot fit both controls side by side, so
          // retain the centered layout with a visibly larger vertical gap.
          cy = Math.max(height / 2 + viewportMargin, scrollBtn.top - edgeGap - height / 2);
        }
      }
    }

    // Side columns are clipped to protect the centred play button, so drop the
    // lowest-value labels before they can be cut off.
    pillDock.classList.toggle('cgpt-ah-pill-compact', width < PILL_COMPACT_WIDTH);
    pillDock.style.setProperty('--ah-pill-w', `${Math.round(width)}px`);
    pillDock.style.left = `${Math.round(cx)}px`;
    pillDock.style.top = `${Math.round(cy)}px`;
  }

  function startPillPositioning() {
    if (!pillPosTimer) {
      pillPosTimer = setInterval(positionPill, 700);
      window.addEventListener('resize', positionPill);
    }
    positionPill();
  }

  function stopPillPositioning() {
    if (pillPosTimer) {
      clearInterval(pillPosTimer);
      pillPosTimer = null;
    }
    window.removeEventListener('resize', positionPill);
    pillResizeObserver?.disconnect();
    pillResizeTarget = null;
  }

  function applyPillPositionMode() {
    if (!pillDock) return;
    pillDock.classList.toggle('cgpt-ah-pos-top', pillPosition === 'top');
    pillDock.classList.toggle('cgpt-ah-pos-bottom', pillPosition === 'bottom');
    refreshPillExpanded();
    positionPill();
  }

  function applyPillSize() {
    if (!pillDock) return;
    pillDock.classList.remove('cgpt-ah-pill-size-small', 'cgpt-ah-pill-size-medium', 'cgpt-ah-pill-size-large');
    pillDock.classList.add(`cgpt-ah-pill-size-${pillSize}`);
    positionPill();
  }

  function isEditableTarget(target) {
    return target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function shortcutForEvent(event) {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null;
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(event.code === 'Space' ? 'Space' : event.key);
    return parts.join('+');
  }

  function handleKeyboardShortcut(event) {
    if (isEditableTarget(event.target)) return;
    const shortcut = shortcutForEvent(event);
    if (!shortcut) return;
    if (shortcut === keyboardShortcuts.toggle) togglePlay();
    else if (shortcut === keyboardShortcuts.back && activeAudio) {
      seekBy(-10);
    } else if (shortcut === keyboardShortcuts.forward && activeAudio) {
      seekBy(10);
    } else return;
    event.preventDefault();
  }

  // Live-switch UI mode / pill position when the extension popup (or the
  // onboarding overlay) writes new preferences.
  function startStorageWatcher() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const modeChange = changes[STORAGE_KEYS.mode];
      const posChange = changes[STORAGE_KEYS.pillPos];
      const sizeChange = changes[STORAGE_KEYS.pillSize];
      const shortcutsChange = changes[STORAGE_KEYS.shortcuts];
      const newMode =
        modeChange && (modeChange.newValue === 'panel' || modeChange.newValue === 'pill')
          ? modeChange.newValue
          : null;
      if (posChange && (posChange.newValue === 'top' || posChange.newValue === 'bottom')) {
        pillPosition = posChange.newValue;
      }
      if (sizeChange && ['small', 'medium', 'large'].includes(sizeChange.newValue)) {
        pillSize = sizeChange.newValue;
      }
      if (shortcutsChange && shortcutsChange.newValue && typeof shortcutsChange.newValue === 'object') {
        keyboardShortcuts = { ...keyboardShortcuts, ...shortcutsChange.newValue };
      }
      if (newMode && newMode !== uiMode) {
        uiMode = newMode;
        applyUiMode();
      } else if (posChange && usesPill()) {
        applyPillPositionMode();
      } else if (sizeChange && usesPill()) {
        applyPillSize();
      }
    });
  }

  /* ---------------- onboarding ---------------- */

  function maybeShowOnboarding(settings) {
    // Fresh installs (no stored mode) and extension updates (flag set by the
    // background worker) both get the style picker.
    if (settings.mode && !settings.onboardingPending) return;
    buildOnboarding(settings);
  }

  function buildOnboarding(settings) {
    const overlay = document.createElement('div');
    overlay.id = 'cgpt-ah-onboard';
    overlay.innerHTML = `
      <div class="cgpt-ah-ob-card" role="dialog" aria-modal="true" aria-label="Choose your player style">
        <h2 class="cgpt-ah-ob-title">Choose your player style</h2>
        <p class="cgpt-ah-ob-sub">How should the audio controller look? You can switch anytime from the extension icon.</p>
        <div class="cgpt-ah-ob-options">
          <button type="button" class="cgpt-ah-ob-option" data-mode="panel" aria-pressed="false">
            <span class="cgpt-ah-ob-preview" aria-hidden="true">
              <span class="pv-panel">
                <span class="pv-panel-head"></span>
                <span class="pv-panel-line"></span>
                <span class="pv-panel-controls"><i></i><i></i><i></i></span>
              </span>
            </span>
            <span class="cgpt-ah-ob-name">Floating Panel</span>
            <span class="cgpt-ah-ob-desc">The classic draggable controller with a full timeline.</span>
          </button>
          <button type="button" class="cgpt-ah-ob-option" data-mode="pill" aria-pressed="false">
            <span class="cgpt-ah-ob-preview cgpt-ah-ob-preview-pill" aria-hidden="true">
              <span class="pv-ball"><i></i><i></i><i></i><i></i><i></i></span>
              <span class="pv-pill"></span>
            </span>
            <span class="cgpt-ah-ob-name">Micro Pill</span>
            <span class="cgpt-ah-ob-desc">A slick pill centred on the chat that opens on hover and stays open while playing.</span>
          </button>
        </div>
        <div class="cgpt-ah-ob-poswrap" hidden>
          <span class="cgpt-ah-ob-poslabel">Pill position</span>
          <span class="cgpt-ah-ob-seg">
            <button type="button" data-pos="top">Top</button>
            <button type="button" data-pos="bottom">Bottom</button>
          </span>
        </div>
        <button type="button" class="cgpt-ah-ob-confirm" disabled>Start listening</button>
        <button type="button" class="cgpt-ah-ob-skip">Skip for now</button>
      </div>
    `;
    document.documentElement.appendChild(overlay);

    const options = Array.from(overlay.querySelectorAll('.cgpt-ah-ob-option'));
    const posWrap = overlay.querySelector('.cgpt-ah-ob-poswrap');
    const segBtns = Array.from(overlay.querySelectorAll('.cgpt-ah-ob-seg button'));
    const confirmBtn = overlay.querySelector('.cgpt-ah-ob-confirm');
    const skipBtn = overlay.querySelector('.cgpt-ah-ob-skip');

    let chosenMode = settings.mode;
    let chosenPos = settings.pillPos || 'bottom';

    function render() {
      options.forEach((opt) => {
        const selected = opt.dataset.mode === chosenMode;
        opt.classList.toggle('selected', selected);
        opt.setAttribute('aria-pressed', String(selected));
      });
      posWrap.hidden = chosenMode !== 'pill';
      segBtns.forEach((b) => b.classList.toggle('active', b.dataset.pos === chosenPos));
      confirmBtn.disabled = !chosenMode;
    }

    function dismiss() {
      overlay.classList.add('cgpt-ah-ob-leaving');
      setTimeout(() => overlay.remove(), 320);
    }

    options.forEach((opt) =>
      opt.addEventListener('click', () => {
        chosenMode = opt.dataset.mode;
        render();
      })
    );
    segBtns.forEach((b) =>
      b.addEventListener('click', () => {
        chosenPos = b.dataset.pos;
        render();
      })
    );
    confirmBtn.addEventListener('click', () => {
      // The storage watcher picks the change up and switches the UI live.
      chrome.storage.local.set({
        [STORAGE_KEYS.mode]: chosenMode,
        [STORAGE_KEYS.pillPos]: chosenPos,
        [ONBOARD_KEY]: false,
      });
      dismiss();
    });
    skipBtn.addEventListener('click', dismiss);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) dismiss();
    });

    render();
  }

  /* ---------------- observers ---------------- */

  // Added nodes are handled as they arrive, but that alone cannot notice a
  // button of ours being dropped, or a row whose turn only became readable
  // after the row itself was added. A throttled pass over the whole page puts
  // back whatever went missing.
  let rescanTimer = null;
  function queueRescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      restoreMissingButtons();
    }, RESCAN_DELAY_MS);
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.tagName === 'AUDIO') {
            hijackAudio(node);
          } else {
            hijackExistingAudio(node);
            scanAndInject(node);
          }
        }
      }
      queueRescan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------------- init ---------------- */

  async function init() {
    const settings = await loadSettings();
    savedPanelPos = settings.pos;
    uiMode = settings.mode || 'panel';
    pillPosition = settings.pillPos || 'bottom';
    pillSize = settings.pillSize || 'medium';
    keyboardShortcuts = { ...keyboardShortcuts, ...settings.shortcuts };
    applyUiMode();
    COMPACT_VIEWPORT.addEventListener('change', applyUiMode);
    scanAndInject(document.body);
    hijackExistingAudio(document.body);
    startObserver();
    startStorageWatcher();
    document.addEventListener('keydown', handleKeyboardShortcut);
    maybeShowOnboarding(settings);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

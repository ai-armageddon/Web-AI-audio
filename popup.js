/* Extension action popup: switch player style + pill position.
 * Writes straight to chrome.storage.local; the content script on each
 * supported site watches storage and swaps the UI live. */
(() => {
  'use strict';

  const KEY_MODE = 'uiMode';
  const KEY_POS = 'pillPosition';
  const KEY_SIZE = 'pillSize';
  const KEY_SHORTCUTS = 'keyboardShortcuts';

  const modePanel = document.getElementById('modePanel');
  const modePill = document.getElementById('modePill');
  const posGroup = document.getElementById('posGroup');
  const posTop = document.getElementById('posTop');
  const posBottom = document.getElementById('posBottom');
  const sizeGroup = document.getElementById('sizeGroup');
  const sizeSmall = document.getElementById('sizeSmall');
  const sizeMedium = document.getElementById('sizeMedium');
  const sizeLarge = document.getElementById('sizeLarge');
  const shortcutToggle = document.getElementById('shortcutToggle');
  const shortcutBack = document.getElementById('shortcutBack');
  const shortcutForward = document.getElementById('shortcutForward');
  const rerun = document.getElementById('rerun');
  const hint = document.getElementById('hint');

  let uiMode = 'panel';
  let pillPosition = 'bottom';
  let pillSize = 'medium';
  let keyboardShortcuts = {
    toggle: 'Alt+Space',
    back: 'Alt+ArrowLeft',
    forward: 'Alt+ArrowRight',
  };

  function render() {
    modePanel.classList.toggle('selected', uiMode === 'panel');
    modePill.classList.toggle('selected', uiMode === 'pill');
    modePanel.setAttribute('aria-pressed', String(uiMode === 'panel'));
    modePill.setAttribute('aria-pressed', String(uiMode === 'pill'));
    posGroup.hidden = uiMode !== 'pill';
    sizeGroup.hidden = uiMode !== 'pill';
    posTop.classList.toggle('active', pillPosition === 'top');
    posBottom.classList.toggle('active', pillPosition === 'bottom');
    posTop.setAttribute('aria-pressed', String(pillPosition === 'top'));
    posBottom.setAttribute('aria-pressed', String(pillPosition === 'bottom'));
    [sizeSmall, sizeMedium, sizeLarge].forEach((button) => {
      const selected = button.id === `size${pillSize[0].toUpperCase()}${pillSize.slice(1)}`;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    shortcutToggle.value = keyboardShortcuts.toggle;
    shortcutBack.value = keyboardShortcuts.back;
    shortcutForward.value = keyboardShortcuts.forward;
  }

  function saveMode(mode) {
    uiMode = mode;
    chrome.storage.local.set({ [KEY_MODE]: mode });
    render();
  }

  function savePos(pos) {
    pillPosition = pos;
    chrome.storage.local.set({ [KEY_POS]: pos });
    render();
  }

  function saveSize(size) {
    pillSize = size;
    chrome.storage.local.set({ [KEY_SIZE]: size });
    render();
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

  function wireShortcut(input, name) {
    input.addEventListener('keydown', (event) => {
      const shortcut = shortcutForEvent(event);
      if (!shortcut) return;
      event.preventDefault();
      keyboardShortcuts[name] = shortcut;
      chrome.storage.local.set({ [KEY_SHORTCUTS]: keyboardShortcuts });
      render();
      input.blur();
    });
  }

  modePanel.addEventListener('click', () => saveMode('panel'));
  modePill.addEventListener('click', () => saveMode('pill'));
  posTop.addEventListener('click', () => savePos('top'));
  posBottom.addEventListener('click', () => savePos('bottom'));
  sizeSmall.addEventListener('click', () => saveSize('small'));
  sizeMedium.addEventListener('click', () => saveSize('medium'));
  sizeLarge.addEventListener('click', () => saveSize('large'));
  wireShortcut(shortcutToggle, 'toggle');
  wireShortcut(shortcutBack, 'back');
  wireShortcut(shortcutForward, 'forward');

  rerun.addEventListener('click', () => {
    chrome.storage.local.set({ onboardingPending: true }, () => {
      hint.textContent = 'The style picker will appear on your next ChatGPT or Grok page load.';
      hint.hidden = false;
    });
  });

  chrome.storage.local.get([KEY_MODE, KEY_POS, KEY_SIZE, KEY_SHORTCUTS], (res) => {
    if (res[KEY_MODE] === 'panel' || res[KEY_MODE] === 'pill') uiMode = res[KEY_MODE];
    if (res[KEY_POS] === 'top' || res[KEY_POS] === 'bottom') pillPosition = res[KEY_POS];
    if (['small', 'medium', 'large'].includes(res[KEY_SIZE])) pillSize = res[KEY_SIZE];
    if (res[KEY_SHORTCUTS] && typeof res[KEY_SHORTCUTS] === 'object') {
      keyboardShortcuts = { ...keyboardShortcuts, ...res[KEY_SHORTCUTS] };
    }
    render();
  });
})();

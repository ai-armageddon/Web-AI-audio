// Site adapter tests: node --test tests/
// The adapters register themselves on globalThis.__ahSites, exactly as they
// do in the browser, so they are loaded here the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

globalThis.__ahSites = [];
require(path.join(__dirname, '..', 'sites', 'chatgpt.js'));
require(path.join(__dirname, '..', 'sites', 'grok.js'));
const sites = globalThis.__ahSites;

// Mirrors the lookup in content.js and injector.js.
function siteFor(hostname) {
  return sites.find((s) => s.hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`)));
}

const CTX = { btnClass: 'cgpt-audio-hijacker-btn', nativeBtnAttr: 'data-cgpt-ah-native' };

// The smallest stand-in for a DOM element the adapters' pure checks need.
function fakeElement({ id = '', attrs = {}, descendants = [], turn = null } = {}) {
  const el = {
    id,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name) => name in attrs,
    querySelector: (selector) => descendants.find((d) => d.matches(selector)) || null,
    querySelectorAll: (selector) => descendants.filter((d) => d.matches(selector)),
    closest: (selector) => (turn && turn.matches(selector) ? turn : el.matches(selector) ? el : null),
    matches: () => false,
  };
  return el;
}

function button(label) {
  const el = fakeElement({ attrs: { 'aria-label': label } });
  // Only the selector shapes the adapters use are modelled: an aria-label
  // equality, or a bare `button` with pseudo-classes and no attribute.
  el.matches = (selector) =>
    selector.split(',').some((part) => {
      part = part.trim();
      if (part.includes('aria-label=')) return new RegExp(`aria-label="${label}" i`).test(part);
      return part.startsWith('button') && !part.includes('[');
    });
  el.parentElement = null;
  return el;
}

test('every supported host resolves to exactly one adapter', () => {
  assert.equal(siteFor('chatgpt.com').id, 'chatgpt');
  assert.equal(siteFor('www.chatgpt.com').id, 'chatgpt');
  assert.equal(siteFor('grok.com').id, 'grok');
  assert.equal(siteFor('example.com'), undefined);
  // A lookalike host must not match by suffix.
  assert.equal(siteFor('notgrok.com'), undefined);
});

test('adapters expose the full contract the core scripts call', () => {
  const required = [
    'actionRowSelector',
    'turnSelector',
    'isAssistantRowShape',
    'assistantContentText',
    'findNativeReadAloudButton',
    'isNativePlaying',
    'rowOwnsAudio',
    'findOverflowButton',
    'readAloudMenuItem',
    'findComposer',
    'chatColumn',
    'page',
  ];
  for (const site of sites) {
    for (const key of required) assert.ok(key in site, `${site.id} is missing ${key}`);
    assert.ok(site.readAloudMenuItem instanceof RegExp, `${site.id}.readAloudMenuItem`);
  }
});

test('menu item patterns accept Read Aloud and reject the stop state', () => {
  for (const site of sites) {
    assert.ok(site.readAloudMenuItem.test('Read Aloud'), site.id);
    assert.ok(site.readAloudMenuItem.test('  read aloud '), site.id);
    assert.ok(!site.readAloudMenuItem.test('Stop Reading'), site.id);
  }
});

/* ---------------- ChatGPT ---------------- */

// Build an ADTS stream of `frames` AAC frames at the given sample rate.
function adtsStream(frames, sampleRateIndex, payloadBytes = 20) {
  const frameLength = 7 + payloadBytes;
  const bytes = new Uint8Array(frames * frameLength);
  for (let f = 0; f < frames; f += 1) {
    const o = f * frameLength;
    bytes[o] = 0xff;
    bytes[o + 1] = 0xf1; // sync + MPEG-4 + no CRC
    bytes[o + 2] = (1 << 6) | (sampleRateIndex << 2); // profile LC, rate index
    bytes[o + 3] = (frameLength >> 11) & 0x03;
    bytes[o + 4] = (frameLength >> 3) & 0xff;
    bytes[o + 5] = ((frameLength & 0x07) << 5) | 0x1f;
    bytes[o + 6] = 0xfc; // one AAC block per frame
  }
  return bytes;
}

test('chatgpt: ADTS duration counts frames at the stream sample rate', () => {
  const chatgpt = siteFor('chatgpt.com');
  // 24 kHz is index 6; 1024 samples per block.
  const seconds = chatgpt.page.durationFromResponse(adtsStream(47, 6));
  assert.ok(Math.abs(seconds - (47 * 1024) / 24000) < 1e-9);
  assert.equal(chatgpt.page.durationFromResponse(new Uint8Array(0)), 0);
  assert.equal(chatgpt.page.durationFromResponse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), 0);
});

test('chatgpt: ADTS parser skips junk between frames', () => {
  const chatgpt = siteFor('chatgpt.com');
  const clean = adtsStream(10, 4); // 44.1 kHz
  const padded = new Uint8Array(clean.length + 5);
  padded.set([0, 1, 2, 3, 4], 0);
  padded.set(clean, 5);
  assert.equal(chatgpt.page.durationFromResponse(padded), (10 * 1024) / 44100);
});

test('chatgpt: only the synthesize endpoint counts as a TTS request', () => {
  const chatgpt = siteFor('chatgpt.com');
  assert.ok(chatgpt.page.isTtsRequest('https://chatgpt.com/backend-api/synthesize?id=1'));
  assert.ok(!chatgpt.page.isTtsRequest('https://chatgpt.com/backend-api/conversation'));
});

test('chatgpt: a row owns the audio only while its native toggle shows playing', () => {
  const chatgpt = siteFor('chatgpt.com');
  const audio = { hasAttribute: (n) => n === 'src' };
  const playing = button('Stop reading aloud');
  const idle = button('Read aloud');
  assert.ok(chatgpt.rowOwnsAudio(fakeElement({ descendants: [playing] }), audio, CTX));
  assert.ok(!chatgpt.rowOwnsAudio(fakeElement({ descendants: [idle] }), audio, CTX));
  assert.ok(!chatgpt.rowOwnsAudio(fakeElement({ descendants: [] }), audio, CTX));
  assert.ok(chatgpt.isNativePlaying(playing));
  assert.ok(!chatgpt.isNativePlaying(idle));
});

/* ---------------- Grok ---------------- */

// A streamed WAV header: RIFF/WAVE, a 16-byte fmt chunk, then a data chunk
// whose size is the placeholder Grok sends while still generating.
function wavHeader({ sampleRate = 24000, channels = 1, bits = 16, extraChunk = false } = {}) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const chunks = [];
  const fmt = new DataView(new ArrayBuffer(24));
  fmt.setUint32(0, 0x666d7420, false); // 'fmt '
  fmt.setUint32(4, 16, true);
  fmt.setUint16(8, 1, true);
  fmt.setUint16(10, channels, true);
  fmt.setUint32(12, sampleRate, true);
  fmt.setUint32(16, byteRate, true);
  fmt.setUint16(20, (channels * bits) / 8, true);
  fmt.setUint16(22, bits, true);
  chunks.push(new Uint8Array(fmt.buffer));
  if (extraChunk) {
    const list = new DataView(new ArrayBuffer(8 + 6));
    list.setUint32(0, 0x4c495354, false); // 'LIST'
    list.setUint32(4, 5, true); // odd size, padded to 6
    chunks.push(new Uint8Array(list.buffer));
  }
  const data = new DataView(new ArrayBuffer(8));
  data.setUint32(0, 0x64617461, false); // 'data'
  data.setUint32(4, 0xffffffff, true);
  chunks.push(new Uint8Array(data.buffer));

  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(out.buffer).setUint32(4, 0xfffffff7, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  let o = 12;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return { bytes: out, byteRate, dataOffset: out.length };
}

test('grok: WAV duration comes from the served size and the fmt byte rate', () => {
  const grok = siteFor('grok.com');
  const { bytes, byteRate, dataOffset } = wavHeader();
  assert.equal(dataOffset, 44);
  const total = dataOffset + byteRate * 28.15;
  assert.ok(Math.abs(grok.page.wavDurationSeconds(bytes, total) - 28.15) < 1e-9);
});

test('grok: WAV chunk walk tolerates extra, odd-sized chunks before data', () => {
  const grok = siteFor('grok.com');
  const { bytes, byteRate, dataOffset } = wavHeader({ extraChunk: true });
  assert.equal(dataOffset, 44 + 14);
  assert.equal(grok.page.wavDurationSeconds(bytes, dataOffset + byteRate * 3), 3);
});

test('grok: WAV duration is unknown for non-WAV bytes or an unusable size', () => {
  const grok = siteFor('grok.com');
  const { bytes } = wavHeader();
  assert.equal(grok.page.wavDurationSeconds(new Uint8Array(64), 1e6), 0);
  assert.equal(grok.page.wavDurationSeconds(bytes, 44), 0);
  assert.equal(grok.page.wavDurationSeconds(bytes, NaN), 0);
});

test('grok: the source probe reads the total from Content-Range on a 206', async () => {
  const grok = siteFor('grok.com');
  const { bytes, byteRate } = wavHeader();
  const total = 44 + byteRate * 10;
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, range: init.headers.Range });
    return {
      ok: true,
      status: 206,
      headers: { get: (n) => (n === 'content-range' ? `bytes 0-255/${total}` : null) },
      arrayBuffer: async () => bytes.buffer,
    };
  };
  const src = 'https://grok.com/http/app-chat/read-response-audio-file/abc-123';
  assert.equal(await grok.page.durationForSrc(src, fetchFn), 10);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, src);
  assert.match(calls[0].range, /^bytes=0-\d+$/);
});

test('grok: the source probe falls back to Content-Length when the range is ignored', async () => {
  const grok = siteFor('grok.com');
  const { bytes, byteRate } = wavHeader();
  const total = 44 + byteRate * 4;
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    headers: { get: (n) => (n === 'content-length' ? String(total) : null) },
    arrayBuffer: async () => bytes.buffer,
  });
  assert.equal(await grok.page.durationForSrc('x', fetchFn), 4);
  const failing = async () => ({ ok: false, status: 500, headers: { get: () => null } });
  assert.equal(await grok.page.durationForSrc('x', failing), 0);
});

test('grok: audio sources are recognised and tied to their response row', () => {
  const grok = siteFor('grok.com');
  const id = '9564c0c7-6cc9-53c5-87cc-f8ea1efa3e56';
  const src = `https://grok.com/http/app-chat/read-response-audio-file/${id}`;
  assert.ok(grok.page.isAudioSrc(src));
  assert.ok(!grok.page.isAudioSrc('https://grok.com/rest/app-chat/conversations'));

  const turn = fakeElement({ id: `response-${id}` });
  turn.matches = (selector) => selector === '[id^="response-"]';
  const otherTurn = fakeElement({ id: 'response-other' });
  otherTurn.matches = turn.matches;
  const audio = { currentSrc: src, getAttribute: () => src };
  assert.ok(grok.rowOwnsAudio(fakeElement({ turn }), audio));
  assert.ok(!grok.rowOwnsAudio(fakeElement({ turn: otherTurn }), audio));
  assert.ok(!grok.rowOwnsAudio(fakeElement({}), audio));
  assert.ok(!grok.rowOwnsAudio(fakeElement({ turn }), null));
});

test('grok: only rows with reply-only actions count as assistant rows', () => {
  const grok = siteFor('grok.com');
  assert.ok(grok.isAssistantRowShape(fakeElement({ descendants: [button('Copy response')] })));
  assert.ok(grok.isAssistantRowShape(fakeElement({ descendants: [button('Regenerate')] })));
  assert.ok(!grok.isAssistantRowShape(fakeElement({ descendants: [button('Edit'), button('Copy'), button('Save')] })));
  assert.equal(grok.findNativeReadAloudButton(fakeElement({}), CTX), null);
});

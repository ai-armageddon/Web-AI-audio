# Web-AI-audio

A Chrome extension that gives the Read Aloud feature of AI chat sites a proper player: one-click access from every reply, and a floating controller with scrubbing, skip, loop and a playback speed that sticks.

Works on **ChatGPT** and **Grok**. Each site is a small adapter, so adding another one is a single file.

![Extension Icon](icons/icon128.png)

## Features

- **One-Click Access** - Speaker button injected into every readable assistant reply (no more digging through menus)
- **Floating Media Controller** - Sleek, draggable panel or a micro pill centred on the chat, with full playback controls
- **Zoom-Friendly Player** - An always-visible bottom player takes over in narrow or short windows; Play starts the latest reply when no audio is loaded
- **Smart Audio Hijacking** - Takes over the site's own Read Aloud stream, so the voice is the site's and the controls are yours
- **Real Timeline While Streaming** - Works the clip's true length out from the download, so the scrubber and total time are right long before the site knows them
- **Playback Speed Control** - Click the speed pill to cycle 1x, 1.25x, 1.5x, 1.75x, or 2x (persists across sessions and sites)
- **Keyboard Shortcuts** - Play/pause, back 10s and forward 10s, configurable from the extension popup
- **Position Memory** - Panel remembers where you dragged it (even after page reload)
- **Modern UI** - Clean, glassmorphic design that follows the site's light/dark theme
- **Auto-Hide** - Panel only appears when audio is playing, hides when finished

## Supported sites

| Site | How Read Aloud is reached | Notes |
| --- | --- | --- |
| ChatGPT (`chatgpt.com`) | The native Read Aloud button in the reply's action row is replaced by the speaker button | Audio is a streamed AAC clip through a MediaSource; the extension keeps a minute of history so you can rewind |
| Grok (`grok.com`) | The speaker button opens the reply's "More actions" menu and picks Read Aloud for you | Audio is a streamed WAV file; Grok's own mini player bar is hidden while the floating player is in charge |

Sites without a native Read Aloud feature on the web (Claude, for example) are out of scope: the extension drives the site's own voice rather than bringing its own.

## Screenshots

### Injected Speaker Button
A native-looking speaker button appears as the first item in assistant response action rows when Read Aloud is available. Image-only responses do not show it.

![Injected speaker button](screenshots/injected-button.png)

### Floating Media Controller
Beautiful floating panel with all playback controls.

![Floating media controller](screenshots/media-controller.png)

## Installation

### Method 1: Chrome Web Store (Coming Soon)
*Will be available on the Chrome Web Store once published*

### Method 2: Manual Installation
1. Download this repository as a ZIP file
2. Extract the ZIP to a folder (e.g., `Web-AI-audio`)
3. Open Chrome and navigate to `chrome://extensions`
4. Enable **Developer mode** (toggle in top-right)
5. Click **Load unpacked** and select the extracted folder
6. Open `https://chatgpt.com` or `https://grok.com` and enjoy!

## Usage

1. **Play Audio** - Click the speaker button under any text-based reply
2. **Control Playback** - Use the floating panel to play/pause, skip, or seek
3. **Adjust Speed** - Click the speed pill to cycle through playback speeds
4. **Reposition Panel** - Drag the panel by its header to your preferred location
5. **Hide Panel** - Click the × button or let it auto-hide when audio ends
6. **Pick a Style** - Use the extension icon to switch between the floating panel and the micro pill, and to set keyboard shortcuts

## Technical Details

### How It Works
- **Site Adapters**: Everything that depends on a site's DOM or audio pipeline lives in `sites/<site>.js`. The core scripts never name a site; they pick the adapter registered for the current hostname.
- **Button Injection**: Uses `MutationObserver` to detect new messages and inject speaker buttons where the adapter says the action row is
- **Audio Hijacking**: Intercepts the site's native `<audio>` elements and routes control to the custom UI
- **Detached Audio Support**: Patches `HTMLMediaElement.play()` to capture audio objects that never enter the DOM
- **Clip Length**: ChatGPT's length is counted from the ADTS frames of the synthesize download; Grok's comes from a Range request, whose `Content-Range` header reports the WAV's full size
- **Storage**: Uses `chrome.storage.local` to persist speed, player style, shortcuts and panel position
- **Pointer Events**: Emulates real user interactions for compatibility with the sites' Radix UI components

### Compatibility
- ✅ Chrome 88+ (Manifest V3)
- ✅ ChatGPT (chatgpt.com) and Grok (grok.com)
- ✅ Every voice the site offers
- ✅ Desktop and laptop browsers

## Development

### Building from Source
```bash
# Clone the repository
git clone https://github.com/ai-armageddon/Web-AI-audio.git
cd Web-AI-audio

# Load in Chrome
# 1. Open chrome://extensions
# 2. Enable Developer mode
# 3. Click "Load unpacked" and select this folder
```

### Tests
```bash
npm test
```
The suite runs on Node's built-in test runner with no dependencies. It loads the site adapters exactly as the browser does and checks their pure logic: host resolution, the ADTS and WAV length parsers, the Grok Range probe against a mocked fetch, and which reply a clip belongs to.

### Versioning
The version in `manifest.json` follows the commit count: the minor number goes up by one every 3 commits, and the patch number counts the commits in between (commit 15 is `0.5.0`, commit 16 is `0.5.1`). Run `node version.js` before committing to set it.

### Adding a site
1. Copy `sites/grok.js` (or `sites/chatgpt.js`, whichever is closer) to `sites/<site>.js` and fill in the adapter: host names, how to find a reply's action row and its text, how to reach the native Read Aloud control, and, in the `page` block, how to measure the clip while it streams.
2. Add the site's URL pattern to `host_permissions`, both `content_scripts` entries and `web_accessible_resources` in `manifest.json`, and the new file ahead of `injector.js` and `content.js` in the two `js` lists.
3. Add its cases to `tests/sites.test.js`.

The contract is documented at the top of `sites/chatgpt.js`. Hooks that a site does not need (`buttonMount`, `legacyAnchorSelector`, `markNativeUi`, and the `page` measurers) can be left out.

### Project Structure
```
Web-AI-audio/
├── manifest.json          # Extension manifest
├── content.js             # Site-agnostic content script: buttons, player, settings
├── injector.js            # Site-agnostic MAIN-world audio hooks
├── sites/
│   ├── chatgpt.js         # ChatGPT adapter
│   └── grok.js            # Grok adapter
├── styles.css             # UI styles
├── popup.html/.css/.js    # Extension popup: player style, pill position, shortcuts
├── background.js          # Shows the style picker again after an update
├── tests/
│   └── sites.test.js      # Adapter tests (npm test)
├── version.js             # Sets the version from the commit count
├── icons/                 # Extension icons
└── README.md              # This file
```

## Troubleshooting

### Audio Not Playing
- **Check Console**: Open DevTools (F12) and look for errors
- **Refresh Page**: Sometimes a site's UI changes require a page reload
- **Disable Conflicts**: Try disabling other extensions that touch the same site temporarily

### Button Not Appearing
- **Wait for Load**: Give the page a moment to fully load
- **Check Messages**: Only assistant messages with readable text have the speaker button
- **Refresh**: Try refreshing the page if buttons don't appear

### Panel Not Showing
- **Start Audio**: The panel only appears when audio is actively playing
- **Zoomed-In Layouts**: At viewport widths of 768px or less, or heights of 480px or less, an expanded bottom player stays visible even before playback. Your selected player style returns when the window has more room.
- **Check Position**: The panel might be off-screen - drag it back into view

### Extension Not Loading
- **Verify Installation**: Ensure the extension is enabled in `chrome://extensions`
- **Check Permissions**: Make sure it has access to `chatgpt.com` and `grok.com`
- **Reload Extension**: Click the reload button in `chrome://extensions`

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests. New site adapters are especially welcome; see **Adding a site** above.

### How to Contribute
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- OpenAI and xAI for building Read Aloud into their chat products
- The Chrome extension community for inspiration and tools
- Radix UI for the accessible component library both sites use

## Support

If you encounter any issues or have questions:
- 🐛 [Report an Issue](https://github.com/ai-armageddon/Web-AI-audio/issues)
- 💬 [Discussions](https://github.com/ai-armageddon/Web-AI-audio/discussions)

---

**Made with ❤️ for people who would rather listen**

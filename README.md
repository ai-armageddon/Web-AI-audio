# ChatGPT-web-audio

A Chrome extension that supercharges ChatGPT's Read Aloud feature with a beautiful floating media controller and one-click access.

![Extension Icon](icons/icon128.png)

## Features

- **One-Click Access** - Speaker button injected into assistant responses with readable text (no more digging through menus!)
- **Floating Media Controller** - Sleek, draggable panel with full playback controls
- **Zoom-Friendly Player** - An always-visible bottom player takes over in narrow or short windows; Play starts the latest reply when no audio is loaded
- **Smart Audio Hijacking** - Intercepts OpenAI's native audio stream for seamless control
- **Playback Speed Control** - Click the speed pill to cycle 1x, 1.25x, 1.5x, 1.75x, or 2x (persists across sessions)
- **Position Memory** - Panel remembers where you dragged it (even after page reload)
- **Modern UI** - Clean, glassmorphic design that follows ChatGPT's light/dark theme
- **Auto-Hide** - Panel only appears when audio is playing, hides when finished

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
2. Extract the ZIP to a folder (e.g., `ChatGPT-web-audio`)
3. Open Chrome and navigate to `chrome://extensions`
4. Enable **Developer mode** (toggle in top-right)
5. Click **Load unpacked** and select the extracted folder
6. Navigate to `https://chatgpt.com` and enjoy!

## Usage

1. **Play Audio** - Click the speaker button under any text-based ChatGPT response
2. **Control Playback** - Use the floating panel to play/pause, skip, or seek
3. **Adjust Speed** - Click the speed pill to cycle through playback speeds
4. **Reposition Panel** - Drag the panel by its header to your preferred location
5. **Hide Panel** - Click the × button or let it auto-hide when audio ends

## Technical Details

### How It Works
- **Button Injection**: Uses `MutationObserver` to detect new messages and inject speaker buttons
- **Audio Hijacking**: Intercepts OpenAI's native `<audio>` elements and routes control to custom UI
- **Detached Audio Support**: Patches `HTMLMediaElement.play()` to capture audio objects that never enter the DOM
- **Storage**: Uses `chrome.storage.local` to persist speed preferences and panel position
- **Pointer Events**: Emulates real user interactions for compatibility with ChatGPT's Radix UI components

### Compatibility
- ✅ Chrome 88+ (Manifest V3)
- ✅ ChatGPT (chatgpt.com)
- ✅ All OpenAI voice models
- ✅ Desktop and laptop browsers

## Development

### Building from Source
```bash
# Clone the repository
git clone https://github.com/ai-armageddon/ChatGPT-web-audio.git
cd ChatGPT-web-audio

# Load in Chrome
# 1. Open chrome://extensions
# 2. Enable Developer mode
# 3. Click "Load unpacked" and select this folder
```

### Versioning
The version in `manifest.json` follows the commit count: the minor number goes up by one every 3 commits, and the patch number counts the commits in between (commit 15 is `0.5.0`, commit 16 is `0.5.1`). Run `node version.js` before committing to set it.

### Project Structure
```
ChatGPT-web-audio/
├── manifest.json          # Extension manifest
├── content.js             # Main content script
├── injector.js            # MAIN-world audio patch
├── styles.css             # UI styles
├── version.js             # Sets the version from the commit count
├── icons/                 # Extension icons
│   ├── icon-source.png
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md              # This file
```

## Troubleshooting

### Audio Not Playing
- **Check Console**: Open DevTools (F12) and look for errors
- **Refresh Page**: Sometimes ChatGPT's UI changes require a page reload
- **Disable Conflicts**: Try disabling other ChatGPT extensions temporarily

### Button Not Appearing
- **Wait for Load**: Give the page a moment to fully load
- **Check Messages**: Only assistant messages have the speaker button
- **Refresh**: Try refreshing the page if buttons don't appear

### Panel Not Showing
- **Start Audio**: The panel only appears when audio is actively playing
- **Zoomed-In Layouts**: At viewport widths of 768px or less, or heights of 480px or less, an expanded bottom player stays visible even before playback. Your selected player style returns when the window has more room.
- **Check Position**: The panel might be off-screen - drag it back into view

### Extension Not Loading
- **Verify Installation**: Ensure the extension is enabled in `chrome://extensions`
- **Check Permissions**: Make sure it has access to `chatgpt.com`
- **Reload Extension**: Click the reload button in `chrome://extensions`

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

### How to Contribute
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- OpenAI for the amazing ChatGPT platform
- The Chrome extension community for inspiration and tools
- Radix UI for the accessible component library that ChatGPT uses

## Support

If you encounter any issues or have questions:
- 🐛 [Report an Issue](https://github.com/ai-armageddon/ChatGPT-web-audio/issues)
- 💬 [Discussions](https://github.com/ai-armageddon/ChatGPT-web-audio/discussions)
- 📧 [Email Support](mailto:support@example.com)

---

**Made with ❤️ for the ChatGPT community**

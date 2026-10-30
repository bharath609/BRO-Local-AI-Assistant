const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('broDesktop', {
  // Opt-in: BRO_VOICE_DEBUG=1 prints the transcript so voice accuracy can be
  // checked from the terminal. Off by default so spoken text stays private.
  voiceDebug: process.env.BRO_VOICE_DEBUG === '1',
  // Hands-free “BRO” wake word. Set BRO_WAKE_WORD=0 to keep the mic closed
  // and use only the Ctrl+Alt+B hotkey.
  wakeWord: process.env.BRO_WAKE_WORD !== '0',
  // How long the popup stays on screen after a command before it hides itself.
  autoHideMs: Number(process.env.BRO_AUTO_HIDE_MS) || 0,
  onHotkey(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('bro-hotkey', listener);
    return () => ipcRenderer.removeListener('bro-hotkey', listener);
  },
  closeOverlay() {
    ipcRenderer.send('bro-close-overlay');
  },
  hideOverlay() {
    ipcRenderer.send('bro-hide-overlay');
  },
  showOverlay() {
    ipcRenderer.send('bro-show-overlay');
  },
});

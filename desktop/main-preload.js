const { contextBridge, ipcRenderer } = require('electron');

// Narrow bridge for the main window. The chat UI stays sandboxed and talks to
// the local HTTP backend; this only carries navigation requests from the tray.
contextBridge.exposeInMainWorld('broDesktop', {
  onNavigate(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, view) => callback(view);
    ipcRenderer.on('bro-navigate', listener);
    return () => ipcRenderer.removeListener('bro-navigate', listener);
  },
  openMain(view) {
    ipcRenderer.send('bro-open-main', typeof view === 'string' ? view : undefined);
  },
});

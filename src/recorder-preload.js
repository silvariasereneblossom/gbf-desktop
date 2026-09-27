// Preload for the hidden recorder window: a narrow bridge for streaming encoded chunks to main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gbfRec', {
  chunk: (u8) => ipcRenderer.send('rec:chunk', u8),
  stopped: () => ipcRenderer.send('rec:stopped'),
  error: (msg) => ipcRenderer.send('rec:error', msg)
});

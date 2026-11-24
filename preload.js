const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electroWin', {
  close: () => ipcRenderer.send('win:close'),
  minimize: () => ipcRenderer.send('win:min')
});

// 速启 · preload（设计档 3.3 / 2.3#2）
// 沙箱预加载：require 只能加载 electron 受限子集（contextBridge / ipcRenderer / webUtils），
// 不能加载本地文件 —— 故本文件自包含、不拆分；renderer 拿不到 ipcRenderer 本体，通道名不泄漏到页面。

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const api = {
  loadState: () => ipcRenderer.invoke('state:load'),
  pickApp: () => ipcRenderer.invoke('app:pick'),
  validateDroppedPath: (path) => ipcRenderer.invoke('app:validatePath', { path }),
  createApp: (payload) => ipcRenderer.invoke('app:create', payload),
  updateApp: (payload) => ipcRenderer.invoke('app:update', payload),
  deleteApp: (id) => ipcRenderer.invoke('app:delete', { id }),
  launchApp: (id) => ipcRenderer.invoke('app:launch', { id }),
  getIcon: (id) => ipcRenderer.invoke('icon:get', { id }),
  getAppIcon: () => ipcRenderer.invoke('appIcon:get'),
  createCategory: (name) => ipcRenderer.invoke('category:create', { name }),
  renameCategory: (payload) => ipcRenderer.invoke('category:rename', payload),
  deleteCategory: (id) => ipcRenderer.invoke('category:delete', { id }),
  hidePanel: () => {
    ipcRenderer.send('panel:hide');
  },
  onPanelShown: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('panel:shown', listener);
    return () => ipcRenderer.removeListener('panel:shown', listener);
  },
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  setComposing: (composing) => {
    ipcRenderer.send('panel:composing', { composing });
  },
  reorderApp: (payload) => ipcRenderer.invoke('app:reorder', payload),
  setHotkey: (accelerator) => ipcRenderer.invoke('hotkey:set', { accelerator }),
  closeHotkeyWindow: () => {
    ipcRenderer.send('hotkeyWindow:close');
  },
};

contextBridge.exposeInMainWorld('api', api);

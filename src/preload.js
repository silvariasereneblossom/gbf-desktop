const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gbf', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial) => ipcRenderer.invoke('settings:set', partial)
  },
  dailies: {
    toggle: (id) => ipcRenderer.invoke('dailies:toggle', id),
    set: (list) => ipcRenderer.invoke('dailies:set', list)
  },
  resetMs: () => ipcRenderer.invoke('reset:ms'),
  nav: {
    go: (hash) => ipcRenderer.invoke('nav:go', hash),
    reload: () => ipcRenderer.invoke('nav:reload'),
    back: () => ipcRenderer.invoke('nav:back'),
    zoom: (d) => ipcRenderer.invoke('nav:zoom', d),
    currentUrl: () => ipcRenderer.invoke('nav:currentUrl')
  },
  toggleSidebar: () => ipcRenderer.invoke('app:toggleSidebar'),
  sidebarVisible: () => ipcRenderer.invoke('app:sidebarVisible'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openCurrentExternal: () => ipcRenderer.invoke('app:openCurrentExternal'),
  clearSession: () => ipcRenderer.invoke('session:clear'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  skyleapApply: (skyleap) => ipcRenderer.invoke('skyleap:apply', skyleap),
  proxyApply: (proxy) => ipcRenderer.invoke('proxy:apply', proxy),
  newGameWindow: () => ipcRenderer.invoke('app:newGameWindow'),
  tileWindows: () => ipcRenderer.invoke('app:tileWindows'),
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install')
  },
  rec: {
    toggle: () => ipcRenderer.invoke('rec:toggle'),
    state: () => ipcRenderer.invoke('rec:state'),
    openFolder: () => ipcRenderer.invoke('rec:openFolder')
  },
  accounts: {
    switch: (id) => ipcRenderer.invoke('accounts:switch', id),
    add: (name) => ipcRenderer.invoke('accounts:add', name),
    rename: (id, name) => ipcRenderer.invoke('accounts:rename', id, name),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id)
  },
  mudfish: {
    status: () => ipcRenderer.invoke('mudfish:status'),
    launch: () => ipcRenderer.invoke('mudfish:launch'),
    open: () => ipcRenderer.invoke('mudfish:open'),
    setPort: (port) => ipcRenderer.invoke('mudfish:setPort', port),
    saveCreds: (user, pass) => ipcRenderer.invoke('mudfish:saveCreds', user, pass)
  },
  party: {
    deck: () => ipcRenderer.invoke('party:deck'),
    slots: (team, deck) => ipcRenderer.invoke('party:slots', team, deck),
    autoEquip: (slot) => ipcRenderer.invoke('party:autoEquip', slot)
  },
  teams: {
    fetch: (input) => ipcRenderer.invoke('teams:fetch', input),
    explore: (params) => ipcRenderer.invoke('teams:explore', params),
    save: (team) => ipcRenderer.invoke('teams:save', team),
    remove: (code) => ipcRenderer.invoke('teams:remove', code)
  },
  on: (channel, fn) => {
    const ok = ['dailies-reset', 'game-url', 'settings-changed', 'ping', 'mudfish-up', 'rec-state', 'sidebar-state', 'update-state'];
    if (ok.includes(channel)) ipcRenderer.on(channel, (_e, ...a) => fn(...a));
  }
});

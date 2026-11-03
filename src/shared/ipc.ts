/** IPC channel names. Single source of truth for main <-> renderer messaging. */
export const IPC = {
  discovery: {
    rescan: 'discovery:rescan',
    list: 'discovery:list',
    addManual: 'discovery:addManual',
    forget: 'discovery:forget',
    status: 'discovery:status',
    update: 'discovery:update', // main -> renderer
    statusEvent: 'discovery:statusEvent', // main -> renderer
  },
  adb: {
    status: 'adb:status',
    download: 'adb:download',
    connect: 'adb:connect',
    pickApk: 'adb:pickApk',
    pick: 'adb:pick',
    install: 'adb:install',
    uninstall: 'adb:uninstall',
    screenshot: 'adb:screenshot',
    statusEvent: 'adb:statusEvent', // main -> renderer
  },
  update: {
    status: 'update:status',
    check: 'update:check',
    apply: 'update:apply',
    statusEvent: 'update:statusEvent', // main -> renderer
  },
  device: {
    connect: 'device:connect',
    disconnect: 'device:disconnect',
    forget: 'device:forget',
    sendPairingCode: 'device:sendPairingCode',
    sendKey: 'device:sendKey',
    sendText: 'device:sendText',
    clearText: 'device:clearText',
    sendChar: 'device:sendChar',
    backspace: 'device:backspace',
    skip: 'device:skip',
    launchApp: 'device:launchApp',
    listApps: 'device:listApps',
    setVolume: 'device:setVolume',
    setMuted: 'device:setMuted',
    media: 'device:media',
    seek: 'device:seek',
    castUrl: 'device:castUrl',
    openLink: 'device:openLink',
    search: 'device:search',
    searchOnTv: 'device:searchOnTv',
    searchUrl: 'device:searchUrl',
    getState: 'device:getState',
    activity: 'device:activity',
    setLiveView: 'device:setLiveView',
    activityEvent: 'device:activityEvent', // main -> renderer
    screen: 'device:screen', // main -> renderer
    state: 'device:state', // main -> renderer
    pairingRequested: 'device:pairingRequested', // main -> renderer
    keyboardOpened: 'device:keyboardOpened', // main -> renderer
  },
  rooms: {
    list: 'rooms:list',
    save: 'rooms:save',
    delete: 'rooms:delete',
    update: 'rooms:update', // main -> renderer
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    removeHistory: 'settings:removeHistory',
    history: 'settings:history', // main -> renderer
  },
  app: {
    readClipboard: 'app:readClipboard',
    setCompact: 'app:setCompact',
    isCompact: 'app:isCompact',
    version: 'app:version',
    platform: 'app:platform',
    appIcon: 'app:appIcon',
    defaultShortcuts: 'app:defaultShortcuts',
    openExternal: 'app:openExternal',
    openLocalNetworkSettings: 'app:openLocalNetworkSettings',
    openLogs: 'app:openLogs',
    sleepTimer: 'app:sleepTimer',
    sleepStatus: 'app:sleepStatus',
    sleepEvent: 'app:sleepEvent', // main -> renderer
    command: 'app:command', // main -> renderer
  },
} as const;

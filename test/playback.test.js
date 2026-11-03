const assert = require('node:assert/strict');
const { test } = require('node:test');
require('./helpers/electron-stub');
const { EventEmitter } = require('node:events');
const { CastDriver } = require('../dist/main/drivers/cast');
const { parseMediaSessions, pickSession, toMedia, AdbLive } = require('../dist/main/live');
const { adb } = require('../dist/main/adb');
const { selectMedia } = require('../src/shared/media-selection');
const context = { id:'cast:192.0.2.1', kind:'cast', host:'192.0.2.1', name:'Test TV', port:8009, appVersion:'test' };
const netflix = { mediaSessionId:12, playerState:'PLAYING', currentTime:120, media:{contentId:'80057281',duration:2940,metadata:{seriesTitle:'Stranger Things',title:'The Vanishing of Will Byers',season:1,episode:1,images:[{url:'https://example.test/art.jpg'}]}}};
function cast() { const d = new CastDriver(context); d.update({state:'connected',currentApp:{id:'CA5E8412',name:'Netflix'}}); return d; }
test('Netflix metadata survives Cast position and pause-only updates', () => {
  const d=cast(); d.applyMediaStatus(netflix); d.applyMediaStatus({mediaSessionId:12,playerState:'PAUSED',currentTime:135});
  assert.equal(d.state.media.title,'Stranger Things'); assert.equal(d.state.media.subtitle,'S1 E1 · The Vanishing of Will Byers'); assert.equal(d.state.media.duration,2940); assert.equal(d.state.media.artwork,'https://example.test/art.jpg'); assert.equal(d.state.media.currentTime,135); assert.equal(d.state.media.playerState,'PAUSED');
});
test('receiver volume-only message does not clear Netflix or its media', () => {
  const d=cast();d.applyMediaStatus(netflix);d.applyReceiverStatus({volume:{level:.4,muted:false}});assert.equal(d.state.currentApp.id,'CA5E8412');assert.equal(d.state.media.title,'Stranger Things');
});
test('new media session never borrows the previous title', () => { const d=cast();d.applyMediaStatus(netflix);d.applyMediaStatus({mediaSessionId:13,playerState:'BUFFERING'});assert.equal(d.state.media.title,undefined);assert.equal(d.state.media.contentId,undefined); });
test('a new content ID within a session clears the old artwork and series', () => { const d=cast();d.applyMediaStatus(netflix);d.applyMediaStatus({mediaSessionId:12,playerState:'PLAYING',media:{contentId:'different',metadata:{title:'New movie'}}});assert.equal(d.state.media.title,'New movie');assert.equal(d.state.media.artwork,undefined);assert.equal(d.state.media.subtitle,undefined); });
test('idle and Home clear playback and its metadata cache', () => { const d=cast();d.applyMediaStatus(netflix);d.applyMediaStatus({mediaSessionId:12,playerState:'IDLE'});assert.equal(d.state.media,undefined);d.applyMediaStatus({mediaSessionId:12,playerState:'PLAYING'});assert.equal(d.state.media.title,undefined);d.applyReceiverStatus({applications:[]});assert.equal(d.state.media,undefined); });
test('late status from a replaced Cast player is ignored', () => {
 const d=cast();const old=new EventEmitter(), current=new EventEmitter();old.close=current.close=()=>{};d.attachPlayer(old);d.attachPlayer(current);current.emit('status',netflix);old.emit('status',{mediaSessionId:99,playerState:'PLAYING',media:{metadata:{title:'Old app'}}});assert.equal(d.state.media.title,'Stranger Things');
});
test('transient Cast getSessions error preserves current playback', async () => {const d=cast();d.receiverSession='receiver';d.client={getSessions:cb=>cb(new Error('temporary'))};d.applyMediaStatus(netflix);await d.joinMediaSession();assert.equal(d.state.media.title,'Stranger Things');});
test('delayed Cast join cannot attach after the receiver changes apps', async () => {
 const d=cast();let join;d.receiverSession='old';d.client={getSessions:cb=>cb(null,[{sessionId:'old',namespaces:[{name:'urn:x-cast:com.google.cast.media'}]}]),join:(_a,_b,cb)=>{join=cb;}};const pending=d.joinMediaSession();d.receiverSession='new';let closed=false;join(null,{close:()=>closed=true});await pending;assert.ok(closed);assert.equal(d.player,undefined);
});
const dump=(pkg,state,title,active=true)=>`package=${pkg}\nactive=${active}\nstate=PlaybackState {state=${state}, position=42000}\nmetadata: size=3, description=${title}, Episode 2, null\n`;
test('Stremio playback is selected before its title arrives',()=>{const sessions=parseMediaSessions('package=com.stremio.one\nactive=true\nstate=PlaybackState {state=BUFFERING(6), position=0}\nmetadata: null');const s=pickSession(sessions);assert.equal(s.pkg,'com.stremio.one');assert.equal(toMedia(s).playerState,'BUFFERING');});
test('active foreground Netflix wins over an old playing session',()=>{const all=parseMediaSessions(dump('com.stremio.one',3,'Old')+dump('com.netflix.ninja',2,'Current'));assert.equal(pickSession(all,'com.netflix.ninja').title,'Current');});
test('seeking and connecting Android states retain playback',()=>{for(const state of [4,5,8])assert.ok(pickSession(parseMediaSessions(dump('com.stremio.one',state,'Current'))));});
test('metadata layout without size prefix and comma in title are handled',()=>{const s=parseMediaSessions(dump('com.netflix.ninja',3,'Love, Death & Robots').replace('size=3, description=',''))[0];assert.equal(s.title,'Love, Death & Robots');assert.equal(s.subtitle,'Episode 2');});
test('stopped and inactive sessions are excluded',()=>{assert.equal(pickSession(parseMediaSessions(dump('com.netflix.ninja',1,'Old')+dump('com.stremio.one',3,'Inactive',false))),undefined);});
const state=(kind,app,media)=>({id:kind,kind,state:'connected',currentApp:{id:app},media});
test('foreground Stremio ADB beats rich stale Netflix Cast metadata',()=>{const current={source:'adb',appId:'com.stremio.one',title:'Current film',playerState:'PLAYING'};const stale={source:'cast',appId:'CA5E8412',title:'Old Netflix',duration:3600,artwork:'old',playerState:'PAUSED'};assert.equal(selectMedia([state('androidtv','com.stremio.one',current),state('cast','CA5E8412',stale)]),current);});
test('matching Netflix sources keep rich Cast artwork',()=>{const a={source:'adb',appId:'com.netflix.ninja',title:'Stranger Things',playerState:'PLAYING'};const c={source:'cast',appId:'CA5E8412',title:'Stranger Things',duration:2940,artwork:'art',playerState:'PLAYING'};assert.equal(selectMedia([state('androidtv','com.netflix.ninja',a),state('cast','CA5E8412',c)]),c);});
test('disconnected and idle reports cannot win Now on TV',()=>{assert.equal(selectMedia([{...state('cast','CA5E8412',{title:'Old',playerState:'PLAYING'}),state:'disconnected'}]),undefined);assert.equal(selectMedia([state('cast','CA5E8412',{title:'Old',playerState:'IDLE'})]),undefined);});
test('stopping ADB while a poll is in flight prevents late media emissions', async ()=>{
 const original=adb.shellQuick;let resolve;adb.shellQuick=()=>new Promise(r=>resolve=r);const live=new AdbLive('192.0.2.1'),events=[];live.opts={media:true,screen:false};live.on('media',m=>events.push(m));const poll=live.pollMedia();live.stop();resolve(dump('com.stremio.one',3,'Too late'));await poll;adb.shellQuick=original;assert.equal(events.filter(Boolean).length,0);
});
test('subtitle-only ADB changes emit updated metadata',async()=>{
 const original=adb.shellQuick;let current=dump('com.stremio.one',2,'Series');adb.shellQuick=async()=>current;const live=new AdbLive('192.0.2.1'),events=[];live.opts={media:true,screen:false};live.on('media',m=>events.push(m));await live.pollMedia();current=current.replace('Episode 2','Episode 3');await live.pollMedia();live.stop();adb.shellQuick=original;assert.equal(events[1].subtitle,'Episode 3');
});
test('ADB playback auto-starts again after reconnect, independently of MAC lookup',()=>{
 const {DeviceManager}=require('../dist/main/devices');const wol=require('../dist/main/wol');const original=wol.lookupMac;wol.lookupMac=async()=>undefined;
 try {const discovery=new EventEmitter();discovery.get=()=>({id:'androidtv:test',kind:'androidtv',host:'192.0.2.1',port:6466,name:'Test'});discovery.setMac=()=>{};const manager=new DeviceManager(discovery,'test');let starts=0;manager.autoLive=()=>starts++;const driver=manager.create('androidtv:test');driver.update({state:'connected'});driver.update({state:'connected',powered:true});driver.update({state:'disconnected'});driver.update({state:'connected'});assert.equal(starts,2);}finally{wol.lookupMac=original;}
});
test('ADB recovery is delayed, deduplicated, and respects opt-out and known hosts',()=>{
 const {DeviceManager}=require('../dist/main/devices');const {getStore}=require('../dist/main/store');const store=getStore(),previous=store.settings();const realTimer=global.setTimeout;let callback,delay;
 global.setTimeout=(fn,ms)=>{callback=fn;delay=ms;return {unref(){}};};
 try {store.updateSettings({adbAuto:true,adbHosts:['192.0.2.1']});const discovery=new EventEmitter(),manager=new DeviceManager(discovery,'test'),driver={state:{host:'192.0.2.1',state:'connected'}};manager.drivers.set('tv',driver);let starts=0;manager.autoLive=()=>starts++;manager.retryLive('tv',driver);const first=callback;manager.retryLive('tv',driver);assert.equal(callback,first);assert.equal(delay,30000);callback();assert.equal(starts,1);assert.equal(manager.liveRetries.size,0);manager.liveOptOut.add('tv');callback=null;manager.retryLive('tv',driver);assert.equal(callback,null);manager.liveOptOut.clear();manager.retryLive('unknown',{state:{host:'192.0.2.2',state:'connected'}});assert.equal(callback,null);}finally{global.setTimeout=realTimer;store.updateSettings(previous);store.flush();}
});
test('a delayed foreground-app update does not hide newly playing Stremio',()=>{
 const current={source:'adb',appId:'com.stremio.one',title:'Current movie',playerState:'PLAYING'};const old={source:'cast',appId:'CA5E8412',title:'Netflix',duration:999,artwork:'old',playerState:'PAUSED'};assert.equal(selectMedia([state('androidtv','com.netflix.ninja',current),state('cast','CA5E8412',old)]),current);
});
test('media commands do not target stale Netflix Cast while Stremio plays natively',()=>{
 const {DeviceManager}=require('../dist/main/devices');const manager=new DeviceManager(new EventEmitter(),'test');
 manager.drivers.set('android',{capabilities:['keys'],state:state('androidtv','com.stremio.one',{source:'adb',appId:'com.stremio.one',title:'Current',playerState:'PLAYING'})});
 manager.drivers.set('cast',{capabilities:['media'],state:state('cast','CA5E8412',{source:'cast',appId:'CA5E8412',title:'Old',artwork:'art',duration:100,playerState:'PAUSED'})});
 assert.deepEqual(manager.mediaCapable(['android','cast']),[],'falls back to the primary remote keys');
});
test('corner skips target native Stremio instead of an old Netflix Cast session',async()=>{
 const {DeviceManager}=require('../dist/main/devices');const manager=new DeviceManager(new EventEmitter(),'test'),keys=[],seeks=[];
 manager.resolve=()=>({primary:'android',all:['android','cast']});
 manager.drivers.set('android',{capabilities:['keys'],state:state('androidtv','com.stremio.one',{source:'adb',appId:'com.stremio.one',title:'Current',playerState:'PLAYING'}),sendKey:async key=>keys.push(key)});
 manager.drivers.set('cast',{capabilities:['media'],state:state('cast','CA5E8412',{source:'cast',appId:'CA5E8412',title:'Old',artwork:'art',duration:100,currentTime:20,playerState:'PAUSED'}),seek:async pos=>seeks.push(pos)});
 await manager.skip('room',10);assert.deepEqual(keys,['FAST_FORWARD']);assert.deepEqual(seeks,[]);
});
test('corner skips seek the selected Cast session and clamp to its duration',async()=>{
 const {DeviceManager}=require('../dist/main/devices');const manager=new DeviceManager(new EventEmitter(),'test'),seeks=[];
 manager.resolve=()=>({primary:'cast',all:['cast']});manager.note=()=>{};
 manager.drivers.set('cast',{capabilities:['media'],state:state('cast','CA5E8412',{source:'cast',appId:'CA5E8412',duration:100,currentTime:95,playerState:'PAUSED'}),seek:async pos=>seeks.push(pos)});
 await manager.skip('room',10);assert.deepEqual(seeks,[100]);
});
test('repeated screenshot failures preserve healthy playback reporting',async()=>{
 const original=adb.shellQuick;adb.shellQuick=async()=>dump('com.stremio.one',3,'Still playing');
 const live=new AdbLive('192.0.2.1'),media=[],screen=[],errors=[];
 live.opts={media:true,screen:true};live.on('media',m=>media.push(m));live.on('screen',f=>screen.push(f));live.on('screenError',e=>errors.push(e));live.on('error',()=>assert.fail('screen failure must not stop playback'));
 try {
   live.fail(new Error('Screenshot unavailable'),'screen');live.fail(new Error('Screenshot unavailable'),'screen');
   assert.equal(live.options.screen,true);
   live.fail(new Error('Screenshot unavailable'),'screen');
   assert.deepEqual(live.options,{media:true,screen:false});assert.equal(errors.length,1);assert.deepEqual(screen,[null]);
   await live.pollMedia();assert.equal(media[0].title,'Still playing');
 } finally {live.stop();adb.shellQuick=original;}
});
test('Android TV exposes screen retry without dropping its current Stremio title',async()=>{
 const {AndroidTvDriver}=require('../dist/main/drivers/androidtv');
 const oldShell=adb.shellQuick,oldScreenshot=adb.screenshotRaw;
 adb.shellQuick=async()=>dump('com.stremio.one',3,'The Bear');adb.screenshotRaw=async()=>{throw new Error('Screen capture failed');};
 const driver=new AndroidTvDriver({...context,id:'androidtv:test',kind:'androidtv'});driver.update({state:'connected',currentApp:{id:'com.stremio.one'}});
 try {
   driver.setLiveView({media:true,screen:true});await new Promise(r=>setImmediate(r));
   await driver.live.pollScreen();await driver.live.pollScreen();
   assert.equal(driver.state.media.title,'The Bear');assert.deepEqual(driver.state.liveView,{media:true,screen:false});
   assert.equal(driver.state.screenError,'Screen capture failed');assert.equal(driver.state.playbackError,undefined);
   driver.setLiveView({media:true,screen:false});assert.equal(driver.state.screenError,undefined);
 } finally {driver.setLiveView(null);adb.shellQuick=oldShell;adb.screenshotRaw=oldScreenshot;}
});

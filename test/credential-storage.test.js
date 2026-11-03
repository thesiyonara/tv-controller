const assert = require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');const path=require('node:path');
const {stub,userData}=require('./helpers/electron-stub');
const file=path.join(userData,'android-tv-controller.json');
function fresh(){delete require.cache[require.resolve('../dist/main/store')];return require('../dist/main/store').getStore();}
test('unencrypted local storage never queries the OS keychain',()=>{
 stub.safeStorage.isEncryptionAvailable=()=>{throw new Error('Keychain must not be accessed');};
 const store=fresh();store.updateSettings({encryptCredentials:false});store.setCredential('test-tv',{token:'test-only'});store.flush();
 assert.equal(store.credentialsEncrypted(),false);assert.equal(JSON.parse(fs.readFileSync(file)).credentials['test-tv'].token,'test-only');
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
});
test('a stale temporary file cannot make saved pairings world-readable',()=>{
 const store=fresh();fs.writeFileSync(file+'.tmp','stale',{mode:0o644});fs.chmodSync(file+'.tmp',0o644);
 store.updateSettings({theme:'light'});store.flush();
 if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
});
test('declining keychain access never overwrites the encrypted pairings',()=>{
 fs.writeFileSync(file,JSON.stringify({credentials:{},credentialsEnc:'test-encrypted-payload',settings:{encryptCredentials:true}}));
 stub.safeStorage.isEncryptionAvailable=()=>true;stub.safeStorage.decryptString=()=>{throw new Error('User declined');};
 const store=fresh();assert.equal(store.getCredential('test-tv'),undefined);store.updateSettings({theme:'dark'});store.flush();
 assert.equal(JSON.parse(fs.readFileSync(file)).credentialsEnc,'test-encrypted-payload');
});

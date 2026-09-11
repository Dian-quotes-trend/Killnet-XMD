'use strict';
const assert=require('assert');
const {createRegistryFromLegacyMap}=require('../lib/live-command-adapter');
const {FEATURES}=require('../lib/planned-features');
const {createLocalJsonDatabase}=require('../lib/local-json-db');
const fs=require('fs');
const path=require('path');
(async()=>{
 const file=path.join('/tmp',`killnet-planned-${process.pid}.json`);try{fs.unlinkSync(file)}catch{}
 const db=createLocalJsonDatabase(file);const registry=createRegistryFromLegacyMap(new Map([['menu',{handler:async()=>{},category:'GENERAL'}]]));
 for(const name of Object.values(FEATURES).flat())assert.strictEqual(registry.has(name),true,`${name} must be registered`);
 const state=await db.get('planned.features',{features:{}});assert.deepStrictEqual(state.features,{});
 assert.strictEqual((await db.get('planned.features',{features:{}})).features.autoread,undefined);
 fs.rmSync(file,{force:true});console.log('planned feature inventory tests passed');
})();

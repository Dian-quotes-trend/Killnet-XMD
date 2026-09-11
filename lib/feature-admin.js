'use strict';
const path=require('path');
const {createLocalJsonDatabase}=require('./local-json-db');
const {FEATURES}=require('./planned-features');
const {COMMAND_CATEGORIES}=require('./command-categories');
function registerFeatureAdmin(registry,{db=createLocalJsonDatabase(path.resolve('./data/database.json'))}={}){
 const send=(ctx,text)=>ctx.sock.sendMessage(ctx.chatId,{text},{quoted:ctx.rawMessage});
 const all=Object.values(FEATURES).filter((_,i)=>i!==4).flat();
 if(!registry.has('feature-all'))registry.register({name:'feature-all',description:'Enable or disable configurable features',category:COMMAND_CATEGORIES.CONFIG,ownerOnly:true,handler:async ctx=>{const v=String(ctx.args?.[0]||'').toLowerCase();if(!['on','off'].includes(v))return send(ctx,'Usage: .feature-all on/off');await db.update('planned.features',s=>({...((s&&typeof s==='object')?s:{version:1,features:{},providers:{},groups:{}}),version:1,features:Object.fromEntries(all.map(k=>[k,v==='on']))}),{version:1,features:{},providers:{},groups:{}});return send(ctx,`✅ All configurable features: ${v.toUpperCase()}`)}});
 return registry;
}
module.exports={registerFeatureAdmin};

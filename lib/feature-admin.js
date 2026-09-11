'use strict';
const path=require('path');
const {createLocalJsonDatabase}=require('./local-json-db');
const {FEATURES}=require('./planned-features');
const {COMMAND_CATEGORIES}=require('./command-categories');
function registerFeatureAdmin(registry,{db=createLocalJsonDatabase(path.resolve('./data/database.json'))}={}){
 const send=(ctx,text)=>ctx.sock.sendMessage(ctx.chatId,{text},{quoted:ctx.rawMessage});
 const all=Object.values(FEATURES).flat();
 if(!registry.has('feature-all'))registry.register({name:'feature-all',description:'Enable or disable every planned feature',category:COMMAND_CATEGORIES.CONFIG,ownerOnly:true,handler:async ctx=>{const v=String(ctx.args?.[0]||'').toLowerCase();if(!['on','off'].includes(v))return send(ctx,'Usage: .feature-all on/off');await db.update('planned.features',s=>({...((s&&typeof s==='object')?s:{version:1,features:{},providers:{},groups:{}}),version:1,features:Object.fromEntries(all.map(k=>[k,v==='on']))}),{version:1,features:{},providers:{},groups:{}});return send(ctx,`✅ All planned features: ${v.toUpperCase()}`)}});
 if(!registry.has('setprovider'))registry.register({name:'setprovider',aliases:['provider'],description:'Configure a downloader/provider endpoint',category:COMMAND_CATEGORIES.CONFIG,ownerOnly:true,handler:async ctx=>{const n=String(ctx.args?.[0]||'').toLowerCase(),value=(ctx.args||[]).slice(1).join(' ');if(!n||!value)return send(ctx,'Usage: .setprovider <feature> <url-with-{query}>');await db.update('planned.features',s=>({...((s&&typeof s==='object')?s:{version:1,features:{},providers:{},groups:{}}),providers:{...((s&&s.providers)||{}),[n]:value}}),{version:1,features:{},providers:{},groups:{}});return send(ctx,`✅ Provider configured for ${n}.`)}});
 return registry;
}
module.exports={registerFeatureAdmin};

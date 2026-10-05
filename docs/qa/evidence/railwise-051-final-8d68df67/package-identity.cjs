const fs = require('node:fs');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const app='/Applications/RailWise AI.app';
const out='/Users/wangjiawei/Documents/WorkWise/docs/qa/evidence/railwise-051-final-8d68df67/local-package-identity.json';
function run(bin,args){const r=spawnSync(bin,args,{encoding:'utf8'});return {exitCode:r.status,stdout:r.stdout||'',stderr:r.stderr||'',...(r.error?{error:r.error.message}:{})}}
function hash(p){return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}
const info=path.join(app,'Contents/Info.plist');
const data={checkedAt:new Date().toISOString(),sourceHead:'8d68df67c16e3020c83dabf2f23f5a403ca5d257',candidateRun:36323753207,candidateNumber:162,app,
version:run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',info]),
bundle:run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',info]),
architecture:run('lipo',['-archs',path.join(app,'Contents/MacOS/RailWise AI')]),
signature:run('codesign',['--verify','--deep','--strict',app]),identity:run('codesign',['--display','--verbose=4',app]),
notarization:run('xcrun',['stapler','validate',app]),gatekeeper:run('spctl',['--status']),assessment:run('spctl',['--assess','--type','execute','--verbose=4',app]),
asarSha256:hash(path.join(app,'Contents/Resources/app.asar')),mountedAsarSha256:hash('/private/tmp/railwise-162-mounted/RailWise AI.app/Contents/Resources/app.asar'),
updateConfiguration:fs.readFileSync(path.join(app,'Contents/Resources/app-update.yml'),'utf8')};
const {verifyMacRuntimeEntitlements}=require('/Users/wangjiawei/Documents/WorkWise/scripts/mac-notarize.cjs')._internals;
try{verifyMacRuntimeEntitlements(app);data.runtimeEntitlements='passed'}catch(e){data.runtimeEntitlements={error:e.message}}
data.runtimeModules={};
for (const module of ['adapters/model/deepseek-compat-model-client.js','security/tool-persistence-security.js','adapters/tool/engineering-conversation-tools.js']) {
 const relative='Contents/Resources/app.asar.unpacked/kun/dist/'+module;
 data.runtimeModules[module]={installedSha256:hash(path.join(app,relative)),mountedSha256:hash(path.join('/private/tmp/railwise-162-mounted/RailWise AI.app',relative))};
}
const modelClient=fs.readFileSync(path.join(app,'Contents/Resources/app.asar.unpacked/kun/dist/adapters/model/deepseek-compat-model-client.js'),'utf8');
data.summaryFixPresent=modelClient.includes('Original arguments were omitted for privacy')&&!modelClient.includes('modelVisibleToolArguments');
if(!data.summaryFixPresent||Object.values(data.runtimeModules).some(x=>x.installedSha256!==x.mountedSha256))process.exitCode=1;
fs.writeFileSync(out,JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify(data,null,2));
if(data.version.stdout.trim()!=='0.5.1'||data.signature.exitCode!==0||data.notarization.exitCode!==0||data.asarSha256!==data.mountedAsarSha256||data.runtimeEntitlements!=='passed')process.exitCode=1;

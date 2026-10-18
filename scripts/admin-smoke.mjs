import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { io } from 'socket.io-client'

const temporary=mkdtempSync(join(tmpdir(),'wordpk-admin-'))
const server=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'3199',SOCKET_PORT:'3200',ADMIN_SETUP_CODE:'admin-smoke-code',ADMIN_AUTH_FILE:join(temporary,'auth.json'),BANNER_FILE:join(temporary,'banner.json'),LOG_FILE:join(temporary,'events.log')},stdio:['ignore','pipe','pipe']})
let socket
const api=async(path,options={})=>{
  const response=await fetch(`http://127.0.0.1:3199/api/admin/${path}`,options)
  return {response,data:await response.json()}
}
try{
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw new Error('server exited')})])
  let adminPage
  for(let attempt=0;attempt<40;attempt++){
    try{adminPage=await fetch('http://127.0.0.1:3199/admin');break}
    catch{await new Promise(resolve=>setTimeout(resolve,100))}
  }
  assert.ok(adminPage,'管理后台未启动')
  assert.equal(adminPage.status,200)
  assert.match(await adminPage.text(),/id="app"/)
  let result=await api('status')
  assert.deepEqual(result.data,{initialized:false,authenticated:false})
  result=await api('dashboard')
  assert.equal(result.response.status,401)
  result=await api('setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'short',setupCode:'admin-smoke-code'})})
  assert.equal(result.response.status,400)
  result=await api('setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'A sufficiently long admin password',setupCode:'wrong'})})
  assert.equal(result.response.status,403)
  result=await api('setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'A sufficiently long admin password',setupCode:'admin-smoke-code'})})
  assert.equal(result.response.status,200)
  const cookie=result.response.headers.get('set-cookie').split(';')[0]
  assert.ok(cookie.startsWith('wordpk_admin='))
  result=await api('setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'Another long password'})})
  assert.equal(result.response.status,409)
  socket=io('http://127.0.0.1:3200',{transports:['websocket'],reconnection:false})
  await once(socket,'connect')
  const created=await socket.timeout(3000).emitWithAck('room:create',{name:'后台测试房主',config:{mode:'standard'}})
  assert.equal(created.ok,true)
  result=await api('dashboard',{headers:{Cookie:cookie}})
  assert.equal(result.response.status,200)
  assert.equal(result.data.rooms.length,1)
  assert.equal(result.data.rooms[0].teamScores[1],0)
  assert.equal(result.data.rooms[0].players[0].name,'后台测试房主')
  assert.equal(result.data.banner,null)
  result=await api('banner',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'未授权公告',startAt:Date.now(),endAt:Date.now()+60000})})
  assert.equal(result.response.status,401)
  const now=Date.now()
  result=await api('banner',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({text:'维护通知',startAt:now-1000,endAt:now+60000})})
  assert.equal(result.response.status,200)
  let publicBanner=await (await fetch('http://127.0.0.1:3199/api/banner')).json()
  assert.equal(publicBanner.text,'维护通知')
  result=await api('banner',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({text:'稍后维护',startAt:now+60000,endAt:now+120000})})
  assert.equal(result.response.status,200)
  publicBanner=await (await fetch('http://127.0.0.1:3199/api/banner')).json()
  assert.equal(publicBanner.text,null)
  assert.equal(publicBanner.nextChangeAt,now+60000)
  result=await api('banner',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({text:''})})
  assert.equal(result.response.status,200)
  assert.equal((await api('dashboard',{headers:{Cookie:cookie}})).data.banner,null)
  result=await api('logout',{method:'POST',headers:{Cookie:cookie}})
  assert.equal(result.response.status,200)
  result=await api('dashboard',{headers:{Cookie:cookie}})
  assert.equal(result.response.status,401)
  result=await api('login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'A sufficiently long admin password'})})
  assert.equal(result.response.status,200)
  console.log('PASS: admin authentication, room data, scheduled banner, logout, and login')
}finally{
  socket?.disconnect()
  server.kill()
  rmSync(temporary,{recursive:true,force:true})
}

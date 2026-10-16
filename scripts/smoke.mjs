import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { io } from 'socket.io-client'

const server=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'3099',SOCKET_PORT:'3100',START_COUNTDOWN_MS:'120',LOG_FILE:'logs/smoke.log'},stdio:['ignore','pipe','pipe']})
const clients=[]
const decodeRoom=data=>{const config=data.g;return {code:data.c,host:data.h,config:{mode:config.m,size:config.z,rounds:config.r,seconds:config.s,unbalanced:Boolean(config.u),dictionary:config.d,target:config.t},teamNames:{1:data.n[0],2:data.n[1]},status:data.s,index:data.i,deadline:data.d??null,startsAt:data.a??null,marathonWinnerId:data.w??null,players:data.p.map(player=>({id:player.i,name:player.n,team:player.t,score:player.s,ready:Boolean(player.r),connected:Boolean(player.c)})),question:null,results:(data.r||[]).map(round=>({word:round.w,meaning:round.m,pos:round.o,answers:round.a.map(answer=>({playerId:answer.i,correct:Boolean(answer.c),points:answer.p,choice:answer.h,unanswered:Boolean(answer.u)}))})),finished:data.s==='finished'}}
const rpc=async(s,event,data)=>{const response=await s.timeout(3000).emitWithAck(event,data);if(response?.room)response.room=decodeRoom(response.room);return response}
const waitState=(socket,predicate)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.off('r',listener);reject(new Error('state timeout'))},6000)
  function listener(payload){const room=decodeRoom(payload);if(predicate(room)){clearTimeout(timer);socket.off('r',listener);resolve(room)}}
  socket.on('r',listener)
})
try {
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw new Error('server exited')})])
  let initialLoad
  for(let i=0;i<10;i++){
    const s=io('http://127.0.0.1:3100',{transports:['websocket'],reconnection:false}),loadPromise=i===0?once(s,'l'):null;clients.push(s);await once(s,'connect');if(loadPromise)[initialLoad]=await loadPromise
  }
  assert.equal(initialLoad.length,3)
  assert.ok(initialLoad.every(Number.isFinite))
  const clock=await clients[0].timeout(3000).emitWithAck('t')
  assert.equal(clock.length,2)
  assert.ok(clock[1]>=clock[0])
  const created=await rpc(clients[0],'room:create',{name:'Host',config:{size:2,rounds:1,seconds:10,unbalanced:true}})
  assert.equal(created.ok,true)
  assert.equal(created.room.config.size,5)
  assert.equal(created.room.config.rounds,20)
  assert.equal(created.room.config.seconds,5)
  assert.equal(created.room.config.unbalanced,false)
  assert.equal((await rpc(clients[0],'room:update-settings',{rounds:2,seconds:3,dictionary:'ky'})).ok,true)
  for(let i=1;i<10;i++)assert.equal((await rpc(clients[i],'room:join',{code:created.room.code,name:`Player ${i}`,team:i<5?1:2})).ok,true)
  let renamed=waitState(clients[1],r=>r.teamNames[1]==='烈焰先锋')
  assert.equal((await rpc(clients[0],'room:rename-team',{team:1,name:'烈焰先锋'})).ok,true)
  await renamed
  assert.equal((await rpc(clients[5],'room:rename-team',{team:1,name:'越权改名'})).ok,false)
  assert.equal((await rpc(clients[0],'game:start',{})).ok,false)
  let readyState=waitState(clients[0],r=>r.players.filter(p=>p.id!==r.host).every(p=>p.ready))
  await Promise.all(clients.slice(1,10).map(s=>rpc(s,'room:ready',{ready:true})))
  await readyState
  let countdownPromise=waitState(clients[0],r=>r.status==='countdown'&&r.startsAt>Date.now())
  let statePromise=waitState(clients[0],r=>r.status==='playing')
  const normalPrefetchPromise=once(clients[0],'q')
  assert.equal((await rpc(clients[0],'game:start',{})).ok,true)
  assert.equal((await countdownPromise).question,null)
  const [normalPrefetchPacket]=await normalPrefetchPromise
  assert.equal(normalPrefetchPacket[0],0)
  assert.equal(normalPrefetchPacket[1].length,2)
  assert.ok(normalPrefetchPacket[1].every(question=>question.length===3&&question[2].length===4))
  let room=await statePromise
  assert.equal(room.config.dictionary,'ky')
  assert.equal(room.players.length,10)
  const timings=[]
  assert.equal(room.question,null)
  assert.equal(new Set(normalPrefetchPacket[1][0][2].map(option=>option[1]+'|'+option[0])).size,4)
  let t=performance.now()
  const firstReplies=await Promise.all(clients.slice(0,9).map((s,i)=>rpc(s,'answer',{answer:i%4,index:0})))
  timings.push(performance.now()-t)
  assert.ok(firstReplies.every(reply=>reply[0]&&Number.isInteger(reply[2])&&Number.isInteger(reply[3])))
  const wrongIndex=firstReplies.findIndex(reply=>!reply[1])
  assert.ok(wrongIndex>=0)
  assert.deepEqual(await rpc(clients[0],'answer',{answer:0,index:0}),firstReplies[0])
  statePromise=waitState(clients[0],r=>r.index===1)
  room=await statePromise
  const negativeBefore=room.players.find(p=>p.id===clients[wrongIndex].id).score
  assert.ok(negativeBefore<0)
  t=performance.now()
  const secondParticipants=clients.slice(0,9).filter((_,i)=>i!==wrongIndex)
  const secondReplies=await Promise.all(secondParticipants.map(s=>rpc(s,'answer',{answer:0,index:1})))
  timings.push(performance.now()-t)
  assert.ok(secondReplies.every(reply=>reply[0]&&Number.isInteger(reply[3])))
  assert.equal((await rpc(secondParticipants[0],'answer',{answer:0,index:0}))[0],0)
  statePromise=waitState(clients[0],r=>r.index===2)
  room=await statePromise
  assert.equal(room.status,'finished')
  assert.equal(room.results.length,2)
  assert.ok(room.results.every(r=>r.answers.length===10&&r.answers.some(a=>a.unanswered)))
  assert.ok(room.players.every(p=>Number.isInteger(p.score)))
  assert.ok(room.players.find(p=>p.id===clients[wrongIndex].id).score<negativeBefore)
  assert.ok(room.results[1].answers.find(a=>a.playerId===clients[wrongIndex].id).points<0)
  const oldCode=room.code
  statePromise=waitState(clients[1],r=>r.status==='lobby'&&r.code===oldCode)
  assert.equal((await rpc(clients[0],'game:rematch',{})).ok,true)
  room=await statePromise
  assert.equal(room.players.length,10)
  assert.equal(room.results.length,0)
  assert.equal(room.teamNames[1],'烈焰先锋')
  assert.ok(room.players.every(p=>p.score===0))
  assert.ok(room.players.filter(p=>p.id!==room.host).every(p=>!p.ready))
  assert.equal((await rpc(clients[1],'game:rematch',{})).ok,false)
  readyState=waitState(clients[0],r=>r.players.filter(p=>p.id!==r.host).every(p=>p.ready))
  await Promise.all(clients.slice(1,10).map(s=>rpc(s,'room:ready',{ready:true})))
  await readyState
  countdownPromise=waitState(clients[0],r=>r.status==='countdown')
  statePromise=waitState(clients[0],r=>r.status==='playing')
  assert.equal((await rpc(clients[0],'game:start',{})).ok,true)
  await countdownPromise
  room=await statePromise
  assert.equal(room.code,oldCode)

  const duel=[]
  for(let i=0;i<2;i++){const s=io('http://127.0.0.1:3100',{transports:['websocket'],reconnection:false});clients.push(s);duel.push(s);await once(s,'connect')}
  const duelRoom=await rpc(duel[0],'room:create',{name:'Duel A',config:{size:1,rounds:1,seconds:3}})
  assert.equal(duelRoom.room.config.size,5)
  assert.equal((await rpc(duel[0],'room:update-settings',{rounds:1,seconds:3})).ok,true)
  assert.equal((await rpc(duel[1],'room:join',{code:duelRoom.room.code,name:'Duel B',team:2})).ok,true)
  assert.equal((await rpc(duel[0],'game:start',{})).ok,false)
  assert.equal((await rpc(duel[1],'room:ready',{ready:true})).ok,true)
  const duelFinished=waitState(duel[0],r=>r.status==='finished')
  assert.equal((await rpc(duel[0],'game:start',{})).ok,true)
  room=await duelFinished
  assert.equal(room.players.length,2)
  const duelGuestId=duel[1].id
  const duelOffline=waitState(duel[0],r=>r.status==='finished'&&r.players.find(p=>p.id===duelGuestId)?.connected===false)
  duel[1].disconnect()
  room=await duelOffline
  assert.equal(room.players.length,2)
  assert.equal(room.results.length,1)

  const uneven=[]
  for(let i=0;i<3;i++){const s=io('http://127.0.0.1:3100',{transports:['websocket'],reconnection:false});clients.push(s);uneven.push(s);await once(s,'connect')}
  const unevenRoom=await rpc(uneven[0],'room:create',{name:'Balance Host',config:{}})
  assert.equal((await rpc(uneven[1],'room:join',{code:unevenRoom.room.code,name:'Red 2',team:1})).ok,true)
  assert.equal((await rpc(uneven[2],'room:join',{code:unevenRoom.room.code,name:'Blue 1',team:2})).ok,true)
  await Promise.all(uneven.slice(1).map(s=>rpc(s,'room:ready',{ready:true})))
  assert.equal((await rpc(uneven[0],'game:start',{})).ok,false)

  const mixed=[]
  for(let i=0;i<3;i++){const s=io('http://127.0.0.1:3100',{transports:['websocket'],reconnection:false});clients.push(s);mixed.push(s);await once(s,'connect')}
  const mixedRoom=await rpc(mixed[0],'room:create',{name:'Mixed Host',config:{size:2,rounds:1,seconds:3,unbalanced:true}})
  assert.equal(mixedRoom.room.config.size,5)
  assert.equal(mixedRoom.room.config.unbalanced,false)
  assert.equal((await rpc(mixed[0],'room:update-settings',{rounds:1,seconds:3,unbalanced:true})).ok,true)
  assert.equal((await rpc(mixed[1],'room:join',{code:mixedRoom.room.code,name:'Red 2',team:1})).ok,true)
  assert.equal((await rpc(mixed[2],'room:join',{code:mixedRoom.room.code,name:'Blue 1',team:2})).ok,true)
  let switched=waitState(mixed[0],r=>r.players.find(p=>p.id===mixed[1].id)?.team===2)
  assert.equal((await rpc(mixed[1],'room:switch-team',{team:2})).ok,true)
  await switched
  switched=waitState(mixed[0],r=>r.players.find(p=>p.id===mixed[1].id)?.team===1)
  assert.equal((await rpc(mixed[1],'room:switch-team',{team:1})).ok,true)
  await switched
  await Promise.all(mixed.slice(1).map(s=>rpc(s,'room:ready',{ready:true})))
  assert.equal((await rpc(mixed[0],'game:start',{})).ok,true)

  const marathon=io('http://127.0.0.1:3100',{transports:['websocket'],reconnection:false});clients.push(marathon);await once(marathon,'connect')
  const marathonRoom=await rpc(marathon,'room:create',{name:'Runner',config:{mode:'marathon',size:2,rounds:10,seconds:3}})
  assert.equal(marathonRoom.room.config.mode,'marathon')
  assert.equal(marathonRoom.room.config.size,10)
  assert.equal(marathonRoom.room.config.target,4219)
  assert.equal(marathonRoom.room.players[0].team,null)
  assert.equal((await rpc(marathon,'room:update-settings',{seconds:3})).ok,true)
  const preview=await rpc(marathon,'room:preview',{code:marathonRoom.room.code})
  assert.equal(preview.preview.minMinutes,9)
  assert.equal(preview.preview.mode,'marathon')
  countdownPromise=waitState(marathon,r=>r.status==='countdown')
  statePromise=waitState(marathon,r=>r.status==='playing')
  const marathonPrefetchPromise=once(marathon,'q')
  assert.equal((await rpc(marathon,'game:start',{})).ok,true)
  await countdownPromise
  const [marathonPrefetchPacket]=await marathonPrefetchPromise
  room=await statePromise
  assert.equal(marathonPrefetchPacket[0],0)
  assert.equal(marathonPrefetchPacket[1].length,10)
  assert.ok(marathonPrefetchPacket[1].every(question=>question.length===3&&question[2].length===4))
  assert.equal(room.question,null)
  assert.equal(room.players.length,1)
  console.log(`PASS: room settings, balanced 1v1/5v5, rejected balanced 2v1, allowed unbalanced 2v1, marathon, countdown, scoring, rematch, unanswered penalty, and result matrix. Answer batch max ${Math.max(...timings).toFixed(1)} ms.`)
} finally {
  clients.forEach(s=>s.disconnect())
  server.kill()
}

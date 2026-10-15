import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
function loadWords(filename) {
  return readFileSync(join(root,filename),'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { const x=JSON.parse(line),c=x.content?.word?.content,t=c?.trans?.[0];return t?.tranCn?[{word:x.headWord,meaning:t.tranCn,pos:t.pos||'词',phonetic:c.usphone||c.ukphone||''}]:[] } catch { return [] } })
}
const dictionaries=Object.fromEntries(Object.entries({cet46:['四六级','cet46.data'],ky:['考研','ky.data'],cz:['中考','cz.data'],gz:['高考','gz.data']}).map(([key,[label,file]])=>{const words=loadWords(file),options=[...new Map(words.map(w=>[`${w.pos}|${w.meaning}`,{meaning:w.meaning,pos:w.pos}])).values()];return [key,{label,words,options}]}))
const webPort = Number(process.env.PORT || 3000)
const socketPort = Number(process.env.SOCKET_PORT || 3001)
const startCountdownMs = Number(process.env.START_COUNTDOWN_MS || 3000)
const MARATHON_TARGET = 4219
const MARATHON_MINUTES = {3:9,4:7,5:7,6:7,7:7,8:8,9:8,10:9}
const marathonMinutes = seconds => MARATHON_MINUTES[Number(seconds)] ?? MARATHON_MINUTES[5]
const logFile = resolve(process.env.LOG_FILE || join(root,'logs','wordpk.log'))
mkdirSync(dirname(logFile),{recursive:true})
const cleanIp = ip => String(ip || '').replace(/^::ffff:/,'')
function logEvent(event, data={}) {
  const entry={timestamp:new Date().toISOString(),event,...data}
  console.log(`[Word PK Log]\n${JSON.stringify(entry,null,2)}`)
  try { appendFileSync(logFile,`${JSON.stringify(entry)}\n`,'utf8') }
  catch (error) { console.error(`日志写入失败: ${error.message}`) }
}
const roomType = room => room.config.mode==='marathon'?'marathon':room.config.unbalanced?'unbalanced':'balanced'
const teamScore = (room,team) => {
  const players=[...room.players.values()].filter(player=>player.team===team)
  const sum=players.reduce((total,player)=>total+player.score,0)
  return room.config.unbalanced?Math.round(sum/(players.length||1)):sum
}
function logMatchEnd(room) {
  if(room.endLogged)return
  room.endLogged=true
  logEvent('match_finished',{roomCode:room.code,roomType:roomType(room),teamScores:room.config.mode==='marathon'?null:{[room.teamNames[1]]:teamScore(room,1),[room.teamNames[2]]:teamScore(room,2)},players:[...room.players.values()].map(player=>({name:player.name,team:player.team,score:player.score})),winner:room.config.mode==='marathon'?room.players.get(room.marathonWinnerId)?.name:null})
}
const app = express()
app.disable('etag')
app.use((req,res,next)=>{
  if(req.path==='/'||req.path.endsWith('.html'))res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate')
  next()
})
app.get('/api/runtime',(_,res)=>res.set('Cache-Control','no-store').json({mode:'server-authoritative',transport:'websocket',webPort,socketPort}))
app.use(express.static(join(root, 'dist'),{setHeaders:(res,path)=>{
  if(path.includes(`${join('dist','assets')}`))res.set('Cache-Control','public, max-age=31536000, immutable')
}}))
app.use((_, res) => res.set('Cache-Control','no-store').sendFile(join(root, 'dist', 'index.html')))
const webServer = createServer(app)
const socketServer = createServer()
const io = new Server(socketServer, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  transports: ['websocket'],
})
const rooms = new Map()
const code = () => Math.random().toString(36).slice(2, 7).toUpperCase()
function sample(pool, n) {
  const copy = [...pool]
  for (let i=0; i<Math.min(n,copy.length); i++) {
    const j=i+Math.floor(Math.random()*(copy.length-i));[copy[i],copy[j]]=[copy[j],copy[i]]
  }
  return copy.slice(0,n)
}
const pick = (room,n) => sample(dictionaries[room.config.dictionary].words,n)
function publicRoom(room) { return { code: room.code, host: room.host, config: room.config, teamNames: room.teamNames, status: room.status, index: room.index, deadline: room.deadline, startsAt: room.startsAt, marathonWinnerId: room.marathonWinnerId, players: [...room.players.values()], question: room.question && { word: room.question.word, phonetic: room.question.phonetic, options: room.question.options }, results: room.status === 'finished' ? room.results : [], finished: room.status === 'finished' } }
function emit(room) { io.to(room.code).emit('room:update', publicRoom(room)) }
function destroyRoom(room, message, reason='unknown') {
  if(rooms.get(room.code)!==room)return
  clearTimeout(room.timer);clearTimeout(room.startTimer)
  rooms.delete(room.code)
  logEvent('room_destroyed',{roomCode:room.code,roomType:roomType(room),ip:room.creatorIp,reason})
  if(message){io.to(room.code).emit('room:closed',{message});io.in(room.code).socketsLeave(room.code)}
}
function makeQuestion(room) {
  const answer=room.deck[room.index],right={meaning:answer.meaning,pos:answer.pos},options=dictionaries[room.config.dictionary].options
  const choices=sample([right,...sample(options.filter(x=>x.meaning!==answer.meaning),3)],4)
  room.answered=new Map();room.deadline=Date.now()+room.config.seconds*1000
  room.question={...answer,options:choices,answer:choices.findIndex(x=>x===right)}
  const expectedIndex=room.index
  room.timer=setTimeout(()=>finishQuestion(room,expectedIndex),room.config.seconds*1000)
}
function finishQuestion(room,expectedIndex) {
  if(room.status!=='playing'||room.index!==expectedIndex)return
  const answers=[...room.players.values()].map(p=>{
    const submitted=room.answered.get(p.id);if(submitted)return {playerId:p.id,...submitted}
    const previous=p.score;p.score=Math.round(previous>0?previous*0.9:previous<0?previous*1.1:0)
    return {playerId:p.id,correct:false,points:p.score-previous,choice:null,unanswered:true}
  })
  room.results.push({word:room.question.word,meaning:room.question.meaning,pos:room.question.pos,answers})
  room.index++
  if(room.config.mode==='marathon'){
    room.unansweredRounds=room.answered.size===0?(room.unansweredRounds||0)+1:0
    if(room.unansweredRounds>=10){destroyRoom(room,'马拉松已连续 10 题无人作答，房间已自动销毁','marathon_10_unanswered');return}
    if(room.marathonWinnerId){room.status='finished';room.question=null;room.deadline=null;room.timer=null;logMatchEnd(room);emit(room);return}
    room.deck.push(...pick(room,1))
  }
  if(room.index>=room.deck.length){room.status='finished';room.question=null;room.deadline=null;room.timer=null;logMatchEnd(room);emit(room);return}
  makeQuestion(room);emit(room)
}
function beginGame(room){
  if(room.status!=='countdown')return
  room.status='playing';room.startsAt=null;room.deck=room.config.mode==='marathon'?pick(room,1):pick(room,room.config.rounds)
  makeQuestion(room);emit(room)
}
io.on('connection', socket => {
  socket.on('t', done => {
    const serverReceived=Date.now()
    done?.([serverReceived,Date.now()])
  })
  socket.on('room:create', ({ name, config }, done) => {
    let id=code();while(rooms.has(id))id=code()
    const mode=config.mode==='marathon'?'marathon':'standard'
    const room={code:id,host:socket.id,creatorIp:cleanIp(socket.handshake.address),config:{mode,size:mode==='marathon'?10:5,rounds:mode==='marathon'?null:20,seconds:5,unbalanced:false,dictionary:'cet46',target:mode==='marathon'?MARATHON_TARGET:null},teamNames:{1:'赤焰队',2:'深蓝队'},players:new Map(),status:'lobby',index:0,results:[]}
    room.players.set(socket.id,{id:socket.id,name,team:mode==='marathon'?null:1,score:0,ready:true,connected:true});rooms.set(id,room);socket.join(id);logEvent('room_created',{roomCode:id,roomType:roomType(room),ip:room.creatorIp});done({ok:true,room:publicRoom(room)})
  })
  socket.on('room:preview', ({ code:id }, done) => { const room=rooms.get(id?.toUpperCase());if(!room)return done?.({ok:false,message:'房间码不存在'});if(room.status!=='lobby')return done?.({ok:false,message:'对战已经开始'});const capacity=room.config.mode==='marathon'?10:room.config.size*2;if(room.players.size>=capacity)return done?.({ok:false,message:'房间已满'});done?.({ok:true,preview:{code:room.code,mode:room.config.mode,seconds:room.config.seconds,target:room.config.target,minMinutes:room.config.mode==='marathon'?marathonMinutes(room.config.seconds):null,players:room.players.size,capacity}}) })
  socket.on('room:join', ({ code:id, name, team }, done) => { const room=rooms.get(id?.toUpperCase());if(!room)return done({ok:false,message:'房间码不存在'});if(room.status!=='lobby')return done({ok:false,message:'对战已经开始'});const marathon=room.config.mode==='marathon',capacity=marathon?10:room.config.size*2;if(room.players.size>=capacity)return done({ok:false,message:'房间已满'});if(!marathon&&[...room.players.values()].filter(p=>p.team===team).length>=room.config.size)return done({ok:false,message:'该队已满'});room.players.set(socket.id,{id:socket.id,name,team:marathon?null:team,score:0,ready:false,connected:true});socket.join(room.code);emit(room);done({ok:true,room:publicRoom(room)}) })
  socket.on('room:ready', ({ ready }, done) => { const room=[...rooms.values()].find(r=>r.players.has(socket.id));if(!room)return done?.({ok:false,message:'房间不存在'});if(room.status!=='lobby')return done?.({ok:false,message:'当前无法修改准备状态'});const player=room.players.get(socket.id);if(socket.id===room.host){player.ready=true;return done?.({ok:true})}player.ready=Boolean(ready);emit(room);done?.({ok:true}) })
  socket.on('room:update-settings', (patch, done) => { const room=[...rooms.values()].find(r=>r.host===socket.id);if(!room)return done?.({ok:false,message:'只有房主可以修改房间设置'});if(room.status!=='lobby')return done?.({ok:false,message:'对战开始后无法修改设置'});if(Object.hasOwn(patch||{},'seconds'))room.config.seconds=Math.min(10,Math.max(3,Number(patch.seconds)||5));if(Object.hasOwn(patch||{},'dictionary')&&dictionaries[patch.dictionary])room.config.dictionary=patch.dictionary;if(room.config.mode==='standard'){if(Object.hasOwn(patch||{},'rounds'))room.config.rounds=Math.min(50,Math.max(1,Number(patch.rounds)||20));if(Object.hasOwn(patch||{},'unbalanced'))room.config.unbalanced=Boolean(patch.unbalanced)}for(const player of room.players.values())player.ready=player.id===room.host;emit(room);done?.({ok:true}) })
  socket.on('room:switch-team', ({ team }, done) => { const room=[...rooms.values()].find(r=>r.players.has(socket.id));if(!room)return done?.({ok:false,message:'房间不存在'});if(room.config.mode==='marathon')return done?.({ok:true});if(room.status!=='lobby')return done?.({ok:false,message:'游戏已开始，无法换队'});if(team!==1&&team!==2)return done?.({ok:false,message:'队伍无效'});const player=room.players.get(socket.id);if(player.team===team)return done?.({ok:true});if([...room.players.values()].filter(p=>p.team===team).length>=room.config.size)return done?.({ok:false,message:'该队已满'});player.team=team;emit(room);done?.({ok:true}) })
  socket.on('room:rename-team', ({ team, name }, done) => { const room=[...rooms.values()].find(r=>r.players.has(socket.id));if(!room)return done?.({ok:false,message:'房间不存在'});if(room.status!=='lobby')return done?.({ok:false,message:'游戏已开始，无法修改队名'});const player=room.players.get(socket.id);if(player.team!==team)return done?.({ok:false,message:'只能修改自己队伍的名称'});const clean=String(name??'').trim().replace(/\s+/g,' ');if(!clean)return done?.({ok:false,message:'队名不能为空'});if([...clean].length>10)return done?.({ok:false,message:'队名最多 10 个字符'});room.teamNames[team]=clean;emit(room);done?.({ok:true}) })
  socket.on('game:start', (_, done) => { const room=[...rooms.values()].find(r=>r.host===socket.id);if(!room)return;const marathon=room.config.mode==='marathon',teams=[...room.players.values()].reduce((count,p)=>(count[p.team]=(count[p.team]||0)+1,count),{});const enoughPlayers=marathon?room.players.size>=1:teams[1]>0&&teams[2]>0&&(room.config.unbalanced||teams[1]===teams[2]);if(!enoughPlayers)return done?.({ok:false,message:room.config.unbalanced?'双方至少需要 1 人':'双方各至少 1 人且人数必须相等'});if([...room.players.values()].some(p=>p.id!==room.host&&!p.ready))return done?.({ok:false,message:'仍有队员未准备'});room.index=0;room.results=[];room.marathonWinnerId=null;room.question=null;room.deadline=null;room.endLogged=false;room.status='countdown';room.startsAt=Date.now()+startCountdownMs;logEvent('match_started',{roomCode:room.code,roomType:roomType(room),players:[...room.players.values()].map(player=>player.name),dictionary:dictionaries[room.config.dictionary].label,totalWords:marathon?null:room.config.rounds,speedSeconds:room.config.seconds});emit(room);room.startTimer=setTimeout(()=>beginGame(room),startCountdownMs);done?.({ok:true}) })
  socket.on('game:rematch', (_, done) => {
    const room=[...rooms.values()].find(r=>r.players.has(socket.id))
    if(!room)return done?.({ok:false,message:'房间不存在'})
    if(room.host!==socket.id)return done?.({ok:false,message:'只有房主可以发起下一局'})
    if(room.status!=='finished')return done?.({ok:false,message:'本局尚未结束'})
    clearTimeout(room.timer)
    for(const [id,player] of room.players){if(!player.connected)room.players.delete(id)}
    for(const player of room.players.values()){player.score=0;player.ready=player.id===room.host}
    room.status='lobby';room.index=0;room.results=[];room.deck=[];room.answered=new Map();room.question=null;room.deadline=null;room.startsAt=null;room.marathonWinnerId=null;room.unansweredRounds=0;room.timer=null;room.endLogged=false
    emit(room);done?.({ok:true})
  })
  socket.on('answer', ({ answer, index }, done) => { const room=[...rooms.values()].find(r=>r.players.has(socket.id));if(!room||room.status!=='playing'||index!==room.index||Date.now()>room.deadline||!Number.isInteger(answer)||answer<0||answer>3)return done?.({ok:false});if(room.answered.has(socket.id))return done?.(room.answered.get(socket.id));const p=room.players.get(socket.id),correct=answer===room.question.answer;const percent=Math.max(0,Math.min(100,Math.round((room.deadline-Date.now())/(room.config.seconds*10))));const points=correct?percent:-percent;p.score+=points;const result={ok:true,correct,answer:room.question.answer,points,choice:answer};room.answered.set(socket.id,result);if(room.config.mode==='marathon'&&p.score>MARATHON_TARGET&&!room.marathonWinnerId){room.marathonWinnerId=p.id;clearTimeout(room.timer);finishQuestion(room,index)}else emit(room);done?.(result) })
  socket.on('disconnect', () => { for(const room of rooms.values())if(room.players.has(socket.id)){const player=room.players.get(socket.id),retain=room.status==='playing'||room.status==='finished';if(retain)player.connected=false;else room.players.delete(socket.id);if(room.host===socket.id){const next=[...room.players.values()].find(p=>p.connected);if(next){room.host=next.id;next.ready=true}}if(![...room.players.values()].some(p=>p.connected))destroyRoom(room,null,'all_players_left');else emit(room)} })
})
webServer.listen(webPort, '0.0.0.0', () => console.log(`Word PK web: http://0.0.0.0:${webPort}`))
socketServer.listen(socketPort, '0.0.0.0', () => console.log(`Word PK socket: ws://0.0.0.0:${socketPort}`))

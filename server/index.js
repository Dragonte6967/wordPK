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
const MARATHON_TARGET = Number(process.env.MARATHON_TARGET || 4219)
const MARATHON_MINUTES = {3:162,4:35,5:18,6:14,7:12,8:12,9:12,10:12}
const marathonMinutes = seconds => MARATHON_MINUTES[Number(seconds)] ?? MARATHON_MINUTES[5]
const logFile = resolve(process.env.LOG_FILE || join(root,'logs','wordpk.log'))
mkdirSync(dirname(logFile),{recursive:true})
const cleanIp = ip => String(ip || '').replace(/^::ffff:/,'')
const logTimeFormatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
const roomTypeLabel={balanced:'平衡对战',unbalanced:'人数不平衡对战',marathon:'马拉松'}
const destroyReasonLabel={all_players_left:'所有玩家均已离开',marathon_10_unanswered:'马拉松连续 10 题无人作答',unknown:'未注明'}
function readableLog(entry) {
  const time=logTimeFormatter.format(new Date(entry.timestamp)),title=`\n[${time}]`
  if(entry.event==='room_created')return `${title} 房间已创建\n  房间码：${entry.roomCode}\n  赛制：${roomTypeLabel[entry.roomType]||entry.roomType}\n  创建者 IP：${entry.ip}`
  if(entry.event==='match_started')return `${title} 比赛开始\n  房间码：${entry.roomCode}\n  赛制：${roomTypeLabel[entry.roomType]||entry.roomType}\n  玩家：${entry.players.join('、')}\n  词库：${entry.dictionary}\n  单词总数：${entry.totalWords??'不限'}\n  答题速度：${entry.speedSeconds} 秒/题`
  if(entry.event==='match_finished'){
    const teams=entry.teamScores?Object.entries(entry.teamScores).map(([name,score])=>`${name} ${score} 分`).join('；'):'个人马拉松'
    const players=entry.players.map(player=>`${player.name} ${player.score} 分`).join('；')
    return `${title} 比赛结束\n  房间码：${entry.roomCode}\n  赛制：${roomTypeLabel[entry.roomType]||entry.roomType}\n  队伍成绩：${teams}\n  玩家成绩：${players}${entry.winner?`\n  获胜者：${entry.winner}`:''}`
  }
  if(entry.event==='room_destroyed')return `${title} 房间已销毁\n  房间码：${entry.roomCode}\n  赛制：${roomTypeLabel[entry.roomType]||entry.roomType}\n  原创建者 IP：${entry.ip}\n  原因：${destroyReasonLabel[entry.reason]||entry.reason}`
  return `${title} ${entry.event}\n${JSON.stringify(entry,null,2)}`
}
function logEvent(event, data={}) {
  const entry={timestamp:new Date().toISOString(),event,...data}
  console.log(readableLog(entry))
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
  perMessageDeflate: { threshold: 128 },
})
const rooms = new Map()
let loadState=[0,0,0]
let lastCpu=process.cpuUsage(),lastCpuAt=process.hrtime.bigint(),lastLoadTick=Date.now()
function updateLoad() {
  const now=process.hrtime.bigint(),elapsedUs=Number(now-lastCpuAt)/1000,cpu=process.cpuUsage(lastCpu)
  const cpuPercent=Math.min(100,Math.round((cpu.user+cpu.system)/Math.max(1,elapsedUs)*100))
  const tick=Date.now(),lag=Math.max(0,tick-lastLoadTick-5000),players=[...rooms.values()].reduce((total,room)=>total+room.players.size,0)
  const score=Math.min(100,Math.max(cpuPercent,Math.round(lag/2),Math.round(io.engine.clientsCount/2),rooms.size*2))
  loadState=[score,rooms.size,players];lastCpu=process.cpuUsage();lastCpuAt=now;lastLoadTick=tick
  io.compress(true).emit('l',loadState)
}
setInterval(updateLoad,5000).unref()
const code = () => Math.random().toString(36).slice(2, 7).toUpperCase()
function sample(pool, n) {
  const copy = [...pool]
  for (let i=0; i<Math.min(n,copy.length); i++) {
    const j=i+Math.floor(Math.random()*(copy.length-i));[copy[i],copy[j]]=[copy[j],copy[i]]
  }
  return copy.slice(0,n)
}
const pick = (room,n) => sample(dictionaries[room.config.dictionary].words,n)
const compactAnswer = answer => ({i:answer.playerId,c:answer.correct?1:0,p:answer.points,h:answer.choice,u:answer.unanswered?1:0})
const compactResult = result => ({w:result.word,m:result.meaning,o:result.pos,a:result.answers.map(compactAnswer)})
function publicRoom(room) {
  const config=room.config,data={c:room.code,h:room.host,g:{m:config.mode,z:config.size,r:config.rounds,s:config.seconds,u:config.unbalanced?1:0,d:config.dictionary,t:config.target},n:[room.teamNames[1],room.teamNames[2]],s:room.status,i:room.index,p:[...room.players.values()].map(player=>({i:player.id,n:player.name,t:player.team,s:player.score,r:player.ready?1:0,c:player.connected?1:0}))}
  if(room.deadline!=null)data.d=room.deadline
  if(room.startsAt!=null)data.a=room.startsAt
  if(room.marathonWinnerId)data.w=room.marathonWinnerId
  if(room.status==='finished')data.r=room.results.map(compactResult)
  return data
}
function emit(room) { io.to(room.code).compress(true).emit('r', publicRoom(room)) }
function emitScore(room,player) { io.to(room.code).emit('s',[room.index,player.id,player.score]) }
function destroyRoom(room, message, reason='unknown') {
  if(rooms.get(room.code)!==room)return
  clearTimeout(room.timer);clearTimeout(room.startTimer);clearTimeout(room.prefetchTimer)
  rooms.delete(room.code)
  logEvent('room_destroyed',{roomCode:room.code,roomType:roomType(room),ip:room.creatorIp,reason})
  if(message){io.to(room.code).compress(true).emit('x',message);io.in(room.code).socketsLeave(room.code)}
}
function buildQuestions(room,n) {
  const options=dictionaries[room.config.dictionary].options
  return pick(room,n).map(word=>{
    const right={meaning:word.meaning,pos:word.pos}
    const choices=sample([right,...sample(options.filter(x=>x.meaning!==word.meaning),3)],4)
    return {...word,options:choices,answer:choices.indexOf(right)}
  })
}
const publicQuestion = question => [question.word,question.phonetic,question.options.map(option=>[option.meaning,option.pos])]
function sendPrefetch(room,start,questions) {
  io.to(room.code).compress(true).emit('q',[start,questions.map(publicQuestion)])
}
function appendMarathonBatch(room) {
  if(room.status!=='playing')return
  const start=room.questions.length,batch=buildQuestions(room,10)
  room.questions.push(...batch);sendPrefetch(room,start,batch)
}
function makeQuestion(room) {
  const question=room.questions[room.index]
  if(!question)return
  room.answered=new Map();room.deadline=Date.now()+room.config.seconds*1000
  room.question=question
  const expectedIndex=room.index
  room.timer=setTimeout(()=>finishQuestion(room,expectedIndex),room.config.seconds*1000)
  if(room.config.mode==='marathon'&&expectedIndex%10===4){
    clearTimeout(room.prefetchTimer)
    room.prefetchTimer=setTimeout(()=>{room.prefetchTimer=null;if(room.status==='playing'&&room.index===expectedIndex)appendMarathonBatch(room)},room.config.seconds*30)
  }
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
  }
  if(room.index>=room.questions.length){room.status='finished';room.question=null;room.deadline=null;room.timer=null;logMatchEnd(room);emit(room);return}
  makeQuestion(room);emit(room)
}
function beginGame(room){
  if(room.status!=='countdown')return
  room.status='playing';room.startsAt=null
  makeQuestion(room);emit(room)
}
io.on('connection', socket => {
  socket.emit('l',loadState)
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
  socket.on('game:start', (_, done) => { const room=[...rooms.values()].find(r=>r.host===socket.id);if(!room)return;const marathon=room.config.mode==='marathon',teams=[...room.players.values()].reduce((count,p)=>(count[p.team]=(count[p.team]||0)+1,count),{});const enoughPlayers=marathon?room.players.size>=1:teams[1]>0&&teams[2]>0&&(room.config.unbalanced||teams[1]===teams[2]);if(!enoughPlayers)return done?.({ok:false,message:room.config.unbalanced?'双方至少需要 1 人':'双方各至少 1 人且人数必须相等'});if([...room.players.values()].some(p=>p.id!==room.host&&!p.ready))return done?.({ok:false,message:'仍有队员未准备'});room.index=0;room.results=[];room.marathonWinnerId=null;room.question=null;room.deadline=null;room.endLogged=false;room.questions=buildQuestions(room,marathon?10:room.config.rounds);room.status='countdown';room.startsAt=Date.now()+startCountdownMs;logEvent('match_started',{roomCode:room.code,roomType:roomType(room),players:[...room.players.values()].map(player=>player.name),dictionary:dictionaries[room.config.dictionary].label,totalWords:marathon?null:room.config.rounds,speedSeconds:room.config.seconds});emit(room);sendPrefetch(room,0,room.questions);room.startTimer=setTimeout(()=>beginGame(room),startCountdownMs);done?.({ok:true}) })
  socket.on('game:rematch', (_, done) => {
    const room=[...rooms.values()].find(r=>r.players.has(socket.id))
    if(!room)return done?.({ok:false,message:'房间不存在'})
    if(room.host!==socket.id)return done?.({ok:false,message:'只有房主可以发起下一局'})
    if(room.status!=='finished')return done?.({ok:false,message:'本局尚未结束'})
    clearTimeout(room.timer)
    for(const [id,player] of room.players){if(!player.connected)room.players.delete(id)}
    for(const player of room.players.values()){player.score=0;player.ready=player.id===room.host}
    room.status='lobby';room.index=0;room.results=[];room.questions=[];room.answered=new Map();room.question=null;room.deadline=null;room.startsAt=null;room.marathonWinnerId=null;room.unansweredRounds=0;room.timer=null;room.prefetchTimer=null;room.endLogged=false
    emit(room);done?.({ok:true})
  })
  socket.on('answer', ({ answer, index }, done) => { const room=[...rooms.values()].find(r=>r.players.has(socket.id));if(!room||room.status!=='playing'||index!==room.index||Date.now()>room.deadline||!Number.isInteger(answer)||answer<0||answer>3)return done?.([0]);if(room.answered.has(socket.id)){const result=room.answered.get(socket.id);return done?.([1,result.correct?1:0,result.answer,result.points,result.choice])}const correctAnswer=room.question.answer,p=room.players.get(socket.id),correct=answer===correctAnswer;const percent=Math.max(0,Math.min(100,Math.round((room.deadline-Date.now())/(room.config.seconds*10))));const points=correct?percent:-percent;p.score+=points;const result={ok:true,correct,answer:correctAnswer,points,choice:answer};room.answered.set(socket.id,result);if(room.config.mode==='marathon'&&p.score>MARATHON_TARGET&&!room.marathonWinnerId){room.marathonWinnerId=p.id;clearTimeout(room.timer);finishQuestion(room,index)}else emitScore(room,p);done?.([1,correct?1:0,correctAnswer,points,answer]) })
  socket.on('disconnect', () => { for(const room of rooms.values())if(room.players.has(socket.id)){const player=room.players.get(socket.id),retain=room.status==='playing'||room.status==='finished';if(retain)player.connected=false;else room.players.delete(socket.id);if(room.host===socket.id){const next=[...room.players.values()].find(p=>p.connected);if(next){room.host=next.id;next.ready=true}}if(![...room.players.values()].some(p=>p.connected))destroyRoom(room,null,'all_players_left');else emit(room)} })
})
webServer.listen(webPort, '0.0.0.0', () => console.log(`Word PK web: http://0.0.0.0:${webPort}`))
socketServer.listen(socketPort, '0.0.0.0', () => console.log(`Word PK socket: ws://0.0.0.0:${socketPort}`))

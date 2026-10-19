import { randomUUID } from 'node:crypto'

const delegated=new Set(['room:ready','room:update-settings','room:switch-team','room:rename-team','game:start','game:rematch','answer'])
export function createPeerRooms(io,{rooms,emit,dictionaries,destroyRoom,logEvent,logMatchEnd,roomType}) {
  const iceServers=JSON.parse(process.env.PEER_ICE_SERVERS||'[{"urls":"stun:stun.l.google.com:19302"}]')
  const find=id=>[...rooms.values()].find(r=>r.players.get(id)?.connected)
  function reset(room,message='低延时连接未完成，已保留服务器模式'){
    clearTimeout(room.peerTimer);room.peerTimer=null;room.peer=null
    for(const p of room.players.values())p.ready=p.id===room.host
    emit(room);io.to(room.code).emit('p:notice',message)
  }
  function fail(room){
    if(room.status==='lobby'||room.status==='finished')reset(room)
    else destroyRoom(room,'低延时连接已中断，本局已终止。请重新创建房间。','peer_connection_lost')
  }
  function drop(room,id){
    const player=room.players.get(id)
    if(!player||id===room.host)return
    const socket=io.sockets.sockets.get(id)
    socket?.emit('x','与房主的低延时连接已断开，请重新加入房间');socket?.leave(room.code)
    if(room.status==='lobby'){room.players.delete(id);reset(room,'队员已离线，已回到服务器模式')}
    else{player.connected=false;emit(room)}
  }
  function descriptor(room){return room.peer?{e:room.peer.epoch,s:room.peer.state,p:[...room.players.keys()].filter(id=>io.sockets.sockets.has(id)).map(id=>[id,io.sockets.sockets.get(id).data.peerId])}:null}
  function attach(socket){
    socket.data.peerId=`wp-${randomUUID()}`
    socket.use(([event,...args],next)=>{
      const room=find(socket.id)
      if(room?.peer&&(room.peer.state==='active'&&delegated.has(event)||event==='game:start')){
        const done=args.at(-1);if(typeof done==='function')done(event==='answer'?[0]:{ok:false,message:'请通过低延时连接操作；连接尚未就绪时无法开赛'})
        return
      }
      next()
    })
    socket.on('p:config',done=>done?.({id:socket.data.peerId,iceServers}))
    socket.on('p:upgrade',(_,done)=>{
      const room=find(socket.id)
      if(!room||room.host!==socket.id||room.status!=='lobby'||room.peer)return done?.({ok:false,message:'仅房主可在等待开赛时发起升级'})
      room.peer={epoch:randomUUID(),state:'connecting',beat:Date.now()}
      room.peerTimer=setTimeout(()=>{if(room.peer?.state==='connecting')reset(room)},25000)
      for(const p of room.players.values())p.ready=p.id===room.host
      emit(room);done?.({ok:true})
    })
    socket.on('p:activate',({e,ids}={},done)=>{
      const room=find(socket.id)
      if(!room?.peer||room.host!==socket.id||room.peer.epoch!==e||room.peer.state!=='connecting'||!Array.isArray(ids)||ids.length!==room.players.size||[...room.players.keys()].some(id=>!ids.includes(id)))return done?.({ok:false,message:'房间成员发生变化，请重新升级'})
      clearTimeout(room.peerTimer);room.peerTimer=null;room.peer.state='active';room.peer.beat=Date.now();emit(room);done?.({ok:true})
    })
    socket.on('p:cancel',({e}={},done)=>{
      const room=find(socket.id)
      if(!room?.peer||room.host!==socket.id||room.peer.epoch!==e||room.status!=='lobby')return done?.({ok:false,message:'当前无法切换模式'})
      reset(room,'已切回服务器模式');done?.({ok:true})
    })
    socket.on('p:fail',({e}={})=>{const room=find(socket.id);if(room?.peer?.epoch===e){if(room.peer.state==='active'&&room.host!==socket.id)drop(room,socket.id);else fail(room)}})
    socket.on('p:lost',({e,i}={})=>{const room=find(socket.id);if(room?.host===socket.id&&room.peer?.epoch===e)drop(room,i)})
    socket.on('p:beat',e=>{const room=find(socket.id);if(room?.host===socket.id&&room.peer?.epoch===e)room.peer.beat=Date.now()})
    socket.on('p:dictionary',({e,d}={},done)=>{
      const room=find(socket.id)
      if(room?.host!==socket.id||room.peer?.state!=='active'||room.peer.epoch!==e||!dictionaries[d])return done?.({ok:false,message:'当前无权下载裁判词库'})
      socket.compress(true);done?.({ok:true,words:dictionaries[d].words.map(w=>[w.word,w.meaning,w.pos,w.phonetic])})
    })
    socket.on('p:mirror',({e,r}={},done)=>{
      const room=find(socket.id),reject=()=>done?.({ok:false})
      if(!room?.peer||room.host!==socket.id||room.peer.epoch!==e||room.peer.state!=='active'||!r||!['lobby','countdown','playing','finished'].includes(r.s)||!Number.isSafeInteger(r.i)||r.i<0||!Array.isArray(r.p)||r.p.length>10)return reject()
      const ids=new Set(r.p.map(p=>p.i))
      if(ids.size!==r.p.length||r.p.some(p=>!room.players.has(p.i)||typeof p.s!=='number'||!Number.isFinite(p.s)||!Number.isInteger(p.s))||[...room.players.values()].some(p=>p.connected&&!ids.has(p.id)))return reject()
      const g=r.g
      if(!g||g.m!==room.config.mode||!dictionaries[g.d]||!Number.isInteger(g.s)||g.s<3||g.s>10||g.m==='standard'&&(!Number.isInteger(g.r)||g.r<1||g.r>50)||!Array.isArray(r.n)||r.n.length!==2||r.n.some(n=>typeof n!=='string'||[...n].length>10))return reject()
      const previous=room.status
      Object.assign(room.config,{seconds:g.s,rounds:g.m==='marathon'?null:g.r,dictionary:g.d,unbalanced:Boolean(g.u)})
      room.teamNames={1:r.n[0],2:r.n[1]};room.index=r.i;room.status=r.s;room.deadline=Number.isFinite(r.d)?r.d:null;room.startsAt=Number.isFinite(r.a)?r.a:null;room.marathonWinnerId=ids.has(r.w)?r.w:null
      for(const [id,p] of room.players){const mirrored=r.p.find(x=>x.i===id);if(!mirrored&&!p.connected)room.players.delete(id);else if(mirrored)Object.assign(p,{score:mirrored.s,ready:Boolean(mirrored.r),team:room.config.mode==='marathon'?null:mirrored.t===2?2:1})}
      if(r.s==='countdown'&&previous==='lobby'){room.endLogged=false;logEvent('match_started',{roomCode:room.code,roomType:roomType(room),authority:'browser-host',players:[...room.players.values()].map(p=>p.name),dictionary:dictionaries[room.config.dictionary].label,totalWords:room.config.rounds,speedSeconds:room.config.seconds})}
      if(r.s==='finished'&&previous!=='finished')logMatchEnd(room)
      done?.({ok:true})
    })
    socket.on('p:destroy',({e,reason}={})=>{
      const room=find(socket.id)
      if(room?.host===socket.id&&room.peer?.epoch===e&&reason==='marathon_10_unanswered')destroyRoom(room,'马拉松已连续 10 题无人作答，房间已自动销毁',reason)
    })
  }
  setInterval(()=>{for(const room of rooms.values())if(room.peer?.state==='active'&&Date.now()-room.peer.beat>20000)fail(room)},5000).unref()
  return {attach,descriptor,reset,fail}
}

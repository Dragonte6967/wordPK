import { HostGame, packRoom } from './hostGame.js'

export class PeerRoom {
  constructor({room,socket,server,onEvent,onError}) {
    this.room=room;this.socket=socket;this.server=server;this.onEvent=onEvent;this.onError=onError;this.epoch=room.peer.e;this.id=socket.id;this.host=room.host===this.id
    this.connections=new Map();this.ready=new Set([this.id]);this.pending=new Map();this.sequence=0;this.closed=false;this.activating=false;this.cache=new Map();this.queued=[]
    this.origin=Date.now();this.started=performance.now();this.now=()=>this.origin+performance.now()-this.started
    this.initialize().catch(error=>this.fail(error.message))
  }
  async initialize(){
    if(!window.RTCPeerConnection)throw new Error('当前浏览器不支持低延时连接')
    const [{Peer},config]=await Promise.all([import('peerjs'),this.serverCall('p:config',undefined)])
    if(this.closed)return
    const url=new URL(this.server)
    this.peer=new Peer(config.id,{host:url.hostname,port:Number(url.port)||(url.protocol==='https:'?443:80),secure:url.protocol==='https:',path:'/peerjs',config:{iceServers:config.iceServers},debug:0})
    this.peer.on('error',()=>this.fail('无法建立低延时连接，可能需要检查网络或 TURN 配置'))
    this.peer.on('disconnected',()=>{if(!this.closed)this.fail('低延时信令已断开')})
    this.peer.on('connection',connection=>this.accept(connection))
    this.peer.on('open',()=>{
      if(this.closed)return
      if(this.host)this.tryActivate()
      else{
        const hostPeer=this.room.peer.p.find(p=>p[0]===this.room.host)?.[1]
        if(!hostPeer)return this.fail('房主连接信息已失效')
        this.accept(this.peer.connect(hostPeer,{reliable:true,serialization:'json',metadata:{e:this.epoch,i:this.id}}),this.room.host)
      }
      this.heartbeat=setInterval(()=>{
        if(this.host)this.socket.emit('p:beat',this.epoch)
        else if(this.active)this.request('t',{}).catch(()=>this.fail('房主长时间未响应'))
      },5000)
    })
  }
  serverCall(event,data){return new Promise((resolve,reject)=>{
    const done=(error,result)=>error?reject(new Error('服务器响应超时')):result?.ok===false?reject(new Error(result.message||'请求失败')):resolve(result)
    if(data===undefined)this.socket.timeout(20000).emit(event,done)
    else this.socket.timeout(20000).emit(event,data,done)
  })}
  accept(connection,outgoingId){
    const id=outgoingId||connection.metadata?.i,expected=this.room.peer.p.find(p=>p[0]===id)?.[1]
    if(this.closed||expected!==connection.peer||(this.host?connection.metadata?.e!==this.epoch:id!==this.room.host)||this.connections.has(id)){connection.close();return}
    this.connections.set(id,connection)
    connection.on('open',()=>{if(this.host)connection.send(['v',this.epoch])})
    connection.on('data',data=>this.receive(id,data))
    connection.on('close',()=>{
      this.connections.delete(id);this.ready.delete(id)
      if(!this.closed){if(this.host&&this.active)this.socket.emit('p:lost',{e:this.epoch,i:id});else this.fail('队员与房主的低延时连接已断开')}
    })
    connection.on('error',()=>this.fail('低延时数据连接失败'))
  }
  receive(id,data){
    if(this.closed||!Array.isArray(data))return
    const [event,n,payload,arg]=data
    if(event==='v'&&n===this.epoch){
      if(this.host){this.ready.add(id);this.tryActivate()}
      else this.connections.get(id)?.send(['v',this.epoch])
    }else if(event==='c'&&this.host&&Number.isSafeInteger(n)){
      if(!this.engine){if(this.queued.length<32)this.queued.push([id,data]);return}
      if(typeof payload!=='string'||!arg||typeof arg!=='object')return
      if(payload==='snapshot'){this.connections.get(id)?.send(['r',packRoom(this.engine.room)]);this.connections.get(id)?.send(['a',n,{ok:true}]);return}
      this.engine.command(id,payload,arg).then(result=>{if(this.connections.get(id)?.open)this.connections.get(id).send(['a',n,result])}).catch(()=>this.fail('房主处理操作失败'))
    }else if(event==='a'&&!this.host){const pending=this.pending.get(n);if(pending){clearTimeout(pending.timer);this.pending.delete(n);pending.resolve(payload)}}
    else if(!this.host&&id===this.room.host&&['r','q','s','x'].includes(event))this.onEvent(event,n)
  }
  tryActivate(){
    if(this.closed||this.activating||!this.peer?.open||this.room.peer.s!=='connecting'||!this.room.players.every(p=>this.ready.has(p.id)))return
    this.activating=true
    this.serverCall('p:activate',{e:this.epoch,ids:[...this.ready]}).catch(error=>this.fail(error.message))
  }
  update(room){
    this.room=room
    if(room.peer.s==='active'&&!this.active){
      this.active=true
      if(this.host){
        this.engine=new HostGame(room,{now:this.now,emit:(event,data)=>this.broadcast(event,data),mirror:r=>{const {r:results,...snapshot}=r;this.socket.emit('p:mirror',{e:this.epoch,r:snapshot})},loadDictionary:async d=>{
          if(!this.cache.has(d)){const response=await this.serverCall('p:dictionary',{e:this.epoch,d});this.cache.set(d,response.words.map(w=>({word:w[0],meaning:w[1],pos:w[2],phonetic:w[3]})))}
          return this.cache.get(d)
        },destroy:reason=>this.socket.emit('p:destroy',{e:this.epoch,reason})})
        this.engine.publish()
        for(const [id,data] of this.queued)this.receive(id,data)
        this.queued=[]
      }else this.request('snapshot',{}).catch(error=>this.fail(error.message))
    }
    const roster=JSON.stringify(room.players.map(p=>[p.id,p.connected]))
    if(this.roster!==undefined&&this.roster!==roster&&this.engine)this.engine.roster(room.players)
    this.roster=roster
  }
  broadcast(event,data){
    if(this.closed)return
    this.onEvent(event,data)
    for(const connection of this.connections.values())if(connection.open)connection.send([event,data])
  }
  request(event,data={}){
    if(this.closed||!this.active)return Promise.reject(new Error('低延时连接尚未就绪'))
    if(this.host)return this.engine.command(this.id,event,data)
    const connection=this.connections.get(this.room.host)
    if(!connection?.open)return Promise.reject(new Error('未连接到房主'))
    const id=++this.sequence
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('房主响应超时'))},event==='game:start'?25000:8000)
      this.pending.set(id,{resolve,reject,timer});connection.send(['c',id,event,data])
    })
  }
  fail(message){if(this.closed)return;this.socket.emit('p:fail',{e:this.epoch});this.onError(message);this.dispose()}
  dispose(){
    if(this.closed)return
    this.closed=true;clearInterval(this.heartbeat);this.engine?.dispose()
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('低延时连接已关闭'))}
    this.pending.clear();for(const connection of this.connections.values())connection.close();this.connections.clear();this.peer?.destroy()
  }
}

// The browser host owns every game rule in peer mode. Only public snapshots leave it.
export const publicQuestion = q => [q.word,q.phonetic,q.options.map(o=>[o.meaning,o.pos])]
export function packRoom(room) {
  const g=room.config
  return {c:room.code,h:room.host,g:{m:g.mode,z:g.size,r:g.rounds,s:g.seconds,u:g.unbalanced?1:0,d:g.dictionary,t:g.target},n:[room.teamNames[1],room.teamNames[2]],s:room.status,i:room.index,d:room.deadline,a:room.startsAt,w:room.marathonWinnerId,p:room.players.map(p=>({i:p.id,n:p.name,t:p.team,s:p.score,r:p.ready?1:0,c:p.connected?1:0})),...(room.status==='finished'?{r:room.results.map(r=>({w:r.word,m:r.meaning,o:r.pos,a:r.answers.map(a=>({i:a.playerId,c:a.correct?1:0,p:a.points,h:a.choice,u:a.unanswered?1:0}))}))}:{})}
}
function sample(pool,n) {
  const copy=[...pool]
  for(let i=0;i<Math.min(n,copy.length);i++){const j=i+Math.floor(Math.random()*(copy.length-i));[copy[i],copy[j]]=[copy[j],copy[i]]}
  return copy.slice(0,n)
}
export class HostGame {
  constructor(room,{emit,mirror,loadDictionary,destroy,now=()=>Date.now(),countdownMs=3000}) {
    this.room=structuredClone(room);this.emit=emit;this.mirror=mirror;this.loadDictionary=loadDictionary;this.destroy=destroy;this.now=now;this.countdownMs=countdownMs
    this.questions=[];this.answered=new Map();this.unansweredRounds=0;this.disposed=false;this.starting=false;this.timers=new Set()
  }
  schedule(fn,ms){const timer=setTimeout(()=>{this.timers.delete(timer);if(!this.disposed)fn()},Math.max(0,ms));this.timers.add(timer);return timer}
  dispose(){this.disposed=true;for(const timer of this.timers)clearTimeout(timer);this.timers.clear()}
  publish(){if(this.disposed)return;const snapshot=packRoom(this.room);this.emit('r',snapshot);this.mirror(snapshot)}
  roster(players){
    for(const p of this.room.players){const current=players.find(x=>x.id===p.id);p.connected=Boolean(current?.connected)}
    this.publish()
  }
  build(n){
    const options=[...new Map(this.words.map(w=>[w.meaning,{meaning:w.meaning,pos:w.pos}])).values()]
    return sample(this.words,n).map(w=>{const right={meaning:w.meaning,pos:w.pos},choices=sample([right,...sample(options.filter(o=>o.meaning!==w.meaning),3)],4);return {...w,options:choices,answer:choices.indexOf(right)}})
  }
  prefetch(start,batch){this.emit('q',[start,batch.map(publicQuestion)])}
  next(){
    if(this.disposed)return
    const r=this.room,index=r.index
    if(!this.questions[index]){const batch=this.build(10),start=this.questions.length;this.questions.push(...batch);this.prefetch(start,batch)}
    r.question=this.questions[index];this.answered=new Map();r.deadline=this.now()+r.config.seconds*1000
    this.schedule(()=>this.finish(index),r.config.seconds*1000)
    if(r.config.mode==='marathon'&&index%10===4)this.schedule(()=>{if(r.status==='playing'&&r.index===index){const start=this.questions.length,batch=this.build(10);this.questions.push(...batch);this.prefetch(start,batch)}},r.config.seconds*30)
  }
  finish(index){
    const r=this.room
    if(this.disposed||r.status!=='playing'||r.index!==index)return
    const answers=r.players.map(p=>{
      const submitted=this.answered.get(p.id);if(submitted)return {playerId:p.id,...submitted}
      const previous=p.score;p.score=Math.round(previous>0?previous*.9:previous<0?previous*1.1:0)
      return {playerId:p.id,correct:false,points:p.score-previous,choice:null,unanswered:true}
    })
    r.results.push({word:r.question.word,meaning:r.question.meaning,pos:r.question.pos,answers});r.index++
    if(r.config.mode==='marathon'){
      this.unansweredRounds=this.answered.size===0?this.unansweredRounds+1:0
      if(this.unansweredRounds>=10){this.dispose();this.destroy('marathon_10_unanswered');return}
    }
    if(r.marathonWinnerId||(r.config.mode!=='marathon'&&r.index>=this.questions.length)){r.status='finished';r.question=null;r.deadline=null;this.publish();return}
    this.next();this.publish()
  }
  async command(id,event,data={}) {
    const r=this.room,p=r.players.find(x=>x.id===id&&x.connected),host=id===r.host,fail=message=>({ok:false,message})
    if(this.disposed||!p)return fail('当前连接已失效')
    if(event==='t'){const time=this.now();return [time,this.now()]}
    if(event==='answer'){
      const {answer,index}=data
      if(r.status!=='playing'||index!==r.index||this.now()>r.deadline||!Number.isInteger(answer)||answer<0||answer>3)return [0]
      if(this.answered.has(id)){const a=this.answered.get(id);return [1,a.correct?1:0,a.answer,a.points,a.choice]}
      const correctAnswer=r.question.answer,correct=answer===correctAnswer,percent=Math.max(0,Math.min(100,Math.round((r.deadline-this.now())/(r.config.seconds*10)))),points=correct?percent:-percent
      p.score+=points;this.answered.set(id,{correct,answer:correctAnswer,points,choice:answer})
      if(r.config.mode==='marathon'&&p.score>r.config.target&&!r.marathonWinnerId){r.marathonWinnerId=id;this.finish(index)}else this.emit('s',[index,id,p.score])
      return [1,correct?1:0,correctAnswer,points,answer]
    }
    if(event==='game:rematch'){
      if(!host||r.status!=='finished')return fail('只有房主能在结赛后发起下一局')
      for(const timer of this.timers)clearTimeout(timer);this.timers.clear()
      r.players=r.players.filter(x=>x.connected);for(const player of r.players){player.score=0;player.ready=player.id===r.host}
      r.status='lobby';r.index=0;r.results=[];r.question=null;r.deadline=null;r.startsAt=null;r.marathonWinnerId=null;this.questions=[];this.answered.clear();this.unansweredRounds=0;this.publish();return {ok:true}
    }
    if(r.status!=='lobby'||this.starting)return fail('当前无法修改房间或重复开赛')
    if(event==='room:ready'){p.ready=host||Boolean(data.ready)}
    else if(event==='room:update-settings'){
      if(!host)return fail('只有房主可以修改房间设置')
      if(Object.hasOwn(data,'seconds'))r.config.seconds=Math.min(10,Math.max(3,Math.round(Number(data.seconds)||5)))
      if(['cet46','ky','cz','gz','com','wtf'].includes(data.dictionary))r.config.dictionary=data.dictionary
      if(r.config.mode==='standard'){if(Object.hasOwn(data,'rounds'))r.config.rounds=Math.min(50,Math.max(1,Math.round(Number(data.rounds)||20)));if(Object.hasOwn(data,'unbalanced'))r.config.unbalanced=Boolean(data.unbalanced)}
      for(const player of r.players)player.ready=player.id===r.host
    }else if(event==='room:switch-team'){
      if(r.config.mode==='marathon')return {ok:true}
      if(data.team!==1&&data.team!==2)return fail('队伍无效')
      if(p.team!==data.team&&r.players.filter(x=>x.team===data.team).length>=r.config.size)return fail('该队已满')
      p.team=data.team
    }else if(event==='room:rename-team'){
      if(p.team!==data.team)return fail('只能修改自己的队伍名称')
      const name=String(data.name??'').trim().replace(/\s+/g,' ')
      if(!name||[...name].length>10)return fail('队名应为 1–10 个字符')
      r.teamNames[data.team]=name
    }else if(event==='game:start'){
      if(!host)return fail('只有房主可以开赛')
      const connected=r.players.filter(x=>x.connected),a=connected.filter(x=>x.team===1).length,b=connected.filter(x=>x.team===2).length
      if(r.config.mode!=='marathon'&&(!a||!b||(!r.config.unbalanced&&a!==b)))return fail('双方至少各 1 人，平衡模式人数必须相等')
      if(connected.some(x=>x.id!==r.host&&!x.ready))return fail('仍有队员未准备')
      this.starting=true
      try{this.words=await this.loadDictionary(r.config.dictionary);if(this.disposed)return fail('房间已关闭');if(this.words.length<4)throw new Error('词库不足')}
      catch(error){return fail(error.message||'房主下载词库失败，请重试')}
      finally{this.starting=false}
      r.index=0;r.results=[];r.marathonWinnerId=null;r.question=null;r.deadline=null;this.unansweredRounds=0
      for(const player of r.players)player.score=0
      this.questions=this.build(r.config.mode==='marathon'?10:r.config.rounds)
      r.status='countdown';r.startsAt=this.now()+this.countdownMs;this.publish();this.prefetch(0,this.questions)
      this.schedule(()=>{r.status='playing';r.startsAt=null;this.next();this.publish()},this.countdownMs)
      return {ok:true}
    }else return fail('未知操作')
    this.publish();return {ok:true}
  }
}

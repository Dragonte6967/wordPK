<script>
import { markRaw } from 'vue'
import Team from './Team.vue'
import { io } from 'socket.io-client'

export default {
  data() { const defaultServer=`${location.protocol}//${location.hostname}:3001`;return { socket: null, phase: 'home', room: null, message: '', noticeModal: '', settingsModal: false, serverDraft: '', loadWarning: false, pendingAction: null, teamRenameModal: null, teamNameDraft: '', serverLoad: [0,0,0], result: null, remaining: 0, now: Date.now(), timerId: null, clockOffset: 0, clockSamples: [], questionCache: [], marathonJoinPreview: null, name: localStorage.name || '', server: localStorage.wordPkServer || defaultServer, form: { mode: 'standard' }, join: { code: '', team: 1 }, copied: false } },
  computed: {
    me() { return this.room?.players.find(p => p.id === this.socket?.id) },
    isHost() { return this.room?.host === this.socket?.id },
    teamA() { return this.room?.players.filter(p => p.team === 1) || [] },
    teamB() { return this.room?.players.filter(p => p.team === 2) || [] },
    totalA() { const sum=this.teamA.reduce((n,p)=>n+p.score,0);return this.room?.config.unbalanced?Math.round(sum/(this.teamA.length||1)):sum },
    totalB() { const sum=this.teamB.reduce((n,p)=>n+p.score,0);return this.room?.config.unbalanced?Math.round(sum/(this.teamB.length||1)):sum },
    teamNameA() { return this.room?.teamNames?.[1] || '赤焰队' },
    teamNameB() { return this.room?.teamNames?.[2] || '深蓝队' },
    dictionaryName() { return ({cet46:'四六级',ky:'考研',cz:'中考',gz:'高考'})[this.room?.config.dictionary] || '四六级' },
    isMarathon() { return this.room?.config.mode === 'marathon' },
    populationReady() { return this.isMarathon ? this.room?.players.length>0 : this.teamA.length>0&&this.teamB.length>0&&(this.room?.config.unbalanced||this.teamA.length===this.teamB.length) },
    allReady() { return (this.room?.players||[]).every(p=>p.id===this.room?.host||p.ready) },
    canStart() { return this.populationReady&&this.allReady },
    startButtonText() { if(!this.populationReady)return '等待双方队员就位…';if(!this.allReady)return '等待队员准备…';return this.isMarathon?'开始马拉松！':'全员就位，开始 PK！' },
    startHint() { if(!this.populationReady)return this.isMarathon?'至少需要 1 人':this.room?.config.unbalanced?'双方至少各 1 人':'双方各至少 1 人且人数相等才能开战';if(!this.allReady)return '所有非房主队员准备后才能开始';return '全员已准备，可以开赛' },
    winner() { if(this.isMarathon)return `${this.room?.players.find(p=>p.id===this.room?.marathonWinnerId)?.name||this.ranking[0]?.name||'选手'}获胜`;return this.totalA === this.totalB ? '平局' : `${this.totalA > this.totalB ? this.teamNameA : this.teamNameB}获胜` },
    ranking() { return [...(this.room?.players||[])].sort((a,b)=>b.score-a.score) },
    countdownNumber() { return Math.max(1,Math.ceil(((this.room?.startsAt||this.now)-this.now)/1000)) },
    myRank() { return this.ranking.findIndex(p=>p.id===this.me?.id)+1 },
    myCorrect() { return (this.room?.results||[]).filter(r=>this.answerRecord(r,this.me?.id)?.correct).length },
    noticeTitle() { return this.noticeModal.includes('销毁')||this.noticeModal.includes('关闭')?'房间已关闭':'无法加入房间' },
    loadLevel() { return this.serverLoad[0]>=75?'负载较高':this.serverLoad[0]>=45?'负载一般':'运行流畅' },
    loadClass() { return this.serverLoad[0]>=75?'high':this.serverLoad[0]>=45?'medium':'low' }
  },
  mounted() { this.timerId=setInterval(()=>{this.now=Date.now()+this.clockOffset;this.remaining=this.room?.deadline?Math.max(0,this.room.deadline-this.now):0},100);this.connect() },
  beforeUnmount() { clearInterval(this.timerId);this.socket?.disconnect() },
  methods: {
    decodeRoom(data) {
      const config=data.g
      return {code:data.c,host:data.h,config:{mode:config.m,size:config.z,rounds:config.r,seconds:config.s,unbalanced:Boolean(config.u),dictionary:config.d,target:config.t},teamNames:{1:data.n[0],2:data.n[1]},status:data.s,index:data.i,deadline:data.d??null,startsAt:data.a??null,marathonWinnerId:data.w??null,players:data.p.map(player=>({id:player.i,name:player.n,team:player.t,score:player.s,ready:Boolean(player.r),connected:Boolean(player.c)})),question:null,results:(data.r||[]).map(round=>({word:round.w,meaning:round.m,pos:round.o,answers:round.a.map(answer=>({playerId:answer.i,correct:Boolean(answer.c),points:answer.p,choice:answer.h,unanswered:Boolean(answer.u)}))})),finished:data.s==='finished'}
    },
    connect() {
      if (this.socket?.active || this.socket?.connected) return true
      if (!this.server) { this.message='请输入服务器地址'; return false }
      this.socket?.disconnect()
      this.socket=markRaw(io(this.server, { transports: ['websocket'], timeout: 5000, reconnectionAttempts: 3 }))
      this.socket.on('connect', () => {
        this.clockSamples=[]
        this.syncClock()
      })
      this.socket.on('l', load => { if(Array.isArray(load))this.serverLoad=load })
      this.socket.on('q', ([start,questions]) => {
        for(let i=0;i<questions.length;i++){const question=questions[i];this.questionCache[start+i]={word:question[0],phonetic:question[1],options:question[2].map(option=>({meaning:option[0],pos:option[1]}))}}
        if(this.room?.status==='playing'&&this.questionCache[this.room.index])this.room={...this.room,question:this.questionCache[this.room.index]}
      })
      this.socket.on('s', ([index,playerId,score]) => {
        if(this.room?.status!=='playing'||this.room.index!==index)return
        const player=this.room.players.find(item=>item.id===playerId)
        if(player)player.score=score
      })
      this.socket.on('r', payload => {
        const room=this.decodeRoom(payload)
        if(room.status==='countdown'&&this.room?.status!=='countdown')this.questionCache=[]
        const questionChanged=room.status==='playing'&&(this.room?.status!=='playing'||this.room?.index!==room.index)
        if (this.room?.index !== room.index || this.room?.status !== room.status) this.result=null
        if(room.status==='playing')room.question=this.questionCache[room.index]||null
        this.room=room
        this.phase=room.status === 'lobby' ? 'lobby' : room.status === 'countdown' ? 'countdown' : room.status === 'playing' ? 'game' : 'result'
        if(questionChanged)this.syncClock()
      })
      this.socket.on('connect_error', () => this.message='无法连接服务器，请检查局域网地址')
      this.socket.on('x', message => { this.room=null;this.result=null;this.phase='home';this.showNotice(message||'房间已自动销毁') })
      return true
    },
    syncClock() {
      if(!this.socket?.connected)return
      const clientSent=Date.now(),started=performance.now()
      this.socket.timeout(3000).emit('t',(error,response)=>{
        if(error||!Array.isArray(response))return
        const clientReceived=Date.now(),rtt=performance.now()-started
        const offset=((response[0]-clientSent)+(response[1]-clientReceived))/2
        if(!Number.isFinite(offset)||!Number.isFinite(rtt))return
        this.clockSamples.push({offset,rtt})
        this.clockSamples=this.clockSamples.slice(-12)
        const best=[...this.clockSamples].sort((a,b)=>a.rtt-b.rtt).slice(0,Math.min(5,this.clockSamples.length))
        const offsets=best.map(sample=>sample.offset).sort((a,b)=>a-b)
        this.clockOffset=offsets[Math.floor(offsets.length/2)]
        this.now=Date.now()+this.clockOffset
      })
    },
    create() { if(!this.name.trim())return this.message='先取一个响亮的昵称';this.guardLoad('create') },
    createNow() { localStorage.name=this.name;this.connect();this.socket.emit('room:create',{name:this.name,config:this.form},r=>{if(r.ok){this.room=this.decodeRoom(r.room);this.phase='lobby'}}) },
    enter() { if(!this.name.trim())return this.message='先取一个响亮的昵称';if(!this.join.code.trim())return this.message='请输入房间码';this.guardLoad('join') },
    enterNow() { localStorage.name=this.name;this.connect();this.socket.emit('room:preview',{code:this.join.code},r=>{if(!r?.ok)return this.showNotice(r?.message||'无法读取房间');if(r.preview.mode==='marathon'){this.marathonJoinPreview=r.preview;this.message=''}else this.joinRoom()}) },
    guardLoad(action) { if(this.serverLoad[0]>=75){this.pendingAction=action;this.loadWarning=true}else action==='create'?this.createNow():this.enterNow() },
    continueWithLoad() { const action=this.pendingAction;this.loadWarning=false;this.pendingAction=null;if(action==='create')this.createNow();else if(action==='join')this.enterNow() },
    openSettings() { this.serverDraft=this.server;this.settingsModal=true },
    saveSettings() { const value=this.serverDraft.trim();if(!value)return;this.server=value;localStorage.wordPkServer=value;this.settingsModal=false;this.socket?.disconnect();this.socket=null;this.room=null;this.result=null;this.questionCache=[];this.phase='home';this.serverLoad=[0,0,0];this.connect() },
    joinRoom() { this.marathonJoinPreview=null;this.socket.emit('room:join',{code:this.join.code,name:this.name,team:this.join.team},r=>{if(r.ok){this.room=this.decodeRoom(r.room);this.phase='lobby';this.message=''}else this.showNotice(r.message||'无法加入房间')}) },
    cancelMarathonJoin() { this.marathonJoinPreview=null },
    showNotice(message) { this.message='';this.noticeModal=message },
    closeNotice() { this.noticeModal='' },
    start() { this.socket.emit('game:start',{},r=>{ if(!r.ok) this.message=r.message }) },
    switchTeam(team) { if(this.me?.team===team)return;this.socket.emit('room:switch-team',{team},r=>{if(!r?.ok)this.message=r?.message||'切换队伍失败';else this.message=''}) },
    toggleReady() { this.socket.emit('room:ready',{ready:!this.me?.ready},r=>{if(!r?.ok)this.message=r?.message||'准备状态更新失败';else this.message=''}) },
    updateSettings(patch) { if(!this.isHost)return;this.socket.emit('room:update-settings',patch,r=>{if(!r?.ok)this.message=r?.message||'房间设置更新失败';else this.message=''}) },
    renameTeam(team) { if(this.me?.team!==team)return;this.teamRenameModal=team;this.teamNameDraft=team===1?this.teamNameA:this.teamNameB },
    submitTeamName() { const team=this.teamRenameModal,name=this.teamNameDraft;this.socket.emit('room:rename-team',{team,name},r=>{if(!r?.ok)this.message=r?.message||'修改队名失败';else{this.message='';this.teamRenameModal=null}}) },
    rematch() { this.socket.emit('game:rematch',{},r=>{ if(!r?.ok) this.message=r?.message || '暂时无法再来一局' }) },
    answer(i) {
      if(this.result) return
      const index=this.room.index
      this.socket.timeout(5000).emit('answer',{answer:i,index},(error,payload)=>{
        if (error) { this.message='答题响应超时，请检查连接'; return }
        if (this.room?.index === index && payload?.[0]) this.result={ok:true,correct:Boolean(payload[1]),answer:payload[2],points:payload[3],choice:payload[4]}
      })
    },
    answerRecord(round,playerId) { return round.answers.find(a=>a.playerId===playerId) },
    racePosition(player) { return Math.max(0,Math.min(100,(player.score/(this.room?.config.target||4219))*100)) },
    marathonMinutes(seconds) { return ({3:9,4:7,5:7,6:7,7:7,8:8,9:8,10:9})[Number(seconds)] || 7 },
    async copy() {
      const value=this.room?.code
      if(!value)return
      let ok=false
      try { if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(value);ok=true} } catch {}
      if(!ok){
        const input=document.createElement('textarea')
        input.value=value;input.setAttribute('readonly','');input.style.position='fixed';input.style.left='-9999px';input.style.top='0'
        document.body.appendChild(input);input.focus();input.select();input.setSelectionRange(0,value.length)
        try { ok=document.execCommand('copy') } catch { ok=false }
        input.remove()
      }
      if(ok){this.copied=true;this.message='';setTimeout(()=>this.copied=false,1200)}else this.message=`复制失败，请长按房间码 ${value} 手动复制`
    },
    leave() { this.socket?.disconnect();this.socket=null;this.room=null;this.questionCache=[];this.phase='home';this.result=null;this.message='' }
  },
  components: { Team }
}
</script>
<template>

  <main><header><div class="headerBrand"><div class="brand"><span>W</span> WORD <b>PK</b></div><div class="serverLoad" :class="loadClass"><i></i><span>服务器负载 {{serverLoad[0]}}% · {{loadLevel}}</span></div></div><button class="settingsButton" @click="openSettings">⚙ 设置</button></header>
  <div v-if="settingsModal" class="modalMask" @click.self="settingsModal=false">
    <div class="marathonModal settingsModal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><span class="modalFlag">⚙</span><h2 id="settings-title">对战服务器设置</h2><p>设置 Socket.IO 对战服务地址。修改后会自动重新连接。</p><label>服务器地址<input v-model="serverDraft" placeholder="例如 http://192.168.1.10:3001" @keyup.enter="saveSettings"/></label><div class="modalActions"><button class="quiet" @click="settingsModal=false">取消</button><button @click="saveSettings">保存并连接</button></div></div>
  </div>
  <div v-if="loadWarning" class="modalMask" @click.self="loadWarning=false">
    <div class="marathonModal loadModal" role="alertdialog" aria-modal="true" aria-labelledby="load-title"><span class="modalFlag">⚠</span><h2 id="load-title">服务器负载较高</h2><div class="durationCallout"><small>当前服务器负载</small><strong>{{serverLoad[0]}}%</strong><span>{{serverLoad[1]}} 个房间 · {{serverLoad[2]}} 名玩家</span></div><p>当前负载可能影响游戏体验，建议稍后再试。</p><div class="modalActions"><button class="quiet" @click="loadWarning=false">稍后再试</button><button @click="continueWithLoad">仍然继续</button></div></div>
  </div>
  <div v-if="teamRenameModal" class="modalMask" @click.self="teamRenameModal=null">
    <div class="marathonModal settingsModal" role="dialog" aria-modal="true" aria-labelledby="rename-title"><span class="modalFlag">✎</span><h2 id="rename-title">修改队伍名称</h2><p>输入新的队名，最多 10 个字符。</p><input v-model="teamNameDraft" maxlength="10" autofocus @keyup.enter="submitTeamName"/><div class="modalActions"><button class="quiet" @click="teamRenameModal=null">取消</button><button @click="submitTeamName">确认修改</button></div></div>
  </div>
  <div v-if="noticeModal" class="modalMask" @click.self="closeNotice">
    <div class="marathonModal" role="alertdialog" aria-modal="true" aria-labelledby="notice-title">
      <span class="modalFlag">!</span><h2 id="notice-title">{{noticeTitle}}</h2>
      <p>{{noticeModal}}</p>
      <div class="modalActions"><button @click="closeNotice">我知道了</button></div>
    </div>
  </div>
  <div v-if="marathonJoinPreview" class="modalMask" @click.self="cancelMarathonJoin">
    <div class="marathonModal" role="dialog" aria-modal="true" aria-labelledby="marathon-title">
      <span class="modalFlag">🏁</span><h2 id="marathon-title">这是一场耐力赛</h2>
      <div class="durationCallout"><small>按当前房间设置</small><strong>至少 {{marathonJoinPreview.minMinutes}} 分钟</strong><span>才能完成一场比赛</span></div>
      <p>马拉松不分队，率先超过 {{marathonJoinPreview.target}} 分获胜。请确认你有足够时间和耐力完成比赛。</p>
      <small>当前 {{marathonJoinPreview.players}} / {{marathonJoinPreview.capacity}} 人 · {{marathonJoinPreview.seconds}} 秒/题</small>
      <div class="modalActions"><button class="quiet" @click="cancelMarathonJoin">暂不参加</button><button @click="joinRoom">确认并加入</button></div>
    </div>
  </div>
  <section v-if="phase==='home'" class="hero">
    <div class="eyebrow">VOCABULARY BATTLE</div><h1>背单词，<em>组队赢。</em></h1>
    <div class="serverPlaceholder" aria-hidden="true"></div>
    <div class="panels">
      <article><i>✦</i><h2>创建房间</h2><p>我来当房主，选择赛制并设置对局。</p><input v-model="name" placeholder="你的昵称" maxlength="12"/>
        <select v-model="form.mode" class="modeSelect"><option value="standard">组队 PK</option><option value="marathon">马拉松 · 先到 4219+</option></select>
        <div v-if="form.mode==='standard'" class="creationNote"><b>默认最多 5v5</b><small>单词数量、答题速度和是否允许人数不平衡，将由房主进入房间后设置。</small></div>
        <div v-else class="marathonNote"><b>🏁 马拉松耐力赛</b><strong>房间内会根据答题速度显示最短完赛时间</strong><small>按每题最快 2.3 秒（含扫视、选择与网络延时）估算；率先超过4219分获胜，需要一定的耐力</small></div>
        <button @click="create">创建对战房间 →</button>
      </article>
      <article class="join"><i>⌁</i><h2>加入房间</h2><p>输入朋友分享的房间码；马拉松中阵营选择不影响入房。</p><input v-model="name" placeholder="你的昵称" maxlength="12"/><input v-model="join.code" placeholder="房间码" maxlength="5" class="codeInput"/><div class="teams"><button :class="{chosen:join.team===1}" @click="join.team=1">赤焰队</button><button :class="{chosen:join.team===2}" @click="join.team=2">深蓝队</button></div><button @click="enter">加入战场 →</button></article>
    </div><p v-if="message" class="message">{{message}}</p>
  </section>
  <section v-else-if="phase==='lobby'" class="room">
    <div class="roomSettings" :class="{readonly:!isHost}"><div class="roomTop"><div><span class="eyebrow">ROOM CODE · 点击复制</span><h1><button class="codeCopy" :class="{copied}" :aria-label="copied?'房间码已复制':'复制房间码 '+room.code" :title="copied?'已复制':'点击复制房间码'" @click="copy">{{room.code}}</button></h1></div><button class="quiet" @click="leave">离开房间</button></div><div class="settingsTitle"><span class="eyebrow">ROOM SETTINGS</span><h3>{{isHost?'房间设置':'当前房间设置'}}</h3></div><label>词库<select :value="room.config.dictionary" :disabled="!isHost" @change="updateSettings({dictionary:$event.target.value})"><option value="cet46">四六级词库</option><option value="ky">考研词库</option><option value="cz">中考词库</option><option value="gz">高考词库</option></select></label><label v-if="!isMarathon">单词数量<select :value="room.config.rounds" :disabled="!isHost" @change="updateSettings({rounds:Number($event.target.value)})"><option :value="10">10 个</option><option :value="20">20 个</option><option :value="30">30 个</option><option :value="50">50 个</option></select></label><label>答题速度<select :value="room.config.seconds" :disabled="!isHost" @change="updateSettings({seconds:Number($event.target.value)})"><option v-for="s in 8" :key="s" :value="s+2">{{s+2}} 秒/题</option></select></label><label v-if="!isMarathon" class="roomToggle"><input type="checkbox" :checked="room.config.unbalanced" :disabled="!isHost" @change="updateSettings({unbalanced:$event.target.checked})"/><span><b>允许人数不平衡</b><small>{{room.config.unbalanced?'双方各有 1 人即可开战，团队按平均分':'双方人数相等即可开战，团队按总分'}}</small></span></label><div v-else class="roomDuration"><small>当前设置至少需要</small><strong>{{marathonMinutes(room.config.seconds)}} 分钟</strong><span>才能完赛，需要一定耐力</span></div><small v-if="isHost" class="settingsHint">修改设置会取消其他玩家的准备状态</small></div>
    <div class="gameRules"><h3>本局规则</h3><ul><li>本局使用 <b>{{dictionaryName}}词库</b></li><li>房主开始后，全员先进行服务器同步的 <b>3 秒倒计时</b></li><li><b>{{room.config.seconds}} 秒</b>后服务器自动切题{{isMarathon?'':'，共 '+room.config.rounds+' 题'}}</li><li>答对按剩余时间百分比加分，答错按相同比例扣分</li><li>未作答：正分降至原分的 <b>90%</b>，负分继续增加 <b>10%</b> 的惩罚</li><li v-if="isMarathon">马拉松：不分队，最多 10 人，率先超过 <b>{{room.config.target}}</b> 分的选手获胜</li><li v-else-if="room.config.unbalanced">人数不平衡：每队最多 5 人，双方各至少 1 人即可开始，团队分取队内平均分</li><li v-else>平衡对战：每队最多 5 人，双方各至少 1 人且人数相等即可开始，团队分为队员总分</li></ul></div>
    <div class="roomCompetition">
      <div v-if="isMarathon" class="marathonLobby"><Team title="马拉松选手" :players="room.players" :size="10" :host-id="room.host" :can-switch="false"/></div>
      <template v-else><div class="versus"><Team :title="teamNameA" :players="teamA" :size="room.config.size" :team="1" :host-id="room.host" :can-rename="me?.team===1" red @switch-team="switchTeam" @rename-team="renameTeam"/><b>VS</b><Team :title="teamNameB" :players="teamB" :size="room.config.size" :team="2" :host-id="room.host" :can-rename="me?.team===2" @switch-team="switchTeam" @rename-team="renameTeam"/></div><p class="switchHint">点击队名旁的 ✎ 可修改本队名称；点击空余位置的 ＋ 可切换队伍</p></template>
    </div>
    <div class="wait"><template v-if="isHost"><button class="start" :disabled="!canStart" @click="start">{{startButtonText}}</button><small>{{startHint}}</small></template><template v-else><button class="readyButton" :class="{isReady:me?.ready}" @click="toggleReady">{{me?.ready?'✓ 已准备（点击取消）':'准备就绪'}}</button><small>{{me?.ready?'已通知房主，等待其他玩家':'设置完成后请点击准备'}}</small></template></div>
    <p v-if="message" class="message">{{message}}</p>
  </section>
  <section v-else-if="phase==='countdown'" class="countdownPage"><span class="eyebrow">GET READY</span><div class="countdownNumber" :key="countdownNumber">{{countdownNumber}}</div><h2>{{isMarathon?'马拉松即将开始':'对战即将开始'}}</h2><p>服务器正在同步所有选手</p></section>
  <section v-else-if="phase==='game'" class="game">
    <div v-if="isMarathon" class="marathonHead"><strong>🏁 目标 {{room.config.target}}+</strong><span>第 {{room.index+1}} 题</span><b>当前第一名 {{ranking[0]?.name}} {{ranking[0]?.score}} 分</b></div>
    <div v-else class="score"><strong class="redText">{{teamNameA}}{{room.config.unbalanced?' 平均 ': ' '}}{{totalA}}</strong><span>第 {{room.index+1}} / {{room.config.rounds}} 题</span><strong class="blueText">{{teamNameB}}{{room.config.unbalanced?' 平均 ': ' '}}{{totalB}}</strong></div>
    <div v-if="isMarathon" class="raceTrack"><div class="raceRail"><div class="raceFill" :style="{width:racePosition(ranking[0])+'%'}"></div><span class="finishFlag">4219</span><div v-for="p in room.players.filter(x=>x.id!==me?.id)" :key="p.id" class="racePin other" :style="{left:racePosition(p)+'%'}" :title="p.name+' '+p.score+'分'"><i>{{p.name[0]}}</i><small>{{p.score}}</small></div><div v-if="me" class="racePin mine" :style="{left:racePosition(me)+'%'}" :title="me.name+' '+me.score+'分'"><i>{{me.name[0]}}</i><small>我 {{me.score}}</small></div></div></div>
    <div class="timer"><div :style="{width:(remaining/(room.config.seconds*10))+'%'}"></div><b>{{Math.ceil(remaining/1000)}}s</b></div>
    <div class="question"><span class="eyebrow">SELECT THE CORRECT MEANING</span><h1>{{room.question.word}}</h1><p>/ {{room.question.phonetic}} /</p>
      <div class="options"><button v-for="(o,i) in room.question.options" :key="o.pos+o.meaning" @click="answer(i)" :disabled="!!result" :class="{correct:result && i===result.answer}"><b>{{'ABCD'[i]}}</b><small>{{o.pos}}</small>{{o.meaning}}</button></div>
      <div class="feedback"><template v-if="result"><span :class="result.correct?'good':'bad'">{{result.correct?`答对了！ +${result.points} 分`:`答错了！ ${result.points} 分`}}</span></template><span v-else>剩余时间决定本题得分</span><small>服务器将在倒计时结束后自动切题</small></div>
    </div>
  </section>
  <section v-else class="resultPage">
    <span class="eyebrow">MATCH COMPLETE</span><h1>{{winner}}</h1>
    <div v-if="isMarathon" class="marathonChampion"><span>🏆 马拉松冠军</span><strong>{{ranking[0]?.score}}</strong><small>率先超过 {{room.config.target}} 分</small></div>
    <div v-else class="final"><div><b>{{teamNameA}}{{room.config.unbalanced?'（平均）':''}}</b><strong>{{totalA}}</strong></div><i>VS</i><div><b>{{teamNameB}}{{room.config.unbalanced?'（平均）':''}}</b><strong>{{totalB}}</strong></div></div>
    <div v-if="me" class="personal"><span>我的结算</span><strong>{{me.score}} 分</strong><b>第 {{myRank}} 名 · 答对 {{myCorrect}} / {{room.results.length}}</b></div>
    <div class="ranking"><div v-for="(p,i) in ranking" :key="p.id" :class="{mine:p.id===me?.id}"><b :class="{offline:!p.connected}">#{{i+1}} {{p.name}}</b><span>{{isMarathon?'马拉松':p.team===1?teamNameA:teamNameB}}</span><strong>{{p.score}}</strong></div></div>
    <div class="detailWrap"><table><thead><tr><th>单词</th><th v-for="p in room.players" :key="p.id" :class="{offline:!p.connected}">{{p.name}}</th></tr></thead><tbody><tr v-for="(round,i) in room.results" :key="round.word+i"><th><b>{{round.word}}</b><small>{{round.pos}}. {{round.meaning}}</small></th><td v-for="p in room.players" :key="p.id" :class="answerRecord(round,p.id)?.correct?'right':'wrong'"><template v-if="answerRecord(round,p.id)?.unanswered">未答 {{answerRecord(round,p.id).points}}</template><template v-else-if="answerRecord(round,p.id)?.correct">✓ +{{answerRecord(round,p.id).points}}</template><template v-else>× {{answerRecord(round,p.id)?.points || 0}}</template></td></tr></tbody></table></div>
    <div class="resultActions">
      <template v-if="isHost"><button class="rematch" @click="rematch">原班人马，再来一局</button><small>保留房间码、{{isMarathon?'选手':'队伍'}}和本局设置</small></template>
      <template v-else><div class="rematchWait"><div class="pulse"></div><span>等待房主发起下一局</span></div></template>
      <button class="quiet" @click="leave">返回首页</button>
    </div>
    <p v-if="message" class="message">{{message}}</p>
  </section></main>
</template>


<script>
export default {
  data(){return {phase:'loading',password:'',confirmPassword:'',setupCode:'',error:'',busy:false,dashboard:null,timer:null}},
  computed:{
    rooms(){return this.dashboard?.rooms||[]},
    history(){return this.dashboard?.history||[]},
    labels(){return {balanced:'平衡对战',unbalanced:'人数不平衡',marathon:'马拉松',lobby:'等待开赛',countdown:'开赛倒计时',playing:'答题中',finished:'已结赛'}},
    updatedAt(){return this.dashboard?.now?new Date(this.dashboard.now).toLocaleTimeString('zh-CN',{hour12:false}):'—'}
  },
  mounted(){this.initialize()},
  beforeUnmount(){clearInterval(this.timer)},
  methods:{
    async api(path,options={}){
      const response=await fetch(`/api/admin/${path}`,{credentials:'same-origin',cache:'no-store',...options,headers:options.body?{'Content-Type':'application/json'}:{}})
      const data=await response.json()
      if(!response.ok)throw Object.assign(new Error(data.error||'请求失败'),{status:response.status})
      return data
    },
    async initialize(){
      try{const state=await this.api('status');this.phase=state.authenticated?'dashboard':state.initialized?'login':'setup';if(state.authenticated)await this.refresh()}
      catch{this.phase='error';this.error='无法读取后台状态，请检查服务器连接'}
    },
    async submit(){
      if(this.busy)return
      this.error=''
      if(this.phase==='setup'&&this.password!==this.confirmPassword){this.error='两次输入的密码不一致';return}
      if(this.phase==='setup'&&this.password.length<12){this.error='密码至少需要 12 个字符';return}
      this.busy=true
      try{await this.api(this.phase==='setup'?'setup':'login',{method:'POST',body:JSON.stringify({password:this.password,setupCode:this.setupCode})});this.password='';this.confirmPassword='';this.setupCode='';this.phase='dashboard';await this.refresh()}
      catch(error){this.error=error.message;if(error.status===409)this.phase='login'}
      finally{this.busy=false}
    },
    async refresh(){
      try{this.dashboard=await this.api('dashboard');this.error='';if(!this.timer)this.timer=setInterval(()=>this.refresh(),5000)}
      catch(error){if(error.status===401){clearInterval(this.timer);this.timer=null;this.dashboard=null;this.phase='login'}else this.error='数据暂时无法更新，正在重试'}
    },
    async logout(){try{await this.api('logout',{method:'POST'})}finally{clearInterval(this.timer);this.timer=null;this.dashboard=null;this.phase='login';this.password=''}},
    chartPath(field,max){
      const samples=this.history
      if(!samples.length)return ''
      const ceiling=Math.max(max,...samples.map(item=>item[field]),1)
      return samples.map((item,index)=>`${index?'L':'M'} ${24+(index/Math.max(samples.length-1,1))*672} ${142-(item[field]/ceiling)*112}`).join(' ')
    },
    chartArea(field,max){const path=this.chartPath(field,max);return path?`${path} L 696 142 L 24 142 Z`:''},
    time(value){return value?new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'—'},
    roomProgress(room){return room.mode==='marathon'?`第 ${room.index+1} 题`:`${room.index} / ${room.rounds} 题`}
  }
}
</script>

<template>
  <main class="adminShell">
    <header class="adminHeader"><a class="adminBrand" href="/"><span>W</span> WORD <b>PK</b></a><div class="adminHeaderRight"><span>管理后台</span><button v-if="phase==='dashboard'" class="textButton" @click="logout">退出登录</button></div></header>
    <section v-if="phase==='loading'" class="authWrap"><div class="authCard"><h1>正在连接后台…</h1></div></section>
    <section v-else-if="phase==='error'" class="authWrap"><div class="authCard"><h1>连接失败</h1><p>{{error}}</p><button @click="initialize">重试</button></div></section>
    <section v-else-if="phase==='setup'||phase==='login'" class="authWrap"><form class="authCard" @submit.prevent="submit">
      <span class="eyebrow">ADMIN CONSOLE</span><h1>{{phase==='setup'?'设置管理员密码':'管理员登录'}}</h1>
      <p>{{phase==='setup'?'首次使用后台，请输入服务器控制台中的初始化码，并设置至少 12 位的管理员密码。':'输入管理员密码查看实时房间和服务器运行状态。'}}</p>
      <label v-if="phase==='setup'">初始化码<input v-model="setupCode" type="text" autocomplete="off" required placeholder="服务器控制台中的初始化码"/></label>
      <label>管理员密码<input v-model="password" type="password" :autocomplete="phase==='setup'?'new-password':'current-password'" minlength="12" maxlength="256" required autofocus placeholder="请输入密码"/></label>
      <label v-if="phase==='setup'">确认密码<input v-model="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="256" required placeholder="再次输入密码"/></label>
      <p v-if="error" class="error" role="alert">{{error}}</p><button :disabled="busy" type="submit">{{busy?'请稍候…':phase==='setup'?'设置密码并进入后台':'登录后台'}}</button>
    </form></section>
    <section v-else class="dashboard">
      <div class="dashboardTitle"><div><span class="eyebrow">LIVE OVERVIEW</span><h1>服务器概览</h1><p>每 5 秒更新 · 上次更新 {{updatedAt}}</p></div><span class="liveBadge"><i></i> 实时监控</span></div>
      <p v-if="error" class="error" role="alert">{{error}}</p>
      <div class="stats"><article><span>服务器负载</span><strong>{{dashboard?.load.percent??0}}<small>%</small></strong><p>综合 CPU、延迟与连接量</p></article><article><span>当前房间</span><strong>{{dashboard?.load.rooms??0}}</strong><p>包括等待、对战和已结赛房间</p></article><article><span>房间玩家</span><strong>{{dashboard?.load.players??0}}</strong><p>当前房间中的玩家总数</p></article></div>
      <div class="charts"><article class="chartCard"><div class="chartHead"><div><span class="eyebrow">SERVER LOAD</span><h2>服务器负载</h2></div><strong>{{dashboard?.load.percent??0}}%</strong></div><div class="chartPlot"><svg viewBox="0 0 720 160" preserveAspectRatio="none" role="img" aria-label="最近 30 分钟服务器负载曲线"><path class="gridLine" d="M 24 30 H 696 M 24 86 H 696 M 24 142 H 696"/><path class="loadArea" :d="chartArea('load',100)"/><path class="loadLine" :d="chartPath('load',100)"/></svg><span class="axisTop">100%</span><span class="axisBottom">0%</span></div><div class="chartFoot"><span>{{time(history[0]?.time)}}</span><span>最近 30 分钟</span><span>{{time(history.at(-1)?.time)}}</span></div></article>
      <article class="chartCard"><div class="chartHead"><div><span class="eyebrow">ACTIVE ROOMS</span><h2>房间数量</h2></div><strong>{{dashboard?.load.rooms??0}}</strong></div><div class="chartPlot"><svg viewBox="0 0 720 160" preserveAspectRatio="none" role="img" aria-label="最近 30 分钟房间数量曲线"><path class="gridLine" d="M 24 30 H 696 M 24 86 H 696 M 24 142 H 696"/><path class="roomArea" :d="chartArea('rooms',Math.max(5,...history.map(item=>item.rooms)))"/><path class="roomLine" :d="chartPath('rooms',Math.max(5,...history.map(item=>item.rooms)))"/></svg><span class="axisTop">{{Math.max(5,...history.map(item=>item.rooms))}}</span><span class="axisBottom">0</span></div><div class="chartFoot"><span>{{time(history[0]?.time)}}</span><span>最近 30 分钟</span><span>{{time(history.at(-1)?.time)}}</span></div></article></div>
      <div class="roomTitle"><div><span class="eyebrow">ROOMS</span><h2>当前房间 <small>{{rooms.length}}</small></h2></div></div>
      <div v-if="!rooms.length" class="emptyRooms">目前没有已创建的房间</div>
      <div v-else class="roomGrid"><article v-for="room in rooms" :key="room.code" class="roomCard"><div class="roomCardHead"><div><strong>{{room.code}}</strong><span>{{labels[room.mode]}}</span></div><span class="status" :class="room.status">{{labels[room.status]}}</span></div><p class="roomMeta">{{({cet46:'四六级',ky:'考研',cz:'中考',gz:'高考'})[room.dictionary]}}词库 · {{room.seconds}} 秒/题 · {{roomProgress(room)}} · {{room.players.length}} 人</p>
        <div v-if="room.mode==='marathon'" class="marathonScores"><div v-for="(player,index) in [...room.players].sort((a,b)=>b.score-a.score)" :key="index"><span>{{index+1}}. {{player.name}}</span><strong>{{player.score}}</strong></div></div>
        <div v-else class="teamScores"><div class="redTeam"><span>{{room.teamNames[1]}}</span><strong>{{room.teamScores[1]}}</strong><small>{{room.players.filter(player=>player.team===1).map(player=>player.name).join('、')||'暂无队员'}}</small></div><b>VS</b><div class="blueTeam"><span>{{room.teamNames[2]}}</span><strong>{{room.teamScores[2]}}</strong><small>{{room.players.filter(player=>player.team===2).map(player=>player.name).join('、')||'暂无队员'}}</small></div></div>
        <div class="roomCardFoot">创建时间 {{time(room.createdAt)}} <span v-if="room.mode==='unbalanced'">· 比分按队内平均分</span></div>
      </article></div>
    </section>
  </main>
</template>

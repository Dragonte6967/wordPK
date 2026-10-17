import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export function createAdminAuth(file) {
  let credential=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null
  const setupCode=credential?null:process.env.ADMIN_SETUP_CODE||randomBytes(9).toString('base64url')
  if(setupCode)console.log(`Word PK 管理后台初始化码：${setupCode}`)
  const sessions=new Map()
  const attempts=new Map()
  const passwordValid=value=>typeof value==='string'&&value.length>=12&&value.length<=256
  const hash=(password,salt)=>scryptSync(password,salt,64).toString('hex')
  const ipOf=req=>req.ip||req.socket.remoteAddress||'unknown'
  const blocked=req=>{const item=attempts.get(ipOf(req));return item&&item.until>Date.now()&&item.count>=5}
  const failed=req=>{const ip=ipOf(req),item=attempts.get(ip);const count=item&&item.until>Date.now()?item.count+1:1;attempts.set(ip,{count,until:Date.now()+15*60_000})}
  const cookie=req=>String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('wordpk_admin='))?.slice(13)
  const setCookie=(res,token,req,maxAge)=>res.setHeader('Set-Cookie',`wordpk_admin=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${maxAge}${req.secure?'; Secure':''}`)
  const issue=(req,res)=>{const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+12*60*60_000);setCookie(res,token,req,12*60*60);return token}
  const authorized=req=>{const token=cookie(req);if(!token)return false;const expires=sessions.get(token);if(!expires)return false;if(expires<Date.now()){sessions.delete(token);return false}return true}
  return {
    status:(req,res)=>res.json({initialized:Boolean(credential),authenticated:authorized(req)}),
    setup:(req,res)=>{
      if(credential)return res.status(409).json({error:'管理员密码已设置'})
      if(blocked(req))return res.status(429).json({error:'尝试次数过多，请 15 分钟后再试'})
      if(req.body?.setupCode!==setupCode){failed(req);return res.status(403).json({error:'初始化码错误'})}
      const password=req.body?.password
      if(!passwordValid(password))return res.status(400).json({error:'密码长度需为 12–256 个字符'})
      const salt=randomBytes(24).toString('hex'),record={salt,hash:hash(password,salt)}
      try{writeFileSync(file,JSON.stringify(record),{flag:'wx',mode:0o600})}
      catch(error){if(error.code==='EEXIST'){credential=JSON.parse(readFileSync(file,'utf8'));return res.status(409).json({error:'管理员密码已设置'})}return res.status(500).json({error:'无法保存管理员密码'})}
      credential=record;attempts.delete(ipOf(req));issue(req,res);res.json({ok:true})
    },
    login:(req,res)=>{
      if(!credential)return res.status(409).json({error:'请先设置管理员密码'})
      if(blocked(req))return res.status(429).json({error:'尝试次数过多，请 15 分钟后再试'})
      const password=req.body?.password
      if(!passwordValid(password))return res.status(401).json({error:'密码错误'})
      const actual=Buffer.from(hash(password,credential.salt),'hex'),expected=Buffer.from(credential.hash,'hex')
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){failed(req);return res.status(401).json({error:'密码错误'})}
      attempts.delete(ipOf(req));issue(req,res);res.json({ok:true})
    },
    logout:(req,res)=>{sessions.delete(cookie(req));setCookie(res,'',req,0);res.json({ok:true})},
    require:(req,res,next)=>authorized(req)?next():res.status(401).json({error:'请先登录管理员后台'})
  }
}

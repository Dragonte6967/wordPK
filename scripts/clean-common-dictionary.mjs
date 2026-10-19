import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=fileURLToPath(new URL('..',import.meta.url)),file=join(root,'com.data')
const lines=readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean)
const rows=lines.map((line,index)=>({line,entry:JSON.parse(line),index})),head=row=>row.entry.headWord.toLowerCase()
const translations=row=>row.entry.content.word.content.trans
const meaning=row=>translations(row).map(t=>t.tranCn).join('；')
const byWord=new Map(rows.map(row=>[head(row),row]))
const words=text=>new Set(text.trim().split(/\s+/))

// Inflected-looking spellings with independent everyday senses must remain.
const independent=words(`news glass glasses species series means goods arms customs clothes pants trousers shorts
  jeans tights scissors physics mathematics economics statistics ethics electronics optics politics athletics
  savings earnings securities proceedings surroundings belongings headquarters premises remains whereabouts
  being human beings found saw left rose fell wound bound bore lay born building ceiling meeting meaning
  feeling training learning teaching clothing housing nursing advertising marketing shopping shipping
  parking camping fishing hunting swimming wedding warning opening setting painting drawing recording
  bedding flooring lighting coating dressing greeting offering undertaking understanding crossing
  spring string thing king ring morning evening during interesting interested exciting excited tired
  experienced advanced united related retired outstanding promising following missing leading living
  loving charming willing fitting moving pressing lasting amazing surprising touching demanding
  promising learned aged pleased married skilled talented used better best worse worst latter latest
  most least further farther elder eldest formerly thought bit shot bent people specs dynamics
  wanting rising proceeding`) 

// Ordinary words that are also names/surnames are not removed just for that spelling.
const commonHomographs=words(`bill bob mark nick peter rob robin pat jack tom frank martin mason smith baker
  hunter fisher miller porter rose violet daisy lily heather amber ruby jade pearl hazel willow olive hope
  faith grace joy may june april august christian anonymous surname checklist capital city cities
  john charlotte henry jersey phoenix buffalo turkey china java delta alpha beta
  aurora atlas well emails puerto bush trump newton riverside cologne pacific arctic`)

const countries=new Set(),regions=new Intl.DisplayNames(['en'],{type:'region'})
for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){
  const code=String.fromCharCode(a,b),name=regions.of(code)?.toLowerCase()
  if(name&&name!==code.toLowerCase()&&/^[a-z]+$/.test(name))countries.add(name)
}
const places=words(`america usa uk britain england scotland wales europe asia africa antarctica eurasia
  texas california florida virginia carolina ohio georgia michigan colorado illinois kansas arizona
  pennsylvania oregon minnesota indiana wisconsin hawaii massachusetts iowa maryland alaska missouri
  tennessee oklahoma alabama utah kentucky maine louisiana mississippi connecticut nevada arkansas
  montana idaho vermont delaware nebraska wyoming dakota washington rhode
  london york paris chicago boston vegas zealand houston ontario seattle philadelphia miami
  sydney denver portland manchester cambridge oxford rome vancouver baltimore hollywood pittsburgh
  cleveland birmingham berlin melbourne richmond sacramento cincinnati dublin milwaukee edinburgh
  glasgow montreal tokyo beijing shanghai taipei bangkok moscow madrid barcelona brussels vienna
  lisbon prague zurich geneva florence venice naples stockholm oslo helsinki copenhagen amsterdam
  athens istanbul baghdad kabul tehran delhi dhaka karachi jakarta seoul hongkong
  luxembourg quebec hampshire sussex devon cornwall nottingham lancaster midlands midwest
  bavaria normandy burgundy catalonia brittany provence tuscany sicily sardinia corsica
  caribbean mediterranean pacific atlantic arctic antarctic tahoe niagara fuji newfoundland
  bermuda aruba maui papua tobago bali guam westminster southampton portsmouth syracuse canberra
  dubai crawford dover gibraltar andorra newark cardiff munich belfast milan bangladesh
  albuquerque greensboro tulsa bradford leeds kingston raleigh omaha rochester brunswick calgary
  riverside brisbane tucson dayton reno perth brighton sheffield anaheim fairfield lafayette
  stuttgart cologne dortmund dresden leipzig hamburg salzburg budapest warsaw krakow
  italia deutschland za yugoslavia swaziland states israel jordan`)
const names=words(`robert thomas taylor adam gary bruce antonio sarah russell thompson ross maria carey
  floyd holmes darwin joshua carroll jesse chen derek shakira singh kruger blake joyce gabriel
  meyer moses jesus allah isaac shakespeare einstein hitler napoleon lincoln claudia serge
  britney beyonce elton eltonjohn jackson madonna elvis picasso mozart beethoven socrates
  plato aristotle newton freud marx lenin stalin reagan bush clinton obama trump`)
const properMarker=/人名|姓氏(?!不详)|[男女](?:子|人)?名|[男女]性名|地名|州名|郡名|[（(][^）)]*姓[）)]|[（(][^）)]*(?:城市|港市|首都|首府|英国.*郡|美国.*州)[^）)]*[）)]/

function isProper(row){
  const word=head(row),text=meaning(row)
  if(commonHomographs.has(word))return false
  return countries.has(word)||places.has(word)||names.has(word)||properMarker.test(text)
}
// These pairs cannot be obtained reliably by stripping suffixes.
const irregular=new Map(Object.entries({am:'be',is:'be',are:'be',was:'be',were:'be',been:'be',has:'have',had:'have',does:'do',did:'do',done:'do',men:'man',women:'woman',children:'child',teeth:'tooth',feet:'foot',mice:'mouse',geese:'goose',people:'person',oxen:'ox',went:'go',gone:'go',said:'say',got:'get',gotten:'get',made:'make',took:'take',taken:'take',gave:'give',given:'give',knew:'know',known:'know',thought:'think',bought:'buy',brought:'bring',caught:'catch',taught:'teach',fought:'fight',sought:'seek',sold:'sell',told:'tell',sent:'send',spent:'spend',lent:'lend',built:'build',felt:'feel',kept:'keep',slept:'sleep',met:'meet',led:'lead',held:'hold',heard:'hear',paid:'pay',stood:'stand',understood:'understand',won:'win',lost:'lose',ate:'eat',eaten:'eat',drank:'drink',drunk:'drink',ran:'run',wrote:'write',written:'write',drove:'drive',driven:'drive',rode:'ride',ridden:'ride',flew:'fly',flown:'fly',grew:'grow',grown:'grow',threw:'throw',thrown:'throw',drew:'draw',drawn:'draw',broke:'break',broken:'break',chose:'choose',chosen:'choose',spoke:'speak',spoken:'speak',stole:'steal',stolen:'steal',froze:'freeze',frozen:'freeze',forgot:'forget',forgotten:'forget',forgave:'forgive',forgiven:'forgive',began:'begin',begun:'begin',sang:'sing',sung:'sing',rang:'ring',rung:'ring',swam:'swim',swum:'swim',shook:'shake',shaken:'shake',woke:'wake',woken:'wake',wore:'wear',worn:'wear',tore:'tear',torn:'tear',swore:'swear',sworn:'swear',arose:'arise',arisen:'arise',became:'become',lay:'lie',lain:'lie',leaves:'leaf',lives:'life',wives:'wife',knives:'knife',wolves:'wolf',shelves:'shelf',halves:'half',calves:'calf',loaves:'loaf',thieves:'thief',scarves:'scarf',selves:'self'}))
function candidates(word){
  const result=[]
  if(irregular.has(word))result.push(irregular.get(word))
  if(word.endsWith('ies'))result.push(word.slice(0,-3)+'y')
  if(word.endsWith('es'))result.push(word.slice(0,-2))
  if(word.endsWith('s')&&!word.endsWith('ss'))result.push(word.slice(0,-1))
  if(word.endsWith('ied'))result.push(word.slice(0,-3)+'y')
  if(word.endsWith('ed')){const stem=word.slice(0,-2);result.push(stem,stem+'e');if(/([b-df-hj-np-tv-z])\1$/.test(stem))result.push(stem.slice(0,-1))}
  if(word.endsWith('ing')){const stem=word.slice(0,-3);result.push(stem,stem+'e');if(/([b-df-hj-np-tv-z])\1$/.test(stem))result.push(stem.slice(0,-1));if(stem.endsWith('y'))result.push(stem.slice(0,-1)+'ie')}
  return [...new Set(result)].filter(base=>base!==word&&byWord.has(base)&&!isProper(byWord.get(base)))
}
const inflectionMarker=/(?:复数|过去式|过去分词|现在分词|第三人称(?:单数)?|比较级|最高级|动名词)/
function explicitBase(row){
  const text=meaning(row)
  if(!inflectionMarker.test(text))return undefined
  const described=[...text.matchAll(/([a-z]+)\s*(?:的|名词|动词|\s)*[^a-z；;（）()]{0,12}(?:复数|过去式|过去分词|现在分词|第三人称|比较级|最高级|动名词)/gi)].map(m=>m[1].toLowerCase())
  return (described.length?described:candidates(head(row))).find(base=>byWord.has(base)&&base!==head(row)&&!isProper(byWord.get(base)))||null
}
function senses(row){return meaning(row).replace(/[（(][^）)]*[）)]/g,'').split(/[，,；;、]/).map(s=>s.trim()).filter(s=>/^[\u4e00-\u9fff]{2,10}$/.test(s))}
function sharesMeaning(row,base){return senses(row).some(a=>senses(base).some(b=>a===b||a.length>=2&&b.length>=2&&(a.includes(b)||b.includes(a))))}
function regularBase(row){
  if(!/^[a-z]+$/.test(head(row)))return null
  // Unmarked noun gerunds often have independent senses (reading, engineering).
  if(/(?:ing|ed)$/.test(head(row))&&translations(row).some(t=>t.pos==='n'))return null
  return candidates(head(row)).find(base=>{
    const original=byWord.get(base),pos=translations(original).map(t=>t.pos||'').join(' ')
    return /(?:^|\s)(?:n|v|vt|vi)(?:\s|$)/.test(pos)&&sharesMeaning(row,original)
  })||null
}
const removed=[],kept=[],seen=new Set()
for(const row of rows){
  const word=head(row)
  if(seen.has(word)){removed.push({row,reason:'重复词头',base:word});continue}
  seen.add(word)
  if(isProper(row)){removed.push({row,reason:'专有名称',base:null});continue}
  if(!independent.has(word)){
    const explicit=explicitBase(row),base=explicit===undefined?regularBase(row):explicit
    if(base){removed.push({row,reason:explicit?'标注变形且原形存在':'规则变形且释义重合',base});continue}
  }
  kept.push(row)
}
// Never remove the only surviving representative of an inflection family.
const surviving=new Set(kept.map(head))
for(let i=removed.length-1;i>=0;i--){const item=removed[i];if(item.base&&!surviving.has(item.base)){let base=item.base;const visited=new Set();while(base&&!visited.has(base)&&!surviving.has(base)){visited.add(base);base=removed.find(x=>head(x.row)===base)?.base}if(base&&surviving.has(base))item.base=base;else{kept.push(item.row);surviving.add(head(item.row));removed.splice(i,1)}}}
kept.sort((a,b)=>a.index-b.index)
const counts=Object.fromEntries([...new Set(removed.map(x=>x.reason))].map(reason=>[reason,removed.filter(x=>x.reason===reason).length]))
console.log(JSON.stringify({before:rows.length,after:kept.length,removed:removed.length,counts},null,2))
if(process.argv.includes('--list'))console.log(removed.map(x=>`${head(x.row)}\t${x.reason}\t${x.base||''}\t${meaning(x.row)}`).join('\n'))
if(process.argv.includes('--apply')&&removed.length){
  const archive=join(root,'docs','dictionary-cleanup','com-2026-10-19')
  if(existsSync(archive+'.removed.data'))throw new Error('清理归档已存在，请先指定新的归档文件名，避免覆盖原始记录')
  mkdirSync(dirname(archive),{recursive:true})
  writeFileSync(archive+'.removed.data',removed.map(x=>x.row.line).join('\n')+'\n','utf8')
  writeFileSync(archive+'.json',JSON.stringify({before:rows.length,after:kept.length,counts,removed:removed.map(x=>({word:head(x.row),reason:x.reason,base:x.base,wordRank:x.row.entry.wordRank}))},null,2)+'\n','utf8')
  writeFileSync(file,kept.map(x=>x.line).join('\n')+'\n','utf8')
  console.log('已更新 com.data，移除的原始条目已归档：'+archive+'.removed.data')
}

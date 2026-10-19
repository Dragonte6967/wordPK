import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = file => readFileSync(new URL(file, root), 'utf8').trim().split(/\r?\n/)
const schoolWords = new Set(['cet46.data', 'ky.data', 'cz.data', 'gz.data'].flatMap(file => read(file).map(line => JSON.parse(line).headWord.toLowerCase())))
const set = text => new Set(text.trim().split(/\s+/))
// Explicit lists cover ambiguous spellings and abbreviations without labels.
const abbreviations = set(`pm am re jan feb mar apr jun jul aug sep sept oct nov dec mon tue wed thu fri sat sun
  dvd cd tv pc fax ad ads ltd inc mr mrs ms dr prof jr sr st etc eg ie vs approx dept est max min misc info
  tel phone fax email e-mail aka asap diy vip faq pdf rss html htm xhtml xml css js php asp aspx jsp cgi sql
  http https ftp www url uri ip tcp udp dns ssl tls ssh vpn lan wan wlan wifi usb cpu gpu ram rom bios
  jpeg jpg png gif tiff bmp svg mp3 mp4 mpeg mpg avi wav wma wmv mov dvd vcd cdrom vcr vhs hdmi
  api sdk gui ui ide os dos unix linux gnu gpl lgpl bsd mit msn aol icq irc aim bbs icann isbn issn doi
  ceo cfo cio cto coo hr phd md mba ba ma bsc msc llb llm llp llc plc ngo nato nasa fbi cia un unesco
  gdp gnp vat usd eur gbp aud cad nzd jpy rmb cny hkd gmt utc bst edt est cst pst pdt cdt
  lbs lb oz ft sq yrs yr hrs hr mins secs sec rpm mph kph dpi ppi ppm pct num no vol fig ref refs fwd
  sbjct trans intl inc ltd corp co com org net edu gov mil biz pro amp qty ver rev msg msgs acct aux
  abc cbs nbc cnn bbc mtv espn imdb ebay paypal amazon asus dell ibm hp intel amd ati nvidia yahoo google
  acct admin app apps config exec exe src usr var tmp temp doc docs txt csv zip rar tar gz tgz iso
  lol lmao lmfao rofl omg wtf idk imo imho btw brb afk tbh thx thanx pls plz u ur r ya yep nope wanna gonna
  gotta kinda sorta cuz coz cos dunno hehe haha hahaha yay oops wow doh duh huh meh nah yeah yup yolo
  gg ez noob newbie pwn pwned woot l33t leet hentai upskirt milfs bukkake xnxx xxx nsfw
  pics sexo adams alex ieee alice proc comp janet cons oecd usda emacs ntsc mrna cdna smtp bool gzip
  treo sync stats config micro mega nano para`)
const units = set(`kw kwh mw mwh gw gwh watt watts kilowatt kilowatts joule joules kilojoule volt volts ampere amperes
  ohm ohms hertz hz khz mhz ghz newton newtons pascal pascals kpa mpa bar bars kelvin celsius fahrenheit
  meter meters metre metres kilometer kilometers kilometre kilometres centimeter centimeters centimetre centimetres
  millimeter millimeters millimetre millimetres micrometer micrometre micron microns nanometer nanometre
  inch inches foot feet yard yards mile miles acre acres hectare hectares gram grams kilogram kilograms
  milligram milligrams ton tons tonne tonnes pound pounds ounce ounces pint pints quart quarts gallon gallons
  liter liters litre litres milliliter millilitre byte bytes kilobyte kilobytes megabyte megabytes gigabyte gigabytes
  terabyte terabytes bit bits kb mb gb tb kg mg cm mm km ml cl dl ltr cc lb lbs oz ft yd mi nm kn kt knots
  kcal cal mol mmol lux lumen lumens lm db dbm psi torr atm btu ev kev mev gev ka ma kv mv pf uf nf
  mil tex ser leu lat euro dollar yen cent cents franc francs peso pesos rupee rupees dinar ruble rouble`)
const ordinary = set(`a i o an as at be by do go he if in is it me my no of oh on or ox so to up us we am are
  why try cry dry fly sky shy sly gym rhythm hymns unit measurement pin sol
  phone email e-mail sun wed sat mar net bar bit knot amp aim pro min max
  yahoo wan cos zip tar var temp admin app apps login using linux unix info
  wow oops huh nah yeah yep nope yup yay`)
const changes = [], kept = []
for (const line of read('com.data')) {
  const entry = JSON.parse(line), word = entry.headWord.toLowerCase()
  const meaning = entry.content.word.content.trans.map(t => t.tranCn).join('；')
  let reason = null
  if (units.has(word) && !ordinary.has(word)) reason = '计量单位或货币单位'
  else if (abbreviations.has(word) && !ordinary.has(word)) reason = '缩写、简写或网络用语'
  else if (/缩写|缩略|简写|简称|网络用语|网络语言|网语|俚语/.test(meaning)) reason = '释义标注缩写或网络用语'
  else if (!ordinary.has(word) && word.length === 1) reason = '字母或符号'
  else if (!ordinary.has(word) && !schoolWords.has(word) && (
    word.length <= 3 && /^\s*\[(?:计|医|电|化|经|建|域|物)\]/.test(meaning) ||
    word.length <= 6 && /[（(][A-Za-z][A-Za-z .,&'/-]*[）)]/.test(meaning) ||
    word.length <= 4 && /^[a-z]+$/.test(word) && !/[aeiouy]/.test(word)
  )) reason = '技术缩写或字母组合'
  if (reason) changes.push({ word, reason, meaning, line })
  else kept.push(line)
}
console.log(JSON.stringify({ before: kept.length + changes.length, after: kept.length, removed: changes.length }))
if (process.argv.includes('--list')) console.log(changes.map(({ word, reason, meaning }) => `${word}\t${reason}\t${meaning}`).join('\n'))
if (process.argv.includes('--apply') && changes.length) {
  const prefix = 'docs/dictionary-cleanup/com-abbreviations-2026-10-19'
  if (existsSync(new URL(prefix + '.removed.data', root))) throw new Error('归档已存在，拒绝覆盖')
  mkdirSync(new URL('docs/dictionary-cleanup/', root), { recursive: true })
  writeFileSync(new URL(prefix + '.removed.data', root), changes.map(x => x.line).join('\n') + '\n')
  writeFileSync(new URL(prefix + '.json', root), JSON.stringify(changes.map(({ line, ...entry }) => entry), null, 2) + '\n')
  writeFileSync(new URL('com.data', root), kept.join('\n') + '\n')
}

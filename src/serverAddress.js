export function serverHost(value, fallback='') {
  const raw=String(value||'').trim()
  if(!raw)return fallback
  try { return new URL(raw.includes('://')?raw:`http://${raw}`).hostname || fallback }
  catch { return fallback }
}

export function serverCandidates(value, pageProtocol='http:') {
  const raw=String(value||'').trim()
  if(!raw)return []
  let parsed
  try { parsed=new URL(raw.includes('://')?raw:`${pageProtocol}//${raw}`) }
  catch { return [] }
  const host=parsed.hostname
  if(!host)return []
  return pageProtocol==='https:'
    ? [`https://${host}:443`,`http://${host}:3001`]
    : [`http://${host}:3001`,`https://${host}:443`]
}

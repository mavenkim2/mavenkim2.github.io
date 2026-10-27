// Curated, static snapshot list. Paths resolve beside snapshots.json, including
// when the viewer is served from a GitHub Pages project/site subdirectory.
export function parseCatalog(data,manifestURL) {
  if(data?.version!==1||!Array.isArray(data.snapshots)) throw Error('Expected version 1 snapshots.json with a snapshots array.');
  const ids=new Set(),base=new URL(manifestURL);
  const snapshots=data.snapshots.map(entry=>{
    if(!entry||typeof entry.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id)||ids.has(entry.id)||
      typeof entry.name!=='string'||!entry.name.trim()||typeof entry.url!=='string'||!entry.url.trim()||
      (entry.description!==undefined&&typeof entry.description!=='string')) throw Error('Each snapshot needs a unique ID, name, and URL.');
    const url=new URL(entry.url,base);
    if(!['https:','http:'].includes(url.protocol)||url.origin!==base.origin) throw Error('Catalog snapshots must be hosted on the same origin as the viewer.');
    ids.add(entry.id);
    return {id:entry.id,name:entry.name,url:url.href,description:entry.description||''};
  });
  if(data.default!=null&&!ids.has(data.default)) throw Error('Catalog default must match a snapshot ID.');
  return {snapshots,default:data.default??null};
}

export async function decodeSnapshot(bytes) {
  const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  const compressed=data[0]===0x1f&&data[1]===0x8b;
  if(compressed&&typeof DecompressionStream==='undefined') throw Error('This browser cannot decompress snapshots. Use a browser with gzip DecompressionStream support or upload plain JSON.');
  const text=compressed?await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text():new TextDecoder().decode(data);
  return JSON.parse(text);
}

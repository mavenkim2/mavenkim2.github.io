// Snapshot parsing and visualization math.
export const add = (a,b) => a.map((x,i)=>x+b[i]);
export const sub = (a,b) => a.map((x,i)=>x-b[i]);
export const mul = (a,s) => a.map(x=>x*s);
export const dot = (a,b) => a.reduce((s,x,i)=>s+x*b[i],0);
export const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const normalize = a => mul(a,1/(Math.hypot(...a)||1));
export const finiteVector = a => Array.isArray(a)&&a.length===3&&a.every(Number.isFinite);
const vector = a => Array.isArray(a)&&a.length===3&&a.every(x=>x===null||Number.isFinite(x));
const bounds = b => b&&vector(b.min)&&vector(b.max)&&b.min.every((x,i)=>x===null||b.max[i]===null||x<=b.max[i]);

export function parseSnapshot(data) {
  if(data?.schema!=='yeoubi.guiding-cells'||data.version!==1||!Array.isArray(data.cells))
    throw Error('Expected a version 1 yeoubi.guiding-cells snapshot.');
  const ids=new Set();
  for(const cell of data.cells) {
    if(cell.meanRadianceRGB!=null&&(!finiteVector(cell.meanRadianceRGB)||cell.meanRadianceRGB.some(x=>x<0)))
      throw Error(`Invalid RGB mean in cell ${cell.id}.`);
    if(!Number.isSafeInteger(cell.id)||cell.id<0||ids.has(cell.id)||!bounds(cell.bounds)||!bounds(cell.observedBounds)||!finiteVector(cell.position)||
      !(cell.meanRadiance===null||(Number.isFinite(cell.meanRadiance)&&cell.meanRadiance>=0))||!Number.isSafeInteger(cell.depth)||cell.depth<0||
      !cell.vmm||!Array.isArray(cell.vmm.components)||cell.vmm.components.length>16||!Number.isFinite(cell.vmm.sampleCount)||cell.vmm.sampleCount<0)
      throw Error('Invalid or duplicate cell ID, bounds, position, radiance, depth, or VMM statistics.');
    for(const c of cell.vmm.components)
      if(!finiteVector(c.direction)||!Number.isFinite(c.weight)||c.weight<0||!Number.isFinite(c.kappa)||c.kappa<0||!(c.distance===null||Number.isFinite(c.distance)))
        throw Error(`Invalid VMM component in cell ${cell.id}.`);
    ids.add(cell.id);
  }
  let lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  const include=p=>{if(finiteVector(p)) p.forEach((x,i)=>{lo[i]=Math.min(lo[i],x);hi[i]=Math.max(hi[i],x);});};
  if(bounds(data.sceneBounds)) { include(data.sceneBounds.min); include(data.sceneBounds.max); }
  for(const cell of data.cells) {
    include(cell.position); include(cell.observedBounds.min); include(cell.observedBounds.max);
    // Finite split faces can lie beyond frozen observed position bounds.
    for(let a=0;a<3;a++) for(const value of [cell.bounds.min[a],cell.bounds.max[a]])
      if(Number.isFinite(value)) {lo[a]=Math.min(lo[a],value);hi[a]=Math.max(hi[a],value);}
  }
  if(!lo.every(Number.isFinite)||!hi.every(Number.isFinite)) {lo=[-1,-1,-1];hi=[1,1,1];}
  const span=Math.max(...sub(hi,lo),1e-3);
  const center=mul(add(lo,hi),0.5);
  // Include some margin around sampled positions, including flat/empty axes.
  const clipMin=lo.map(x=>x-span*.06),clipMax=hi.map(x=>x+span*.06);
  return {...data,center,span,clipMin,clipMax};
}

export function displayBounds(cell) {
  const b=cell.observedBounds;
  if(!b||!finiteVector(b.min)||!finiteVector(b.max)||b.min.some((x,i)=>x>b.max[i])) return null;
  return {min:[...b.min],max:[...b.max]};
}

// Positive distance to the near face; inside a box, use its exit face.
export function rayBox(origin,direction,b) {
  let near=-Infinity,far=Infinity;
  for(let i=0;i<3;i++) {
    if(Math.abs(direction[i])<1e-12) {if(origin[i]<b.min[i]||origin[i]>b.max[i]) return Infinity;}
    else {
      const a=(b.min[i]-origin[i])/direction[i],c=(b.max[i]-origin[i])/direction[i];
      near=Math.max(near,Math.min(a,c)); far=Math.min(far,Math.max(a,c));
      if(near>far) return Infinity;
    }
  }
  return far<0?Infinity:Math.max(0,near<0?far:near);
}

export function heatColor(t) {
  const colors=[[.14,.24,.60],[.07,.62,.73],[.50,.80,.58],[.96,.79,.33],[.98,.47,.27]];
  const u=Math.max(0,Math.min(1,t))*4,i=Math.min(3,Math.floor(u)),f=u-i;
  return colors[i].map((v,j)=>v*(1-f)+colors[i+1][j]*f);
}

// Directional density palette: blue -> cyan -> green -> yellow -> red.
export function densityColor(t) {
  const colors=[[0,0,1],[0,1,1],[0,1,0],[1,1,0],[1,0,0]];
  const u=Math.max(0,Math.min(1,t))*4,i=Math.min(3,Math.floor(u)),f=u-i;
  return colors[i].map((v,j)=>v*(1-f)+colors[i+1][j]*f);
}

// Reinhard on linear Rec.709 luminance, preserving RGB ratios. Uniformly fit
// out-of-gamut colors before sRGB encoding rather than clipping each channel.
export function radianceColor(rgb,exposureEV=0) {
  const linear=rgb.map(component=>Math.max(0,component)*2**exposureEV);
  const luminance=dot(linear,[.2126,.7152,.0722]);
  const denominator=Math.max(1+luminance,...linear);
  return linear.map(value=>{
    const mapped=value/denominator;
    return mapped<=.0031308?12.92*mapped:1.055*mapped**(1/2.4)-.055;
  });
}

export function mixtureDensity(components,direction) {
  return components.reduce((sum,c)=>{
    const k=c.kappa,cosine=Math.max(-1,Math.min(1,dot(c.direction,direction)));
    // exp(k*(cos-1)) avoids overflow for narrow lobes.
    return sum+c.weight*(k<1e-5?1/(4*Math.PI):k/(2*Math.PI*(-Math.expm1(-2*k)))*Math.exp(k*(cosine-1)));
  },0);
}

export function demoSnapshot() {
  const cells=[];
  for(let x=0;x<4;x++) for(let y=0;y<3;y++) for(let z=0;z<4;z++) {
    const id=cells.length,min=[x-2,y-1.5,z-2],max=add(min,[1,1,1]),position=mul(add(min,max),.5);
    const meanRadiance=.05+24*Math.exp(-((x-2.5)**2+(y-2)**2+(z-1)**2)*.7);
    cells.push({id,nodeIndex:id,depth:5,parentIndex:-1,bounds:{min,max},observedBounds:{min:add(min,[.05,.05,.05]),max:sub(max,[.05,.05,.05])},position,positionMean:position,positionVariance:[.08,.08,.08],positionSampleCount:1200,meanRadiance,meanRadianceSource:'lookahead',radianceVariance:meanRadiance*.4,lookahead:{sampleCount:1200},vmm:{initialized:true,sampleCount:1100,overallSampleCount:1100,sumWeights:meanRadiance*1100,components:[{direction:normalize(sub([1,2,-1],position)),weight:.8,kappa:12,distance:3},{direction:[0,1,0],weight:.2,kappa:.5,distance:null}]}});
  }
  return {schema:'yeoubi.guiding-cells',version:1,splitDecision:'lookahead',iteration:4,renderedSamples:16,nodeCount:95,distributionCount:48,sceneBounds:{min:[-2,-1.5,-2],max:[2,1.5,2]},cells};
}

import {add,sub,mul,dot,cross,normalize,parseSnapshot,displayBounds,rayBox,heatColor,radianceColor,demoSnapshot} from './data.js';
import {parseCatalog,decodeSnapshot} from './catalog.js';

const $=id=>document.getElementById(id);
const canvas=$('scene'),notice=$('notice');
let scene=null,visible=[],selected=null,gpu=null,cellBuffer=null,cellGroup=null,lineBuffer=null,lineCount=0,depthTexture=null;
let colorMin=0,colorMax=1,lastTime=0,looking=false,lastMouse=null;
const densityWidth=2048,densityHeight=1024;
let densityDirty=true,densityReady=false;
let snapshotLoadVersion=0,snapshotRequest=null,hostedSnapshots=[],activeHostedId='';
const keys=new Set(),camera={position:[0,0,2],yaw:0,pitch:0,up:[0,1,0],base:[0,0,-1],speed:5};
const fmt=x=>x===null||x===undefined?'—':Number(x).toLocaleString(undefined,Number.isSafeInteger(Number(x))?{maximumFractionDigits:0}:{maximumSignificantDigits:5});
const vec=v=>v?v.map(fmt).join(', '):'—';
function message(text,error=false) {notice.textContent=text;notice.classList.toggle('error',error);}
function basis() {
  const zeroRight=normalize(cross(camera.base,camera.up));
  const horizontal=add(mul(camera.base,Math.cos(camera.yaw)),mul(zeroRight,Math.sin(camera.yaw)));
  const forward=normalize(add(mul(horizontal,Math.cos(camera.pitch)),mul(camera.up,Math.sin(camera.pitch))));
  const right=normalize(cross(forward,camera.up));
  return {forward,right,up:normalize(cross(right,forward))};
}
const world=p=>add(mul(p,scene.span),scene.center);
const local=p=>mul(sub(p,scene.center),1/scene.span);

const shader=`
struct Camera { eye:vec4f, right:vec4f, up:vec4f, forward:vec4f, projection:vec4f, options:vec4f }
struct Cell { lo:vec4f, hi:vec4f, pivot:vec4f, color:vec4f }
@group(0) @binding(0) var<uniform> camera:Camera;
@group(1) @binding(0) var<storage,read> cells:array<Cell>;
struct Output { @builtin(position) position:vec4f, @location(0) color:vec4f }
fn project(p:vec3f)->vec4f {
  let v=p-camera.eye.xyz;
  let z=dot(v,camera.forward.xyz);
  let aspect=camera.projection.x; let t=camera.projection.y;
  let n=camera.projection.z; let f=camera.projection.w;
  return vec4f(dot(v,camera.right.xyz)/(aspect*t),dot(v,camera.up.xyz)/t,f/(f-n)*z-f*n/(f-n),z);
}
@vertex fn cellVertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Output {
  let edges=array<u32,24>(0,1,1,3,3,2,2,0,4,5,5,7,7,6,6,4,0,4,1,5,2,6,3,7);
  let cell=cells[instance]; var p:vec3f;
  if(vertex<24u) {
    let c=edges[vertex];
    p=mix(cell.lo.xyz,cell.hi.xyz,vec3f(f32(c&1u),f32((c>>1u)&1u),f32((c>>2u)&1u)));
  } else {
    let v=vertex-24u; let axis=v/2u; var offset=vec3f(0);
    offset[axis]=select(-camera.options.x,camera.options.x,v%2u==1u);
    p=cell.pivot.xyz+offset;
  }
  var out:Output; out.position=project(p);
  out.color=select(cell.color,vec4f(1,1,0.85,1),f32(instance)==camera.options.y);
  return out;
}
@vertex fn lineVertex(@location(0) position:vec3f,@location(1) color:vec4f)->Output {
  var out:Output; out.position=project(position); out.color=color; return out;
}
@vertex fn solidVertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Output {
  let triangles=array<u32,36>(
    0,2,3, 0,3,1, 4,5,7, 4,7,6,
    0,4,6, 0,6,2, 1,3,7, 1,7,5,
    0,1,5, 0,5,4, 2,6,7, 2,7,3);
  let cell=cells[instance]; let c=triangles[vertex];
  let p=mix(cell.lo.xyz,cell.hi.xyz,vec3f(f32(c&1u),f32((c>>1u)&1u),f32((c>>2u)&1u)));
  var out:Output; out.position=project(p); out.color=cell.color; return out;
}
@fragment fn fragment(in:Output)->@location(0) vec4f {return in.color;}
`;

const sphereShader=`
struct Camera { eye:vec4f, right:vec4f, up:vec4f, forward:vec4f, projection:vec4f, options:vec4f }
struct Component { directionKappa:vec4f, weightNormalization:vec4f }
struct Sphere { centerRadius:vec4f, density:vec4f, components:array<Component,16> }
@group(0) @binding(0) var<uniform> camera:Camera;
@group(1) @binding(0) var<uniform> sphere:Sphere;
@group(1) @binding(1) var densityMap:texture_2d<f32>;
@group(1) @binding(2) var densitySampler:sampler;
struct Screen { @builtin(position) position:vec4f, @location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Screen {
  let positions=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var out:Screen; out.uv=positions[index];out.position=vec4f(out.uv,0,1);return out;
}
@fragment fn fragment(in:Screen)->@location(0) vec4f {
  let ray=normalize(camera.forward.xyz+camera.right.xyz*in.uv.x*camera.projection.x*camera.projection.y+camera.up.xyz*in.uv.y*camera.projection.y);
  let offset=camera.eye.xyz-sphere.centerRadius.xyz;
  let b=dot(offset,ray);let c=dot(offset,offset)-sphere.centerRadius.w*sphere.centerRadius.w;
  let discriminant=b*b-c;
  if(discriminant<0) {discard;}
  let root=sqrt(discriminant);var distance=-b-root;
  if(distance<=0) {distance=-b+root;}
  if(distance<=0) {discard;}
  let direction=normalize(offset+distance*ray);
  // World-space direction selects a precomputed texel; no VMM evaluation or
  // normalization depends on the camera or on which hemisphere is visible.
  let uv=vec2f(atan2(direction.x,-direction.z)/(2*3.141592653589793)+0.5,
               acos(clamp(direction.y,-1,1))/3.141592653589793);
  return textureSampleLevel(densityMap,densitySampler,uv,0);
}
`;

const densityComputeShader=`
struct Component { directionKappa:vec4f, weightNormalization:vec4f }
struct Sphere { centerRadius:vec4f, density:vec4f, components:array<Component,16> }
@group(0) @binding(0) var<uniform> mixture:Sphere;
@group(0) @binding(1) var field:texture_storage_2d<r32float,write>;
@group(0) @binding(2) var<storage,read_write> maximum:atomic<u32>;
var<workgroup> blockMaximum:array<f32,256>;
fn evaluate(direction:vec3f)->f32 {
  var value=0.0;
  for(var i=0u;i<u32(mixture.density.y);i++) {
    let c=mixture.components[i];let k=c.directionKappa.w;
    let cosine=clamp(dot(c.directionKappa.xyz,direction),-1,1);
    value+=c.weightNormalization.x*c.weightNormalization.y*exp(k*(cosine-1));
  }
  return value;
}
@compute @workgroup_size(16,16) fn evaluateSphere(
    @builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) index:u32) {
  let size=textureDimensions(field);var value=0.0;
  if(id.x<size.x&&id.y<size.y) {
    let uv=(vec2f(id.xy)+0.5)/vec2f(size);
    let phi=(uv.x-0.5)*2*3.141592653589793;let theta=uv.y*3.141592653589793;
    let direction=vec3f(sin(theta)*sin(phi),cos(theta),-sin(theta)*cos(phi));
    value=evaluate(direction);
    textureStore(field,vec2i(id.xy),vec4f(value,0,0,0));
  }
  blockMaximum[index]=value;workgroupBarrier();
  for(var stride=128u;stride>0u;stride/=2u) {
    if(index<stride) {blockMaximum[index]=max(blockMaximum[index],blockMaximum[index+stride]);}
    workgroupBarrier();
  }
  // Densities are nonnegative; positive float bit order matches integer order.
  if(index==0u) {atomicMax(&maximum,bitcast<u32>(blockMaximum[0]));}
}
`;

const densityColorShader=`
@group(0) @binding(0) var field:texture_2d<f32>;
@group(0) @binding(1) var<storage,read> maximum:u32;
@group(0) @binding(2) var colors:texture_storage_2d<rgba8unorm,write>;
fn palette(t:f32)->vec3f {
  let stops=array<vec3f,5>(vec3f(0,0,1),vec3f(0,1,1),vec3f(0,1,0),vec3f(1,1,0),vec3f(1,0,0));
  let u=clamp(t,0,1)*4;let i=min(3u,u32(floor(u)));
  return mix(stops[i],stops[i+1u],u-f32(i));
}
@compute @workgroup_size(16,16) fn colorSphere(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(colors);if(id.x>=size.x||id.y>=size.y) {return;}
  let value=textureLoad(field,vec2i(id.xy),0).x;
  let peak=max(bitcast<f32>(maximum),1e-20);
  let t=log(1+100*value/peak)/log(101.0);
  textureStore(colors,vec2i(id.xy),vec4f(palette(t),1));
}
`;

const flatDensityShader=`
@group(0) @binding(1) var densityMap:texture_2d<f32>;
@group(0) @binding(2) var densitySampler:sampler;
struct Screen { @builtin(position) position:vec4f, @location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Screen {
  let positions=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  var out:Screen;out.position=vec4f(positions[index],0,1);
  out.uv=vec2f(positions[index].x*0.5+0.5,0.5-positions[index].y*0.5);return out;
}
@fragment fn fragment(in:Screen)->@location(0) vec4f {
  return textureSampleLevel(densityMap,densitySampler,in.uv,0);
}
`;

async function initializeGPU() {
  if(!navigator.gpu) throw Error('WebGPU is unavailable. Serve on localhost and use a WebGPU-enabled browser.');
  const adapter=await navigator.gpu.requestAdapter();
  if(!adapter) throw Error('No WebGPU adapter was found. Check browser hardware acceleration.');
  const device=await adapter.requestDevice();
  device.addEventListener('uncapturederror',event=>message(`WebGPU: ${event.error.message}`,true));
  device.lost.then(info=>{gpu=null;message(`GPU device lost: ${info.message}. Reload this page.`,true);});
  const context=canvas.getContext('webgpu');
  if(!context) throw Error('Could not create the WebGPU canvas context.');
  const format=navigator.gpu.getPreferredCanvasFormat();
  context.configure({device,format,alphaMode:'opaque'});
  const module=device.createShaderModule({label:'guiding viewer',code:shader});
  const compilation=await module.getCompilationInfo();
  const errors=compilation.messages.filter(m=>m.type==='error');
  if(errors.length) throw Error(errors.map(m=>`${m.lineNum}: ${m.message}`).join('\n'));
  const cameraLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}}]});
  const cellsLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}}]});
  const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[cameraLayout,cellsLayout]});
  const common={layout:pipelineLayout,fragment:{module,entryPoint:'fragment',targets:[{format}]},primitive:{topology:'line-list'},depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less-equal'}};
  const pipeline=await device.createRenderPipelineAsync({...common,vertex:{module,entryPoint:'cellVertex'}});
  // Two-sided faces allow free camera movement inside a cell. Constant color
  // preserves the exported statistic; no surface lighting changes its value.
  const solidPipeline=await device.createRenderPipelineAsync({...common,
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{...common.depthStencil,depthBias:1,depthBiasSlopeScale:1},
    vertex:{module,entryPoint:'solidVertex'}});
  const linePipeline=await device.createRenderPipelineAsync({...common,vertex:{module,entryPoint:'lineVertex',buffers:[{arrayStride:28,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x4'}]}]}});
  const uniform=device.createBuffer({size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const cameraGroup=device.createBindGroup({layout:cameraLayout,entries:[{binding:0,resource:{buffer:uniform}}]});
  const sphereModule=device.createShaderModule({label:'selected spherical density',code:sphereShader});
  const sphereCompilation=await sphereModule.getCompilationInfo();
  const sphereErrors=sphereCompilation.messages.filter(m=>m.type==='error');
  if(sphereErrors.length) throw Error(sphereErrors.map(m=>`${m.lineNum}: ${m.message}`).join('\n'));
  const sphereLayout=device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
    {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
    {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}]});
  const spherePipeline=await device.createRenderPipelineAsync({
    layout:device.createPipelineLayout({bindGroupLayouts:[cameraLayout,sphereLayout]}),
    vertex:{module:sphereModule,entryPoint:'vertex'},fragment:{module:sphereModule,entryPoint:'fragment',targets:[{format}]},
    primitive:{topology:'triangle-list'}});
  const sphereUniform=device.createBuffer({size:544,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const densityField=device.createTexture({size:[densityWidth,densityHeight],format:'r32float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
  const densityColors=device.createTexture({size:[densityWidth,densityHeight],format:'rgba8unorm',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
  const densityMaximum=device.createBuffer({size:4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  const densitySampler=device.createSampler({addressModeU:'repeat',addressModeV:'clamp-to-edge',magFilter:'linear',minFilter:'linear'});
  const sphereGroup=device.createBindGroup({layout:sphereLayout,entries:[
    {binding:0,resource:{buffer:sphereUniform}},{binding:1,resource:densityColors.createView()},{binding:2,resource:densitySampler}]});
  const evaluateLayout=device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
    {binding:1,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:'write-only',format:'r32float'}},
    {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}}]});
  const colorLayout=device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}},
    {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
    {binding:2,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:'write-only',format:'rgba8unorm'}}]});
  const evaluateModule=device.createShaderModule({label:'full sphere VMM compute',code:densityComputeShader});
  const colorModule=device.createShaderModule({label:'density heatmap compute',code:densityColorShader});
  const flatModule=device.createShaderModule({label:'flat spherical heatmap',code:flatDensityShader});
  for(const compiled of [evaluateModule,colorModule,flatModule]) {
    const info=await compiled.getCompilationInfo(),errors=info.messages.filter(m=>m.type==='error');
    if(errors.length) throw Error(errors.map(m=>`${m.lineNum}: ${m.message}`).join('\n'));
  }
  const evaluatePipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[evaluateLayout]}),compute:{module:evaluateModule,entryPoint:'evaluateSphere'}});
  const colorPipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[colorLayout]}),compute:{module:colorModule,entryPoint:'colorSphere'}});
  const evaluateGroup=device.createBindGroup({layout:evaluateLayout,entries:[
    {binding:0,resource:{buffer:sphereUniform}},{binding:1,resource:densityField.createView()},{binding:2,resource:{buffer:densityMaximum}}]});
  const colorGroup=device.createBindGroup({layout:colorLayout,entries:[
    {binding:0,resource:densityField.createView()},{binding:1,resource:{buffer:densityMaximum}},{binding:2,resource:densityColors.createView()}]});
  const flatPipeline=await device.createRenderPipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[sphereLayout]}),
    vertex:{module:flatModule,entryPoint:'vertex'},fragment:{module:flatModule,entryPoint:'fragment',targets:[{format}]},primitive:{topology:'triangle-list'}});
  const densityContext=$('density').getContext('webgpu');
  if(!densityContext) throw Error('Could not create the density map WebGPU context.');
  densityContext.configure({device,format,alphaMode:'opaque'});
  gpu={device,context,pipeline,solidPipeline,linePipeline,uniform,cameraGroup,cellsLayout,spherePipeline,sphereUniform,sphereGroup,
    evaluatePipeline,colorPipeline,evaluateGroup,colorGroup,densityMaximum,densityContext,flatPipeline};
  if(scene) rebuild();
}

function computeDensityField() {
  densityDirty=false;densityReady=false;
  if(!selected?.vmm.initialized||!selected.vmm.components.length) return;
  const data=new Float32Array(136);data[5]=selected.vmm.components.length;
  selected.vmm.components.forEach((component,i)=>{
    const k=component.kappa,normalization=k===0?1/(4*Math.PI):k/(2*Math.PI*(-Math.expm1(-2*k)));
    data.set([...component.direction,k,component.weight,normalization,0,0],8+i*8);
  });
  gpu.device.queue.writeBuffer(gpu.sphereUniform,0,data);
  gpu.device.queue.writeBuffer(gpu.densityMaximum,0,new Uint32Array([0]));
  const encoder=gpu.device.createCommandEncoder({label:'compute complete directional field'});
  const evaluate=encoder.beginComputePass();evaluate.setPipeline(gpu.evaluatePipeline);evaluate.setBindGroup(0,gpu.evaluateGroup);
  evaluate.dispatchWorkgroups(densityWidth/16,densityHeight/16);evaluate.end();
  const color=encoder.beginComputePass();color.setPipeline(gpu.colorPipeline);color.setBindGroup(0,gpu.colorGroup);
  color.dispatchWorkgroups(densityWidth/16,densityHeight/16);color.end();
  gpu.device.queue.submit([encoder.finish()]);densityReady=true;
}

function metric(cell) {
  switch($('metric').value) {
    case 'samples':return cell.lookahead?.sampleCount||cell.vmm.sampleCount;
    case 'depth':return cell.depth;
    case 'components':return cell.vmm.components.length;
    default:return cell.meanRadiance;
  }
}
function rebuild() {
  if(!scene) return;
  const threshold=Math.max(0,Number($('threshold').value)||0);
  visible=scene.cells.filter(c=>(c.meanRadiance===null?threshold===0:c.meanRadiance>=threshold))
    .map(cell=>({cell,bounds:displayBounds(cell)})).filter(c=>c.bounds);
  colorMin=Infinity;colorMax=-Infinity;
  for(const {cell} of visible) {const v=metric(cell);if(Number.isFinite(v)) {colorMin=Math.min(colorMin,v);colorMax=Math.max(colorMax,v);}}
  if(!Number.isFinite(colorMin)) {colorMin=0;colorMax=1;}
  $('low').textContent=fmt(colorMin);$('high').textContent=fmt(colorMax);
  const label=$('metric').selectedOptions[0].textContent,log=$('metric').value==='meanRadiance'||$('metric').value==='samples';
  const useRGB=$('metric').value==='rgb',exposure=Math.max(-16,Math.min(16,Number($('exposure').value)||0));
  $('exposureControl').hidden=!useRGB;
  $('low').hidden=$('high').hidden=document.querySelector('.ramp').hidden=useRGB;
  $('legendLabel').textContent=useRGB?`Mean RGB radiance · ${exposure} EV · luminance Reinhard / sRGB`:`${label} · ${log?'log':'linear'} scale`;
  $('visible').textContent=`${visible.length.toLocaleString()} / ${scene.cells.length.toLocaleString()} cells`;
  if(!gpu) return;
  const {device}=gpu;
  const byteSize=Math.max(64,visible.length*64);
  if(byteSize>device.limits.maxStorageBufferBindingSize||byteSize>device.limits.maxBufferSize)
    throw Error('Too many visible cells for this GPU. Increase the radiance filter.');
  const data=new Float32Array(byteSize/4);
  visible.forEach(({cell,bounds},i)=>{
    const base=i*16,v=metric(cell);
    const t=log?(Math.log1p(v)-Math.log1p(colorMin))/(Math.log1p(colorMax)-Math.log1p(colorMin)||1):(v-colorMin)/(colorMax-colorMin||1);
    const color=useRGB?(cell.meanRadianceRGB?radianceColor(cell.meanRadianceRGB,exposure):[.35,.39,.45]):(Number.isFinite(v)?heatColor(t):[.35,.39,.45]);
    data.set([...local(bounds.min),0,...local(bounds.max),0,...local(cell.position),0,...color,1],base);
  });
  const replacement=device.createBuffer({size:byteSize,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(replacement,0,data);
  cellBuffer?.destroy();cellBuffer=replacement;
  cellGroup=device.createBindGroup({layout:gpu.cellsLayout,entries:[{binding:0,resource:{buffer:cellBuffer}}]});
  rebuildLines();
}
function rebuildLines() {
  if(!gpu||!scene) return;
  const lines=[];
  const line=(a,b,c)=>lines.push(...a,...c,1,...b,...c,1);
  const c=local(scene.clipMin),axisLength=.12;
  [[1,.3,.3],[.3,1,.5],[.3,.6,1]].forEach((color,i)=>{const end=[...c];end[i]+=axisLength;line(c,end,color);});
  lineBuffer?.destroy();lineCount=lines.length/7;
  lineBuffer=gpu.device.createBuffer({size:Math.max(4,lines.length*4),usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
  if(lines.length) gpu.device.queue.writeBuffer(lineBuffer,0,new Float32Array(lines));
}

function load(data,name) {
  const parsed=parseSnapshot(data); // Failed loads preserve the current snapshot.
  scene=parsed;selected=null;densityDirty=true;densityReady=false;
  $('sphereMinRadius').value=Number((scene.span*.01).toPrecision(5));
  $('sphereMaxRadius').value=Number((scene.span*.02).toPrecision(5));
  const hasRGB=scene.cells.some(cell=>cell.meanRadianceRGB!=null);
  $('rgbOption').disabled=!hasRGB;
  $('metric').value=hasRGB?'rgb':'meanRadiance';
  $('filename').textContent=name;$('cellId').value='';$('threshold').value='0';
  $('details').textContent='Select a cell to inspect its bounds and statistics.';$('distribution').hidden=true;
  $('summary').replaceChildren();
  const dl=document.createElement('dl');
  for(const [key,value] of [['Guiding cells',scene.cells.length],['Tree nodes',scene.nodeCount],['Training mode',scene.splitDecision],['Iteration',scene.iteration],['Rendered samples',scene.renderedSamples],['Trained through',scene.trainedSamples??'—']]) {
    const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=typeof value==='number'?fmt(value):value;dl.append(dt,dd);
  }
  $('summary').append(dl);rebuild();frameAll();
  if(gpu) message(scene.cells.length?'':'This snapshot has no active guiding cells.');
}
function setView(target,distance) {
  camera.yaw=0;camera.pitch=-.24;
  const direction=normalize(camera.up[2]?[1,-1,0]:[1,0,-1]);camera.base=direction;
  camera.position=sub(target,mul(basis().forward,distance));
}
function frameAll() {
  if(!scene) return;
  const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
  const radius=Math.hypot(...sub(scene.clipMax,scene.clipMin))/scene.span*.5;
  const halfAngle=Math.atan(Math.tan(Math.PI/6)*Math.min(1,aspect));
  setView([0,0,0],radius/Math.sin(halfAngle)*1.1);
  camera.speed=Math.max(.01,Math.min(1000,scene.span*.25));$('speed').value=Number(camera.speed.toPrecision(4));
}
function heatmapWorldRadius(cell) {
  const b=displayBounds(cell);
  const scale=Math.max(.25,Math.min(4,Number($('sphereSize').value)||1));
  const minimum=Number($('sphereMinRadius').value);
  const maximum=Number($('sphereMaxRadius').value);
  const upper=Number.isFinite(maximum)?Math.max(1e-6,maximum):scene.span*.02;
  const lower=Math.min(upper,Number.isFinite(minimum)?Math.max(1e-6,minimum):1e-6);
  return Math.min(upper,Math.max(lower,b?Math.hypot(...sub(b.max,b.min))*.55*scale:0));
}
function frameSelected() {
  if(!selected||!scene) return;
  const b=displayBounds(selected);
  if(!b) return;
  const center=local(selected.position);
  const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);
  const halfAngle=Math.atan(Math.tan(Math.PI/6)*Math.min(1,aspect));
  const radius=heatmapWorldRadius(selected)/scene.span;
  setView(center,Math.max(.04,radius*1.1/Math.sin(halfAngle)));
}
function selectCell(cell) {
  selected=cell;$('cellId').value=cell?.id??'';
  densityDirty=true;densityReady=false;
  if(!cell) {$('details').textContent='No cell at that point.';$('distribution').hidden=true;rebuildLines();return;}
  const dl=document.createElement('dl');
  for(const [key,value] of [['Node',cell.nodeIndex],['Depth',cell.depth],['Mean radiance',fmt(cell.meanRadiance)],['Mean RGB',vec(cell.meanRadianceRGB)],['Variance',fmt(cell.radianceVariance)],['Lookahead samples',fmt(cell.lookahead?.sampleCount)],['VMM samples',fmt(cell.vmm.sampleCount)],['VMM initialized',cell.vmm.initialized?'Yes':'No']]) {
    const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value;dl.append(dt,dd);
  }
  const description=document.createElement('p');description.className='small muted';
  description.textContent=cell.meanRadianceSource==='lookahead'?'Mean of Li / pdf, including zero samples.':'VMM mean of Li / pdf over nonzero samples; training statistics may be decayed.';
  const pre=document.createElement('pre');
  pre.textContent=`Pivot       [${vec(cell.position)}]\nMean pos.   [${vec(cell.positionMean)}]\nPos. var.   [${vec(cell.positionVariance)}]\n\nBounds min  [${vec(cell.observedBounds.min)}]\nBounds max  [${vec(cell.observedBounds.max)}]`;
  $('details').replaceChildren(dl,description,pre);
  $('distribution').hidden=!cell.vmm.initialized||!cell.vmm.components.length;
  if(!$('distribution').hidden) drawDensity(cell.vmm.components);
  rebuildLines();
}
function drawDensity(components) {
  const table=document.createElement('table'),head=document.createElement('tr');
  for(const title of ['Lobe','Weight','κ','Distance']) {const th=document.createElement('th');th.textContent=title;head.append(th);}table.append(head);
  components.forEach((component,i)=>{const row=document.createElement('tr');for(const value of [i,fmt(component.weight),fmt(component.kappa),component.distance===null?'∞':fmt(component.distance)]) {const td=document.createElement('td');td.textContent=value;row.append(td);}table.append(row);});
  $('components').replaceChildren(table);
}

function pick(event) {
  if(!scene||event.button!==0) return;
  const rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width*2-1,y=1-(event.clientY-rect.top)/rect.height*2;
  const {forward,right,up}=basis(),tan=Math.tan(Math.PI/6);
  const ray=normalize(add(forward,add(mul(right,x*rect.width/rect.height*tan),mul(up,y*tan))));
  let distance=Infinity,hit=null;
  for(const {cell,bounds} of visible) {
    const t=rayBox(camera.position,ray,{min:local(bounds.min),max:local(bounds.max)});
    if(t<distance) {distance=t;hit=cell;}
  }
  selectCell(hit);
}
function stopInput() {keys.clear();looking=false;lastMouse=null;canvas.style.cursor='';}
function safe(action) {try{action();}catch(error){message(error.message,true);}}
function beginSnapshotLoad() {
  snapshotRequest?.abort();snapshotRequest=null;
  return ++snapshotLoadVersion;
}
function setActiveHosted(id) {
  activeHostedId=id;$('hostedSnapshot').value=id;
  $('snapshotDescription').textContent=hostedSnapshots.find(entry=>entry.id===id)?.description||'';
  const url=new URL(location.href);
  if(id) url.searchParams.set('snapshot',id);else url.searchParams.delete('snapshot');
  history.replaceState(null,'',url);
}
async function fetchSnapshot(url,name,id='') {
  const version=beginSnapshotLoad(),request=new AbortController();snapshotRequest=request;
  message(`Downloading ${name}…`);
  try {
    const response=await fetch(url,{signal:request.signal});
    if(!response.ok) throw Error(`HTTP ${response.status}: ${name}`);
    const total=Number(response.headers.get('content-length')),reader=response.body?.getReader();
    let bytes;
    if(reader) {
      const chunks=[];let received=0,lastProgress=0;
      while(true) {
        const {done,value}=await reader.read();if(done) break;
        chunks.push(value);received+=value.byteLength;
        if(version===snapshotLoadVersion&&performance.now()-lastProgress>150) {
          message(`Downloading ${name} · ${(received/1048576).toFixed(1)} MB${total>0?` / ${(total/1048576).toFixed(1)} MB`:''}`);lastProgress=performance.now();
        }
      }
      bytes=new Uint8Array(received);let offset=0;
      for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
    } else bytes=new Uint8Array(await response.arrayBuffer());
    if(version!==snapshotLoadVersion) return;
    message(`Opening ${name}…`);
    const data=await decodeSnapshot(bytes);
    if(version!==snapshotLoadVersion) return;
    load(data,name);setActiveHosted(id);
  } catch(error) {
    if(version===snapshotLoadVersion&&error.name!=='AbortError') {
      $('hostedSnapshot').value=activeHostedId;
      message(`Could not load snapshot: ${error.message}`,true);
    }
  } finally {if(snapshotRequest===request) snapshotRequest=null;}
}
async function openFile(file) {
  if(!file) return;
  const version=beginSnapshotLoad();
  message(`Loading ${file.name}…`);
  try {
    const data=await decodeSnapshot(await file.arrayBuffer());
    if(version!==snapshotLoadVersion) return;
    load(data,file.name);setActiveHosted('');
  }catch(error){if(version===snapshotLoadVersion) message(`Could not load snapshot: ${error.message}`,true);}
}
$('hostedSnapshot').onchange=()=>{
  const entry=hostedSnapshots.find(entry=>entry.id===$('hostedSnapshot').value);
  if(entry) fetchSnapshot(entry.url,entry.name,entry.id);
};
$('openSnapshot').onclick=()=>{
  message('Choose a JSON file in the file dialog. You can also drop it onto the viewer.');
  try {$('file').click();}catch(error){message(`Could not open the file dialog: ${error.message}. Drop the JSON file onto the viewer instead.`,true);}
};
$('file').addEventListener('change',async event=>{
  await openFile(event.target.files[0]);event.target.value='';
});
$('file').addEventListener('cancel',()=>message(''));
document.addEventListener('dragover',event=>{
  if(event.dataTransfer?.types.includes('Files')) {event.preventDefault();event.dataTransfer.dropEffect='copy';}
});
document.addEventListener('drop',event=>{
  if(!event.dataTransfer?.files.length) return;
  event.preventDefault();openFile(event.dataTransfer.files[0]);
});
$('demo').onclick=()=>safe(()=>{beginSnapshotLoad();load(demoSnapshot(),'Demo · synthetic field');setActiveHosted('');});
$('frame').onclick=frameAll;$('focus').onclick=frameSelected;
for(const id of ['metric','threshold','exposure']) $(id).addEventListener('change',()=>safe(rebuild));
for(const id of ['sphereMinRadius','sphereMaxRadius']) $(id).addEventListener('change',()=>{
  const minInput=$('sphereMinRadius'),maxInput=$('sphereMaxRadius');
  minInput.value=Math.max(0,Number(minInput.value)||0);
  maxInput.value=Math.max(1e-6,Number(maxInput.value)||1e-6);
  if(Number(minInput.value)>Number(maxInput.value)) {
    if(id==='sphereMinRadius') maxInput.value=minInput.value;
    else minInput.value=maxInput.value;
  }
});
$('worldUp').onchange=()=>{camera.up=$('worldUp').value==='z'?[0,0,1]:[0,1,0];frameAll();};
$('speed').onchange=()=>{camera.speed=Math.max(.01,Math.min(1000,Number($('speed').value)||5));$('speed').value=camera.speed;};
$('cellId').onchange=()=>{
  if(!scene) return;const id=Number($('cellId').value),cell=scene.cells.find(c=>c.id===id);
  if(!cell) {message(`No cell with ID ${id}.`,true);return;}
  message('');selectCell(cell);
};
canvas.addEventListener('contextmenu',event=>event.preventDefault());
canvas.addEventListener('pointerdown',event=>{
  canvas.focus();
  if(event.button===2) {looking=true;lastMouse=[event.clientX,event.clientY];canvas.setPointerCapture(event.pointerId);canvas.style.cursor='grabbing';event.preventDefault();}
});
canvas.addEventListener('pointermove',event=>{
  if(!looking||!(event.buttons&2)) return;
  if(lastMouse) {camera.yaw+=(event.clientX-lastMouse[0])*.002;camera.pitch=Math.max(-1.55,Math.min(1.55,camera.pitch-(event.clientY-lastMouse[1])*.002));}
  lastMouse=[event.clientX,event.clientY];
});
canvas.addEventListener('pointerup',event=>{if(event.button===2) {looking=false;lastMouse=null;canvas.style.cursor='';}});
canvas.addEventListener('lostpointercapture',()=>{looking=false;lastMouse=null;canvas.style.cursor='';});
canvas.addEventListener('click',pick);
canvas.addEventListener('wheel',event=>{
  event.preventDefault();const steps=-event.deltaY/(event.deltaMode===1?3:event.deltaMode===2?1:100);
  camera.speed=Math.max(.01,Math.min(1000,camera.speed*1.2**Math.max(-5,Math.min(5,steps))));$('speed').value=Number(camera.speed.toPrecision(4));
},{passive:false});
canvas.addEventListener('keydown',event=>{
  if(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ShiftLeft','ShiftRight'].includes(event.code)) {keys.add(event.code);event.preventDefault();}
  if(event.code==='KeyF') {frameAll();event.preventDefault();}
  if(event.code==='Escape') {stopInput();canvas.blur();}
});
window.addEventListener('keyup',event=>keys.delete(event.code));window.addEventListener('blur',stopInput);
canvas.addEventListener('blur',stopInput);document.addEventListener('visibilitychange',stopInput);

function render(time) {
  requestAnimationFrame(render);
  const dt=Math.min(.05,(time-lastTime)/1000||0);lastTime=time;
  if(!gpu||!scene||!cellGroup) return;
  if(densityDirty) computeDensityField();
  const {forward,right,up}=basis();let movement=[0,0,0];
  for(const [positive,negative,axis] of [['KeyW','KeyS',forward],['KeyD','KeyA',right],['KeyE','KeyQ',camera.up]])
    movement=add(movement,mul(axis,Number(keys.has(positive))-Number(keys.has(negative))));
  if(dot(movement,movement)>0) camera.position=add(camera.position,mul(normalize(movement),camera.speed/scene.span*dt*((keys.has('ShiftLeft')||keys.has('ShiftRight'))?4:1)));
  const ratio=Math.min(devicePixelRatio||1,2),rect=canvas.getBoundingClientRect();
  const max=gpu.device.limits.maxTextureDimension2D;
  const width=Math.max(1,Math.min(max,Math.round(rect.width*ratio))),height=Math.max(1,Math.min(max,Math.round(rect.height*ratio)));
  if(canvas.width!==width||canvas.height!==height||!depthTexture) {
    canvas.width=width;canvas.height=height;depthTexture?.destroy();
    depthTexture=gpu.device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
  }
  const far=Math.max(100,Math.hypot(...camera.position)+10);
  const uniform=new Float32Array([...camera.position,0,...right,0,...up,0,...forward,0,width/height,Math.tan(Math.PI/6),.0001,far,.004,visible.findIndex(v=>v.cell===selected),0,0]);
  gpu.device.queue.writeBuffer(gpu.uniform,0,uniform);
  const encoder=gpu.device.createCommandEncoder();
  const pass=encoder.beginRenderPass({colorAttachments:[{view:gpu.context.getCurrentTexture().createView(),clearValue:{r:.025,g:.04,b:.065,a:1},loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depthTexture.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
  pass.setBindGroup(0,gpu.cameraGroup);pass.setBindGroup(1,cellGroup);pass.setPipeline(gpu.pipeline);
  if($('filled').checked) {pass.setPipeline(gpu.solidPipeline);pass.draw(36,visible.length);pass.setPipeline(gpu.pipeline);}
  if($('boxes').checked) pass.draw(24,visible.length);
  else if(selected) {const index=visible.findIndex(v=>v.cell===selected);if(index>=0) pass.draw(24,1,0,index);}
  if($('pivots').checked) pass.draw(6,visible.length,24);
  if(lineBuffer&&lineCount) {pass.setPipeline(gpu.linePipeline);pass.setVertexBuffer(0,lineBuffer);pass.draw(lineCount);}
  pass.end();
  if(selected&&densityReady&&$('directions').checked&&visible.some(v=>v.cell===selected)) {
    const center=local(selected.position);
    // Fixed world-space radius: camera distance and viewport size never resize it.
    const sphereRadius=heatmapWorldRadius(selected)/scene.span;
    gpu.device.queue.writeBuffer(gpu.sphereUniform,0,new Float32Array([...center,sphereRadius]));
    // Separate overlay pass keeps the selected distribution readable when its
    // pivot lies within filled geometry; sphere self-visibility is ray traced.
    const spherePass=encoder.beginRenderPass({colorAttachments:[{view:gpu.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}]});
    spherePass.setPipeline(gpu.spherePipeline);spherePass.setBindGroup(0,gpu.cameraGroup);spherePass.setBindGroup(1,gpu.sphereGroup);
    spherePass.draw(3);spherePass.end();
  }
  if(densityReady&&!$('distribution').hidden) {
    const flatPass=encoder.beginRenderPass({colorAttachments:[{view:gpu.densityContext.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:1,a:1}}]});
    flatPass.setPipeline(gpu.flatPipeline);flatPass.setBindGroup(0,gpu.sphereGroup);flatPass.draw(3);flatPass.end();
  }
  gpu.device.queue.submit([encoder.finish()]);
  if(Math.floor(time/150)!==Math.floor((time-dt*1000)/150)) $('cameraInfo').textContent=`Position ${vec(world(camera.position))} · speed ${fmt(camera.speed)}`;
}
requestAnimationFrame(render);
initializeGPU().then(async()=>{
  message(scene?(scene.cells.length?'':'This snapshot has no active guiding cells.'):'Open a guiding JSON snapshot or load the demo.');
  const manifestURL=new URL('./snapshots.json',location.href),response=await fetch(manifestURL,{cache:'no-cache'});
  const catalog=response.ok?parseCatalog(await response.json(),manifestURL):{snapshots:[],default:null};
  hostedSnapshots=catalog.snapshots;
  for(const entry of hostedSnapshots) {const option=document.createElement('option');option.value=entry.id;option.textContent=entry.name;$('hostedSnapshot').append(option);}
  $('hostedCatalog').hidden=hostedSnapshots.length===0;
  const configResponse=await fetch('./viewer-config.json');
  const config=configResponse.ok?await configResponse.json():{};
  if(scene||snapshotLoadVersion) return;
  const requested=new URL(location.href).searchParams.get('snapshot');
  if(requested) {
    const entry=hostedSnapshots.find(entry=>entry.id===requested);
    if(!entry) throw Error(`Unknown published snapshot: ${requested}`);
    $('hostedSnapshot').value=entry.id;await fetchSnapshot(entry.url,entry.name,entry.id);
  } else if(config.url) await fetchSnapshot(new URL(config.url,location.href),config.name);
  else if(catalog.default) {
    const entry=hostedSnapshots.find(entry=>entry.id===catalog.default);
    $('hostedSnapshot').value=entry.id;await fetchSnapshot(entry.url,entry.name,entry.id);
  } else if(hostedSnapshots.length) message('Choose a published snapshot from the list.');
}).catch(error=>message(error.message,true));

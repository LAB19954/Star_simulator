/* =========================================================================
   COSMOGENESIS — transition.js
   3D Universe Evolution Simulator (Three.js).
   Handles the cosmic-epoch state machine, all stage transitions, the
   particle/planet physics, and the orbit/zoom camera controls.
   Physics is illustrative, but every named threshold/timescale is real.
   NOTE: planets form during the Main Sequence stage (a protoplanetary disk
   coalesces while the star is still burning hydrogen) and then either
   survive with wider orbits (white dwarf branch) or are obliterated in
   the supernova (black hole branch) — carried through Death/Remnant/Planets.
========================================================================= */

let W = window.innerWidth, H = window.innerHeight;

/* ---------------- THREE SETUP ---------------- */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:false});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
renderer.setSize(W,H);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030308);
scene.fog = new THREE.FogExp2(0x030308, 0.0011);

const camera = new THREE.PerspectiveCamera(52, W/H, 0.1, 8000);

const ambient = new THREE.AmbientLight(0x8899ff, 0.35);
scene.add(ambient);
const coreLight = new THREE.PointLight(0xfff4e0, 0, 900, 2);
scene.add(coreLight);

/* distant static starfield */
(function buildStarfield(){
  const N = 2200;
  const pos = new Float32Array(N*3);
  const col = new Float32Array(N*3);
  for(let i=0;i<N;i++){
    const r = 1400 + Math.random()*1800;
    const theta = Math.random()*Math.PI*2;
    const phi = Math.acos((Math.random()*2)-1);
    pos[i*3] = r*Math.sin(phi)*Math.cos(theta);
    pos[i*3+1] = r*Math.cos(phi);
    pos[i*3+2] = r*Math.sin(phi)*Math.sin(theta);
    const b = 0.4+Math.random()*0.5;
    col[i*3]=b; col[i*3+1]=b; col[i*3+2]=b+Math.random()*0.15;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color', new THREE.BufferAttribute(col,3));
  const m = new THREE.PointsMaterial({size:2.2, vertexColors:true, transparent:true, opacity:0.7, sizeAttenuation:false});
  scene.add(new THREE.Points(g,m));
})();

/* ---------------- CUSTOM SHADER PARTICLES ---------------- */
const VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main(){
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position,1.0);
  gl_PointSize = aSize * (420.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
precision mediump float;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float d = length(gl_PointCoord - vec2(0.5));
  float glow = smoothstep(0.5, 0.02, d);
  if(glow <= 0.001) discard;
  gl_FragColor = vec4(vColor, glow * vAlpha);
}`;

const MAX_P = 900;
const posArr = new Float32Array(MAX_P*3);
const colArr = new Float32Array(MAX_P*3);
const sizeArr = new Float32Array(MAX_P);
const alphaArr = new Float32Array(MAX_P);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(posArr,3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aColor', new THREE.BufferAttribute(colArr,3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr,1).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alphaArr,1).setUsage(THREE.DynamicDrawUsage));
pGeo.setDrawRange(0,0);
const pMat = new THREE.ShaderMaterial({vertexShader:VERT, fragmentShader:FRAG, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending});
const pointCloud = new THREE.Points(pGeo, pMat);
scene.add(pointCloud);

/* glow sprite for star / remnant core */
function makeGlowTexture(){
  const c = document.createElement('canvas'); c.width=128; c.height=128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64,64,0,64,64,64);
  g.addColorStop(0,'rgba(255,255,255,1)');
  g.addColorStop(0.35,'rgba(255,255,255,0.5)');
  g.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,128,128);
  return new THREE.CanvasTexture(c);
}
const glowTex = makeGlowTexture();
const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex, color:0xfff4e0, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false}));
glowSprite.scale.set(0,0,0);
scene.add(glowSprite);

const coreMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1,24,24),
  new THREE.MeshBasicMaterial({color:0xfff4e0})
);
coreMesh.scale.set(0,0,0);
scene.add(coreMesh);

/* planet group (persists across Main Sequence -> Death -> Remnant -> Planets) */
const planetGroup = new THREE.Group();
scene.add(planetGroup);
const ringGroup = new THREE.Group();
scene.add(ringGroup);

/* ---------------- CAMERA ORBIT/ZOOM CONTROLS ---------------- */
let camTarget = new THREE.Vector3(0,0,0);
let desiredTarget = new THREE.Vector3(0,0,0);
let camAzimuth = 0.7, camPolar = 1.15, camRadius = 420;
let desiredRadius = 420;
let dragging = false, lastX=0, lastY=0;
let pinchStartDist = null, pinchStartRadius = null;

function updateCameraPosition(){
  camTarget.lerp(desiredTarget, 0.045);
  camRadius += (desiredRadius-camRadius)*0.08;
  const x = camTarget.x + camRadius*Math.sin(camPolar)*Math.sin(camAzimuth);
  const y = camTarget.y + camRadius*Math.cos(camPolar);
  const z = camTarget.z + camRadius*Math.sin(camPolar)*Math.cos(camAzimuth);
  camera.position.set(x,y,z);
  camera.lookAt(camTarget);
}

function hideHintSoon(){
  const el = document.getElementById('camHint');
  setTimeout(()=>{ el.style.opacity='0'; }, 400);
}

canvas.addEventListener('mousedown', e=>{ dragging=true; lastX=e.clientX; lastY=e.clientY; canvas.classList.add('dragging'); hideHintSoon(); });
window.addEventListener('mouseup', ()=>{ dragging=false; canvas.classList.remove('dragging'); });
window.addEventListener('mousemove', e=>{
  if(!dragging) return;
  const dx = e.clientX-lastX, dy = e.clientY-lastY;
  lastX=e.clientX; lastY=e.clientY;
  camAzimuth -= dx*0.006;
  camPolar = Math.max(0.25, Math.min(Math.PI-0.25, camPolar - dy*0.006));
});
canvas.addEventListener('wheel', e=>{
  e.preventDefault();
  desiredRadius = Math.max(50, Math.min(1600, desiredRadius + e.deltaY*0.45));
  hideHintSoon();
}, {passive:false});

canvas.addEventListener('touchstart', e=>{
  hideHintSoon();
  if(e.touches.length===1){ dragging=true; lastX=e.touches[0].clientX; lastY=e.touches[0].clientY; }
  else if(e.touches.length===2){
    dragging=false;
    pinchStartDist = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
    pinchStartRadius = desiredRadius;
  }
}, {passive:true});
canvas.addEventListener('touchmove', e=>{
  if(e.touches.length===1 && dragging){
    const dx=e.touches[0].clientX-lastX, dy=e.touches[0].clientY-lastY;
    lastX=e.touches[0].clientX; lastY=e.touches[0].clientY;
    camAzimuth -= dx*0.006;
    camPolar = Math.max(0.25, Math.min(Math.PI-0.25, camPolar - dy*0.006));
  } else if(e.touches.length===2 && pinchStartDist){
    const d = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
    desiredRadius = Math.max(50, Math.min(1600, pinchStartRadius * (pinchStartDist/d)));
  }
}, {passive:true});
canvas.addEventListener('touchend', e=>{ if(e.touches.length===0){ dragging=false; pinchStartDist=null; } }, {passive:true});

window.addEventListener('resize', ()=>{
  W = window.innerWidth; H = window.innerHeight;
  camera.aspect = W/H; camera.updateProjectionMatrix();
  renderer.setSize(W,H);
});

/* ---------------- STAGE DEFINITIONS ---------------- */
const STAGES = [
  {id:'singularity', label:'The Singularity', eyebrow:'T + 0 SECONDS · PLANCK EPOCH',
   summary:'All matter, energy, space and time begin compressed into a single point of infinite density — the Planck epoch, t ≈ 10⁻⁴³ s. Distance and duration have no meaning yet.', dur:2.2},
  {id:'inflation', label:'Cosmic Inflation', eyebrow:'T + 10⁻³² SECONDS',
   summary:'Space itself expands exponentially — by a factor of roughly 10²⁶ — in a fraction of a second, stretching quantum fluctuations into the seeds of every future galaxy.', dur:2.8},
  {id:'plasma', label:'Quark–Gluon Plasma', eyebrow:'T + 10⁻⁶ SECONDS',
   summary:'The universe is a searingly hot soup of free quarks and gluons, far too energetic for protons or neutrons to hold together yet.', dur:3},
  {id:'nucleosynthesis', label:'Big Bang Nucleosynthesis', eyebrow:'T + 3 MINUTES',
   summary:'Protons and neutrons fuse into the first atomic nuclei — hydrogen, helium, trace lithium. This is the universe\'s only primordial fusion event.', dur:3},
  {id:'recombination', label:'Recombination', eyebrow:'T + 380,000 YEARS',
   summary:'Electrons bind to nuclei, forming neutral atoms. Photons decouple from matter and stream freely — this afterglow is the Cosmic Microwave Background we still detect today.', dur:3},
  {id:'darkages', label:'Gravitational Clumping', eyebrow:'T + ~200 MILLION YEARS',
   summary:'Gravity slowly amplifies tiny density fluctuations. Neutral hydrogen and helium gas drifts together into proto-clouds — the seeds of the first stars.', dur:4},
  {id:'collapse', label:'Gravitational Collapse', eyebrow:'SET INITIAL STELLAR MASS →',
   summary:'A gas fragment overcomes internal pressure (the Jeans instability) and collapses under its own gravity, heating as it densifies toward ignition.', dur:3.5},
  {id:'ignition', label:'Stellar Ignition', eyebrow:'PROTOSTAR → MAIN SEQUENCE',
   summary:'Core temperature crosses roughly 10⁷ K — hydrogen fusion ignites. Outward radiation pressure now balances inward gravity: a star is born.', dur:3},
  {id:'mainsequence', label:'Main Sequence Burning', eyebrow:'STABLE HYDROGEN FUSION',
   summary:'The star spends most of its life quietly fusing hydrogen into helium. Meanwhile, leftover dust and gas encircling it flattens into a protoplanetary disk — planets begin forming while the star still burns.', dur:4.5},
  {id:'death', label:'', eyebrow:'', summary:'', dur:4},
  {id:'remnant', label:'', eyebrow:'', summary:'', dur:3.5},
  {id:'planets', label:'', eyebrow:'', summary:'', dur:4.5}
];

let stellarMass = 8.0;
let fate = 'bh';
function computeFate(m){
  if(m < 8) return 'wd';
  if(m < 25) return 'ns';
  return 'bh';
}
function fateInfo(f){
  if(f==='wd') return {
    name:'White Dwarf',
    cls:'wd',
    desc:'Electron degeneracy pressure prevents collapse. A dense stellar ember remains.'
  };

  if(f==='ns') return {
    name:'Neutron Star',
    cls:'ns',
    desc:'Core collapse compresses matter into a city-sized neutron star supported by neutron degeneracy pressure.'
  };

  return {
    name:'Black Hole',
    cls:'bh',
    desc:'Gravity overwhelms all known forces and creates an event horizon.'
  };
}
function updateFatePanel(){
  fate = computeFate(stellarMass);
  const info = fateInfo(fate);
  const nameEl = document.getElementById('fateName');
  nameEl.textContent = info.name; nameEl.className='fate-name '+info.cls;
  document.getElementById('fateDesc').textContent = info.desc;
}

/* ---------------- PARTICLE STATE (3D) ---------------- */
let particles = [];
function Pt(x,y,z,color,size=2.4,extra={}){ return Object.assign({x,y,z,vx:0,vy:0,vz:0,color,size,alpha:1},extra); }
function rand(a,b){ return a+Math.random()*(b-a); }
function randSphereDir(){
  const theta = Math.random()*Math.PI*2, phi = Math.acos(rand(-1,1));
  return [Math.sin(phi)*Math.cos(theta), Math.cos(phi), Math.sin(phi)*Math.sin(theta)];
}
function dist3(a,b){ return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z); }

const COL = {
  hot:[1.0,0.957,0.878], amber:[1.0,0.541,0.239], magenta:[0.937,0.302,0.62],
  cyan:[0.31,0.847,0.914], indigo:[0.482,0.38,1.0], cream:[0.914,0.914,0.961], blue:[0.549,0.847,1.0]
};

let collapseCenter = new THREE.Vector3(60,10,-40);
let clumps = [];
let chosenClumpIdx = 0;
let planets = [];

function clearParticles(){ particles = []; }

/* ---- planets: created during Main Sequence, evolve through later stages ---- */
function createPlanets(){
  planets = [];
  const n = 3+Math.floor(Math.random()*3);
  const colors = [0x8fd6ff,0xff9d5c,0xc9a3ff,0x7ee8b8,0xffd27a];
  for(let k=0;k<n;k++){
    const [dx,,dz] = randSphereDir();
    planets.push({
      baseOrbitR: 42+k*20+rand(0,6),
      orbitR: 0,
      orbitA: Math.random()*Math.PI*2,
      orbitSpeed: 0.55/(1+k*0.5),
      r: 2.6+Math.random()*3.4,
      color: colors[k%5],
      incl: rand(-0.18,0.18),
      alpha: 1,
      scatterDir: new THREE.Vector3(dx, rand(-0.4,0.4), dz).normalize(),
      scatterSpeed: rand(180,340)
    });
  }
  planets.forEach(p=>p.orbitR = p.baseOrbitR);
}

function renderPlanets(){
  planetGroup.clear(); ringGroup.clear();
  planets.forEach(pl=>{
    if(pl.alpha<=0.02) return;
    const x = collapseCenter.x+Math.cos(pl.orbitA)*pl.orbitR;
    const z = collapseCenter.z+Math.sin(pl.orbitA)*pl.orbitR;
    const y = collapseCenter.y+Math.sin(pl.orbitA)*pl.orbitR*Math.sin(pl.incl);
    const mat = new THREE.MeshStandardMaterial({color:pl.color, roughness:0.6, metalness:0.1, transparent:true, opacity:pl.alpha});
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(pl.r,16,16), mat);
    mesh.position.set(x,y,z);
    planetGroup.add(mesh);

    const curve = new THREE.EllipseCurve(0,0,pl.orbitR,pl.orbitR,0,Math.PI*2,false,0);
    const pts = curve.getPoints(64).map(p=>new THREE.Vector3(p.x,0,p.y));
    const ringGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const ring = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({color:0xffffff, transparent:true, opacity:0.12*pl.alpha}));
    ring.position.copy(collapseCenter);
    ring.rotation.x = pl.incl;
    ringGroup.add(ring);
  });
}

/* ---------------- STAGE INIT (3D) ---------------- */
function initStage(i){
  const s = STAGES[i];

  const telemetryStages = {
    singularity:["T + 0 SEC","10³² K","Quantum Singularity"],
    inflation:["T + 10⁻³² SEC","10²⁷ K","Inflationary Plasma"],
    plasma:["T + 10⁻⁶ SEC","10¹² K","Quark-Gluon Plasma"],
    nucleosynthesis:["T + 3 MINUTES","10⁹ K","Atomic Nuclei"],
    recombination:["380,000 YEARS","3000 K","Neutral Atoms"],
    darkages:["200 MILLION YEARS","100 K","Hydrogen Clouds"],
    ignition:["PROTOSTAR","10⁷ K","Hydrogen Fusion"],
    mainsequence:["MILLIONS OF YEARS","10⁷ K CORE","Stable Fusion"]
  };

  if(telemetryStages[s.id]){
    setTelemetry(...telemetryStages[s.id]);
  }

  glowSprite.scale.set(0,0,0);
  coreMesh.scale.set(0,0,0);
  coreLight.intensity = 0;

  if(s.id==='singularity'){
    clearParticles();
    particles.push(Pt(0,0,0, COL.hot, 6));
    desiredTarget.set(0,0,0); desiredRadius = 260;
  }
  else if(s.id==='inflation'){
    clearParticles();
    for(let k=0;k<140;k++){
      const [dx,dy,dz] = randSphereDir();
      particles.push(Pt(0,0,0, COL.hot, 2, {dir:[dx,dy,dz], speed: rand(30,140)}));
    }
    desiredTarget.set(0,0,0); desiredRadius = 340;
  }
  else if(s.id==='plasma'){
    particles.forEach(p=>{
      p.color = Math.random()<0.5?COL.magenta:COL.cyan;
      p.jx=rand(-1,1); p.jy=rand(-1,1); p.jz=rand(-1,1);
    });
    while(particles.length<220){
      particles.push(Pt(rand(-150,150),rand(-100,100),rand(-150,150), Math.random()<0.5?COL.magenta:COL.cyan, 1.8, {jx:rand(-1,1),jy:rand(-1,1),jz:rand(-1,1)}));
    }
  }
  else if(s.id==='nucleosynthesis'){
    particles.forEach((p,idx)=>{ p.color = idx%5===0?COL.amber:COL.hot; p.jx*=0.55; p.jy*=0.55; p.jz*=0.55; });
  }
  else if(s.id==='recombination'){
    particles.forEach(p=>{ p.color = COL.cream; p.jx*=0.4; p.jy*=0.4; p.jz*=0.4; });
  }
  else if(s.id==='darkages'){
    clumps = [];
    const n=6;
    for(let k=0;k<n;k++){
      const [dx,dy,dz] = randSphereDir();
      const r = rand(90,160);
      clumps.push({x:dx*r,y:dy*r*0.5,z:dz*r, mass:rand(1,3)});
    }
    chosenClumpIdx = Math.floor(Math.random()*n);
    particles.forEach(p=>{ p.color = COL.indigo; });
    desiredRadius = 460;
  }
  else if(s.id==='collapse'){
    const c = clumps[chosenClumpIdx];
    collapseCenter.set(c.x,c.y,c.z);
    particles.forEach((p,idx)=>{ p.target = (idx%3!==0) ? c : null; p.color = COL.blue; });
    planets = []; planetGroup.clear(); ringGroup.clear();
    desiredTarget.copy(collapseCenter); desiredRadius = 240;
    document.getElementById('toast').classList.add('show');
    setTimeout(()=>document.getElementById('toast').classList.remove('show'), 1800);
  }
  else if(s.id==='ignition'){
    particles = particles.filter(p=> dist3(p,collapseCenter) < 70);
    particles.forEach(p=>{
      p.color = COL.hot;
      const vec = new THREE.Vector3(p.x-collapseCenter.x,p.y-collapseCenter.y,p.z-collapseCenter.z);
      p.orbitR = vec.length()||10;
      p.orbitAxis = new THREE.Vector3(rand(-1,1),rand(-1,1),rand(-1,1)).normalize();
      p.orbitAngle = Math.random()*Math.PI*2;
      p.orbitSpeed = rand(0.5,1.1);
    });
    desiredTarget.copy(collapseCenter); desiredRadius = 160;
  }
  else if(s.id==='mainsequence'){
    const starColor = stellarMass<3?COL.amber:stellarMass<15?COL.hot:COL.blue;
    particles.forEach(p=>{ p.color = starColor; });
    createPlanets(); // <-- planetary formation now begins here, while the star still burns
    desiredRadius = 260;
  }
  else if(s.id==='death'){
    if(fate==='wd'){
      s.label='Red Giant → Planetary Nebula'; s.eyebrow='LOW-MASS STELLAR DEATH';
      s.summary='Without enough mass to fuse past helium, the star swells into a red giant, then gently sheds its outer layers into a glowing planetary nebula. Its planets survive, drifting outward as the star loses mass.';
      particles.forEach(p=>{ const [dx,dy,dz]=randSphereDir(); p.dir=[dx,dy,dz]; p.speed=rand(20,55); p.color=COL.amber; });
    } else {
      s.label='Core-Collapse Supernova'; s.eyebrow='MASSIVE STAR DEATH · ≥8 M☉';
      s.summary='Fuel runs out, the iron core collapses in under a second, then rebounds in a shockwave that blows the star apart — briefly outshining its entire host galaxy, and obliterating any planets in its path.';
      particles.forEach(p=>{ const [dx,dy,dz]=randSphereDir(); p.dir=[dx,dy,dz]; p.speed=rand(70,190); p.color=Math.random()<0.5?COL.hot:COL.amber; });
      for(let k=0;k<160;k++){
        const [dx,dy,dz]=randSphereDir();
        particles.push(Pt(collapseCenter.x,collapseCenter.y,collapseCenter.z, Math.random()<0.5?COL.amber:COL.magenta, rand(1,2.2), {dir:[dx,dy,dz], speed:rand(60,210)}));
      }
    }
    desiredRadius = 320;
  }
  else if(s.id==='remnant'){
    if(fate==='wd'){ s.label='White Dwarf'; s.eyebrow='STELLAR CORPSE · ELECTRON-DEGENERATE';
      s.summary='What remains is an Earth-sized ember of carbon and oxygen, held up against gravity by electron degeneracy pressure. It will cool for trillions of years — and its surviving planets keep orbiting, now on wider paths.'; }
    else { s.label='Black Hole'; s.eyebrow='EVENT HORIZON FORMED';
      s.summary='Gravity has won completely. Not even light can escape past the event horizon — spacetime itself has been bent into a one-way door. Nothing remains of the planetary disk that once formed here.'; }
    particles.forEach((p,idx)=>{
      p.orbitR = rand(40,130);
      p.orbitAxis = new THREE.Vector3(0,1,0).applyAxisAngle(new THREE.Vector3(1,0,0), rand(-0.3,0.3));
      p.orbitAngle = Math.random()*Math.PI*2;
      p.orbitSpeed = rand(0.3,0.9);
      p.color = fate==='bh' ? (idx%2===0?COL.magenta:COL.indigo) : COL.cyan;
    });
    desiredTarget.copy(collapseCenter); desiredRadius = 200;
  }
  else if(s.id==='planets'){
    if(fate==='wd'){
      s.label='Surviving Planetary System'; s.eyebrow='SECOND-GENERATION ORBITS';
      s.summary='The planets that formed back during the main-sequence phase are still here, now settled into wider, stable orbits around the cooling white dwarf.';
      // one extra planet condenses from lingering nebular debris
      const [dx,,dz] = randSphereDir();
      planets.push({baseOrbitR: Math.max(...planets.map(p=>p.orbitR||p.baseOrbitR), 60)+30, orbitR:0, orbitA:Math.random()*Math.PI*2,
        orbitSpeed:0.2, r:3+Math.random()*3, color:0xffd27a, incl:rand(-0.15,0.15), alpha:1,
        scatterDir:new THREE.Vector3(dx,0,dz).normalize(), scatterSpeed:0});
      planets[planets.length-1].orbitR = planets[planets.length-1].baseOrbitR;
    } else {
      s.label='Accretion Disk — No Planets Survive'; s.eyebrow='POST-SUPERNOVA AFTERMATH';
      s.summary='The protoplanetary disk that began forming during the main-sequence phase never got the chance to finish — it was vaporized in the supernova. Only infalling matter spiraling toward the event horizon remains.';
    }
    desiredRadius = 340;
  }
  refreshLog(i);
}

/* ---------------- STAGE UPDATE (3D) ---------------- */
function updateStage(i, dt, tNorm){
  const s = STAGES[i];

  const telemetryStages = {
    singularity:["T + 0 SEC","10³² K","Quantum Singularity"],
    inflation:["T + 10⁻³² SEC","10²⁷ K","Inflationary Plasma"],
    plasma:["T + 10⁻⁶ SEC","10¹² K","Quark-Gluon Plasma"],
    nucleosynthesis:["T + 3 MINUTES","10⁹ K","Atomic Nuclei"],
    recombination:["380,000 YEARS","3000 K","Neutral Atoms"],
    darkages:["200 MILLION YEARS","100 K","Hydrogen Clouds"],
    ignition:["PROTOSTAR","10⁷ K","Hydrogen Fusion"],
    mainsequence:["MILLIONS OF YEARS","10⁷ K CORE","Stable Fusion"]
  };

  if(telemetryStages[s.id]){
    setTelemetry(...telemetryStages[s.id]);
  }

  if(s.id==='singularity'){
    particles[0].size = 6+Math.sin(performance.now()/220)*1.6;
  }
  else if(s.id==='inflation'){
    particles.forEach(p=>{
      const grow = 0.3+tNorm*2.4;
      p.x += p.dir[0]*p.speed*dt*grow; p.y += p.dir[1]*p.speed*dt*grow; p.z += p.dir[2]*p.speed*dt*grow;
    });
  }
  else if(s.id==='plasma'||s.id==='nucleosynthesis'||s.id==='recombination'){
    const damp = s.id==='recombination'?0.4:1;
    particles.forEach(p=>{
      p.x += p.jx*dt*22*damp; p.y += p.jy*dt*22*damp; p.z += p.jz*dt*22*damp;
      if(Math.abs(p.x)>170) p.jx*=-1;
      if(Math.abs(p.y)>120) p.jy*=-1;
      if(Math.abs(p.z)>170) p.jz*=-1;
      p.jx += -p.x*0.0006*dt*60; p.jy += -p.y*0.0006*dt*60; p.jz += -p.z*0.0006*dt*60;
    });
  }
  else if(s.id==='darkages'){
    particles.forEach(p=>{
      let fx=0,fy=0,fz=0;
      clumps.forEach(c=>{
        const dx=c.x-p.x, dy=c.y-p.y, dz=c.z-p.z;
        const d2=Math.max(300, dx*dx+dy*dy+dz*dz);
        const f = c.mass*900/d2, d=Math.sqrt(d2);
        fx+=dx*f/d; fy+=dy*f/d; fz+=dz*f/d;
      });
      p.vx=(p.vx||0)*0.94+fx*dt; p.vy=(p.vy||0)*0.94+fy*dt; p.vz=(p.vz||0)*0.94+fz*dt;
      p.x+=p.vx*dt*30; p.y+=p.vy*dt*30; p.z+=p.vz*dt*30;
    });
  }
  else if(s.id==='collapse'){
    const pull = 0.02+tNorm*0.14;
    particles.forEach(p=>{
      if(p.target){ p.x+=(p.target.x-p.x)*pull; p.y+=(p.target.y-p.y)*pull; p.z+=(p.target.z-p.z)*pull; }
      else { p.x+=(p.x-collapseCenter.x)*0.003; p.y+=(p.y-collapseCenter.y)*0.003; p.z+=(p.z-collapseCenter.z)*0.003; }
    });
  }
  else if(s.id==='ignition'){
    const shrink = 1-tNorm*0.55;
    particles.forEach(p=>{
      p.orbitAngle += p.orbitSpeed*dt*2;
      const v = new THREE.Vector3(p.orbitR*shrink,0,0).applyAxisAngle(p.orbitAxis, p.orbitAngle);
      p.x = collapseCenter.x+v.x; p.y = collapseCenter.y+v.y; p.z = collapseCenter.z+v.z;
    });
    glowSprite.position.copy(collapseCenter);
    coreMesh.position.copy(collapseCenter);
    const sc = 4+tNorm*10;
    glowSprite.scale.set(sc*7,sc*7,1); coreMesh.scale.set(sc*0.5,sc*0.5,sc*0.5);
    coreLight.position.copy(collapseCenter); coreLight.intensity = tNorm*2.4;
  }
  else if(s.id==='mainsequence'){
    particles.forEach(p=>{
      p.orbitAngle += p.orbitSpeed*dt*1.1;
      const v = new THREE.Vector3(p.orbitR*0.42,0,0).applyAxisAngle(p.orbitAxis, p.orbitAngle);
      p.x = collapseCenter.x+v.x; p.y = collapseCenter.y+v.y; p.z = collapseCenter.z+v.z;
    });
    glowSprite.position.copy(collapseCenter); coreMesh.position.copy(collapseCenter);
    const massScale = 0.55+Math.min(1.4, stellarMass/20);
    glowSprite.scale.set(60*massScale,60*massScale,1); coreMesh.scale.set(5*massScale,5*massScale,5*massScale);
    coreLight.position.copy(collapseCenter); coreLight.intensity = 2.6;
    coreLight.color.setRGB(...(stellarMass<3?COL.amber:stellarMass<15?COL.hot:COL.blue));
    // protoplanetary disk condensing into planets, fading in
    planets.forEach(p=>{ p.orbitA += p.orbitSpeed*dt*0.7; p.alpha = Math.min(1, tNorm*1.8); });
    renderPlanets();
  }
  else if(s.id==='death'){
    if(fate==='wd'){
      particles.forEach(p=>{
        const d = tNorm*130;
        p.x = collapseCenter.x+p.dir[0]*d; p.y = collapseCenter.y+p.dir[1]*d; p.z = collapseCenter.z+p.dir[2]*d;
        p.alpha = 1-tNorm*0.7;
      });
      glowSprite.position.copy(collapseCenter); glowSprite.scale.set(30,30,1); glowSprite.material.opacity = 1-tNorm*0.5;
      // planets gently pushed to wider orbits as the star loses mass
      planets.forEach(p=>{ p.orbitA += p.orbitSpeed*dt*0.7; p.orbitR = p.baseOrbitR*(1+tNorm*0.55); });
    } else {
      particles.forEach(p=>{
        const d = p.speed*tNorm;
        p.x = collapseCenter.x+p.dir[0]*d; p.y = collapseCenter.y+p.dir[1]*d; p.z = collapseCenter.z+p.dir[2]*d;
        p.alpha = Math.max(0,1-tNorm*0.85);
      });
      if(tNorm<0.15){ glowSprite.position.copy(collapseCenter); glowSprite.scale.set(140*(tNorm/0.15),140*(tNorm/0.15),1); }
      else glowSprite.scale.set(0,0,0);
      // planets destroyed: flung outward by the blast and faded out
      planets.forEach(p=>{
        const d = p.scatterSpeed*tNorm;
        p.orbitR = p.baseOrbitR + d; // still used indirectly via renderPlanets orbit math is fine visually
        p.alpha = Math.max(0, 1-tNorm*1.15);
      });
      if(tNorm>=1) planets = [];
    }
    renderPlanets();
  }
  else if(s.id==='remnant'){
    particles.forEach(p=>{
      p.orbitAngle += p.orbitSpeed*dt*(fate==='bh'?1.5:0.75);
      let r = p.orbitR;
      if(fate==='bh') r = Math.max(9, p.orbitR - tNorm*65);
      const v = new THREE.Vector3(r,0,0).applyAxisAngle(p.orbitAxis, p.orbitAngle);
      p.x = collapseCenter.x+v.x; p.y = collapseCenter.y+v.y; p.z = collapseCenter.z+v.z;
      p.alpha = fate==='bh' ? Math.max(0.15,1-tNorm*0.5) : 1;
    });
    coreMesh.position.copy(collapseCenter);
    if(fate==='bh'){
      coreMesh.material.color.set(0x000000);
      coreMesh.scale.set(6,6,6);
      glowSprite.position.copy(collapseCenter); glowSprite.material.color.set(0xef4d9e);
      glowSprite.scale.set(26,26,1); glowSprite.material.opacity=0.5;
    } else {
      coreMesh.material.color.setRGB(...COL.cyan);
      coreMesh.scale.set(4,4,4);
      glowSprite.position.copy(collapseCenter); glowSprite.material.color.set(0xeaf6ff);
      glowSprite.scale.set(24,24,1); glowSprite.material.opacity=0.8;
      planets.forEach(p=>{ p.orbitA += p.orbitSpeed*dt*0.6; });
    }
    renderPlanets();
  }
  else if(s.id==='planets'){
    coreMesh.position.copy(collapseCenter);
    if(fate==='bh'){ coreMesh.material.color.set(0x000000); coreMesh.scale.set(6,6,6);
      glowSprite.position.copy(collapseCenter); glowSprite.material.color.set(0xef4d9e); glowSprite.scale.set(22,22,1); glowSprite.material.opacity=0.45; }
    else { coreMesh.material.color.setRGB(...COL.cyan); coreMesh.scale.set(4,4,4);
      glowSprite.position.copy(collapseCenter); glowSprite.material.color.set(0xeaf6ff); glowSprite.scale.set(20,20,1); glowSprite.material.opacity=0.75; }
    coreLight.position.copy(collapseCenter); coreLight.intensity = fate==='bh'?0:1.6;
    planets.forEach(p=>{ p.orbitA += p.orbitSpeed*dt*0.6; if(p.alpha<1) p.alpha = Math.min(1,p.alpha+dt*0.6); });
    renderPlanets();
  }
}

/* ---------------- SYNC BUFFERS ---------------- */
function syncParticleBuffer(){
  const n = Math.min(particles.length, MAX_P);
  for(let i=0;i<n;i++){
    const p = particles[i];
    posArr[i*3]=p.x; posArr[i*3+1]=p.y; posArr[i*3+2]=p.z;
    colArr[i*3]=p.color[0]; colArr[i*3+1]=p.color[1]; colArr[i*3+2]=p.color[2];
    sizeArr[i]=p.size||2.4;
    alphaArr[i]= p.alpha!==undefined?p.alpha:1;
  }
  pGeo.setDrawRange(0,n);
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.aColor.needsUpdate = true;
  pGeo.attributes.aSize.needsUpdate = true;
  pGeo.attributes.aAlpha.needsUpdate = true;
  document.getElementById('pCount').textContent = n + planets.length;
}

/* ---------------- UI ---------------- */
let stageIndex = 0;
let stageT = 0;
let auto = false;
let stageSettled = false;

/* ===============================
   COSMIC TELEMETRY ENGINE
================================ */

let fps = 60;
let fpsFrames = 0;
let fpsTimer = performance.now();

const telemetryData = {
  age:"T + 0 SEC",
  temperature:"∞ K",
  matter:"Singularity"
};

function updateTelemetry(){
  const age = document.getElementById("cosmicAge");
  const temp = document.getElementById("temperature");
  const state = document.getElementById("matterState");

  if(age) age.textContent = telemetryData.age;
  if(temp) temp.textContent = telemetryData.temperature;
  if(state) state.textContent = telemetryData.matter;
}

function setTelemetry(age,temp,matter){
  telemetryData.age = age;
  telemetryData.temperature = temp;
  telemetryData.matter = matter;
  updateTelemetry();
}


const stageTitleEl = document.getElementById('stageTitle');
const stageEyebrowEl = document.getElementById('stageEyebrow');
const timelineFill = document.getElementById('timelineFill');
const timelineStops = document.getElementById('timelineStops');
const logBody = document.getElementById('logBody');
const nextBtn = document.getElementById('nextBtn');
const prevBtn = document.getElementById('prevBtn');
const massSlider = document.getElementById('massSlider');
const massNum = document.getElementById('massNum');

function buildStops(){
  timelineStops.innerHTML='';
  STAGES.forEach((s,idx)=>{
    const d = document.createElement('div'); d.className='stop';
    d.addEventListener('click', ()=> jumpTo(idx));
    timelineStops.appendChild(d);
  });
}
function refreshStops(){
  [...timelineStops.children].forEach((d,idx)=>{
    d.classList.toggle('done', idx<stageIndex);
    d.classList.toggle('current', idx===stageIndex);
  });
  timelineFill.style.width = (stageIndex/(STAGES.length-1)*100)+'%';
}
function refreshLog(uptoIdx){
  logBody.innerHTML='';
  for(let i=0;i<=uptoIdx;i++){
    const s = STAGES[i];

  const telemetryStages = {
    singularity:["T + 0 SEC","10³² K","Quantum Singularity"],
    inflation:["T + 10⁻³² SEC","10²⁷ K","Inflationary Plasma"],
    plasma:["T + 10⁻⁶ SEC","10¹² K","Quark-Gluon Plasma"],
    nucleosynthesis:["T + 3 MINUTES","10⁹ K","Atomic Nuclei"],
    recombination:["380,000 YEARS","3000 K","Neutral Atoms"],
    darkages:["200 MILLION YEARS","100 K","Hydrogen Clouds"],
    ignition:["PROTOSTAR","10⁷ K","Hydrogen Fusion"],
    mainsequence:["MILLIONS OF YEARS","10⁷ K CORE","Stable Fusion"]
  };

  if(telemetryStages[s.id]){
    setTelemetry(...telemetryStages[s.id]);
  }

    const div = document.createElement('div');
    div.className = 'log-entry'+(i===uptoIdx?' active':'');
    div.innerHTML = `<div class="idx">ENTRY ${String(i+1).padStart(2,'0')} — ${s.eyebrow}</div><div class="title">${s.label}</div><div class="body">${s.summary}</div>`;
    logBody.appendChild(div);
  }
  logBody.scrollTop = logBody.scrollHeight;
}
function syncStageUI(){
  const s = STAGES[stageIndex];
  stageTitleEl.textContent = s.label;
  stageEyebrowEl.textContent = s.eyebrow;
  prevBtn.disabled = stageIndex===0;
  nextBtn.textContent = stageIndex===STAGES.length-1 ? 'SIMULATION COMPLETE' : 'NEXT STAGE ▶';
  nextBtn.disabled = stageIndex===STAGES.length-1;
}
function syncMassLock(){
  massSlider.disabled = stageIndex > STAGES.findIndex(s=>s.id==='collapse');
}

function jumpTo(idx){
  stageIndex = Math.max(0, Math.min(STAGES.length-1, idx));
  stageT = 0; stageSettled = false;
  initStage(stageIndex);
  syncStageUI(); refreshStops(); syncMassLock();
}

massSlider.addEventListener('input', ()=>{
  stellarMass = parseFloat(massSlider.value);
  massNum.textContent = stellarMass.toFixed(1);
  updateFatePanel();
});
updateFatePanel();

nextBtn.addEventListener('click', ()=>{ if(stageIndex<STAGES.length-1) jumpTo(stageIndex+1); });
prevBtn.addEventListener('click', ()=>{ if(stageIndex>0) jumpTo(stageIndex-1); });
document.getElementById('restartBtn').addEventListener('click', ()=>{ auto=false; document.getElementById('autoSwitch').classList.remove('on'); jumpTo(0); });
document.getElementById('autoSwitch').addEventListener('click', function(){
  auto = !auto; this.classList.toggle('on', auto);
});
document.getElementById('startBtn').addEventListener('click', ()=>{
  document.getElementById('intro').classList.add('hide');
});



/* ===============================
   KEYBOARD COMMAND SYSTEM
================================ */

window.addEventListener("keydown",e=>{
  if(e.code==="Space" || e.key==="ArrowRight"){
    if(stageIndex < STAGES.length-1) jumpTo(stageIndex+1);
  }

  if(e.key==="ArrowLeft"){
    if(stageIndex>0) jumpTo(stageIndex-1);
  }

  if(e.key.toLowerCase()==="r"){
    jumpTo(0);
  }
});

/* ---------------- MAIN LOOP ---------------- */
let lastT = performance.now();
function frame(now){

  fpsFrames++;
  if(now - fpsTimer > 1000){
    fps = fpsFrames;
    fpsFrames = 0;
    fpsTimer = now;

    const fpsEl = document.getElementById("fpsCounter");
    if(fpsEl) fpsEl.textContent = fps;
  }


  const dt = Math.min(0.05, (now-lastT)/1000);
  lastT = now;
  requestAnimationFrame(frame);

  const s = STAGES[stageIndex];
  if(!stageSettled){
    stageT += dt;
    const tNorm = Math.min(1, stageT/s.dur);
    updateStage(stageIndex, dt, tNorm);
    if(tNorm>=1){
      stageSettled = true;
      if(auto && stageIndex<STAGES.length-1){
        setTimeout(()=>{ if(auto) jumpTo(stageIndex+1); }, 900);
      }
    }
  } else {
    updateStage(stageIndex, dt, 1);
  }

  syncParticleBuffer();
  updateCameraPosition();
  renderer.render(scene, camera);
}

/* ---------------- INIT ---------------- */
buildStops();
initStage(0);
syncStageUI();
refreshStops();
syncMassLock();
requestAnimationFrame(frame);
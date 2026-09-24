(() => {
  const canvas = document.querySelector('.water-surface');
  if (!canvas) return;
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
  if (!gl) { canvas.hidden = true; return; }
  const vertex = `attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}`;
  const fragment = `
    precision mediump float;
    uniform vec2 resolution;
    uniform float time;
    uniform float darkMode;
    uniform vec3 ripples[6];
    vec2 hash(vec2 p) {
      return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);
    }
    float caustic(vec2 p,float t) {
      vec2 cell=floor(p), f=fract(p);
      float first=8.,second=8.;
      for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++) {
        vec2 n=vec2(float(i),float(j));
        vec2 h=hash(cell+n);
        vec2 point=.5+.34*sin(6.2831*h+t*.32);
        vec2 d=n+point-f;
        float distance=dot(d,d);
        if(distance<first){second=first;first=distance;}
        else if(distance<second){second=distance;}
      }
      return exp(-max(0.,sqrt(second)-sqrt(first))*22.);
    }
    void main(){
      vec2 uv=gl_FragCoord.xy/resolution;
      vec2 p=gl_FragCoord.xy/min(resolution.x,resolution.y);
      vec2 warped=p;
      float rings=0.;
      for(int i=0;i<6;i++){
        float age=time-ripples[i].z;
        vec2 delta=p-ripples[i].xy;
        float d=length(delta);
        float radius=age*.12;
        float envelope=exp(-pow((d-radius)*27.,2.))*max(0.,1.-age/3.5)*step(0.,age);
        float wave=sin((d-radius)*100.);
        warped+=delta/max(d,.001)*wave*envelope*.009;
        rings+=wave*envelope*.055;
      }
      vec2 q=warped*4.3;
      q+=vec2(sin(p.y*5.+time*.17),cos(p.x*4.-time*.13))*.34;
      float a=caustic(q,time);
      float b=caustic(q*1.14+vec2(.6,.9),time+2.);
      float light=pow(a*.65+b*.35,1.6);
      float swell=sin(p.x*3.+p.y*2.+time*.18)*.5+.5;
      vec3 deep=mix(vec3(.77,.86,.94),vec3(.095,.095,.11),darkMode);
      vec3 shallow=mix(vec3(.89,.96,.98),vec3(.18,.18,.20),darkMode);
      vec3 color=mix(deep,shallow,.35+uv.y*.25+swell*.15);
      color+=mix(vec3(.085,.075,.055),vec3(.1,.1,.105),darkMode)*light;
      color+=rings*mix(1.,.18,darkMode);
      // A broad quiet area behind the controls keeps the water unobtrusive.
      float calm=exp(-dot((uv-vec2(.5,.52))*vec2(2.,3.),(uv-vec2(.5,.52))*vec2(2.,3.)));
      color=mix(color,mix(vec3(.91,.95,.99),vec3(.13,.13,.15),darkMode),calm*.35);
      gl_FragColor=vec4(color,1.);
    }`;
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { console.warn('Water shader:', gl.getShaderInfoLog(shader)); gl.deleteShader(shader); return null; }
    return shader;
  }
  const vs=compile(gl.VERTEX_SHADER,vertex), fs=compile(gl.FRAGMENT_SHADER,fragment);
  if (!vs || !fs) { canvas.hidden=true; return; }
  const program=gl.createProgram(); gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
  gl.deleteShader(vs);gl.deleteShader(fs);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) { canvas.hidden=true;return; }
  gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  const uniforms=Object.fromEntries(['resolution','time','darkMode','ripples[0]'].map(n=>[n,gl.getUniformLocation(program,n)]));
  const ripples=new Float32Array(18);for(let i=0;i<6;i++)ripples[i*3+2]=-20;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0,last=0,time=0,slot=0,lastRipple=-1,lost=false;
  const active=()=>!lost&&!document.hidden&&!reduced.matches&&!document.documentElement.classList.contains('background-paused');
  function draw(){
    gl.uniform2f(uniforms.resolution,canvas.width,canvas.height);
    gl.uniform1f(uniforms.darkMode,document.documentElement.dataset.colorScheme === 'dark' ? 1 : 0);
    gl.uniform1f(uniforms.time,time);gl.uniform3fv(uniforms['ripples[0]'],ripples);
    gl.drawArrays(gl.TRIANGLES,0,6);
  }
  function resize(){
    const scale=Math.min(1,850/Math.max(innerWidth,innerHeight));
    canvas.width=Math.max(1,Math.round(innerWidth*scale));canvas.height=Math.max(1,Math.round(innerHeight*scale));
    gl.viewport(0,0,canvas.width,canvas.height);if(!lost)draw();
  }
  function tick(now){
    if(!active()){frame=0;return;}
    if(!last)last=now;
    if(now-last>=1000/24){time+=Math.min((now-last)/1000,.1);last=now;draw();}
    frame=requestAnimationFrame(tick);
  }
  function sync(){cancelAnimationFrame(frame);frame=0;last=0;if(active())frame=requestAnimationFrame(tick);}
  window.addEventListener('pointerdown',e=>{
    if(!active()||e.button!==0||time-lastRipple<.08||e.target.closest('button,a,input,select,textarea,.card,nav'))return;
    const size=Math.min(innerWidth,innerHeight);
    ripples[slot*3]=e.clientX/size;ripples[slot*3+1]=(innerHeight-e.clientY)/size;ripples[slot*3+2]=time;
    slot=(slot+1)%6;lastRipple=time;
  },{passive:true});
  new MutationObserver(()=>{draw();sync();}).observe(document.documentElement,{attributes:true,attributeFilter:['class','data-color-scheme']});
  document.addEventListener('visibilitychange',sync);reduced.addEventListener('change',sync);
  window.addEventListener('resize',resize);
  canvas.addEventListener('webglcontextlost',()=>{lost=true;canvas.hidden=true;sync();});
  resize();sync();
})();

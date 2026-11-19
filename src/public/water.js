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
    uniform float night;
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
      float calm=exp(-dot((uv-vec2(.5,.52))*vec2(2.,3.),(uv-vec2(.5,.52))*vec2(2.,3.)));
      if(night>.5){
        // The same moving water catches a narrow, broken path of moonlight.
        // 深色下焦散压得比亮色低一档：整片网纹原来偏亮，亮点只留给月光带。
        float moonPath=exp(-pow((uv.x-.64+uv.y*.08+sin(uv.y*8.+time*.12)*.018)/(.14+uv.y*.16),2.));
        float glint=pow(clamp(a*.65+b*.35,0.,1.),2.2);
        float sparkle=pow(glint,2.)*(.6+.4*sin(q.x*8.+q.y*6.+time*.9));
        vec3 darkWater=mix(vec3(.055,.061,.073),vec3(.11,.12,.14),.28+uv.y*.23+swell*.16);
        darkWater+=vec3(.10,.11,.12)*light*(.22+moonPath*.78);
        darkWater+=vec3(.30,.32,.34)*glint*moonPath*.9;
        darkWater+=vec3(.16,.17,.18)*sparkle*moonPath;
        darkWater+=vec3(.12,.13,.15)*rings;
        darkWater=mix(darkWater,vec3(.08,.085,.098),calm*.18);
        gl_FragColor=vec4(darkWater,1.);
        return;
      }
      vec3 deep=vec3(.77,.86,.94),shallow=vec3(.89,.96,.98);
      vec3 color=mix(deep,shallow,.35+uv.y*.25+swell*.15);
      color+=vec3(.085,.075,.055)*light;
      color+=rings;
      // A broad quiet area behind the controls keeps the water unobtrusive.
      color=mix(color,vec3(.91,.95,.99),calm*.35);
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
  const uniforms=Object.fromEntries(['resolution','time','night','ripples[0]'].map(n=>[n,gl.getUniformLocation(program,n)]));
  const ripples=new Float32Array(18);for(let i=0;i<6;i++)ripples[i*3+2]=-20;
  const shared=globalThis.launcherMotion;
  const reduced=shared?null:matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0,last=0,time=0,slot=0,lastRipple=-1,lost=false;
  const active=()=>!lost&&!document.hidden
    &&(shared?.reduced?!shared.reduced():(!reduced.matches&&!document.documentElement.classList.contains('reduce-motion')&&document.documentElement.dataset.reduceMotion!=='true'))
    &&!document.documentElement.classList.contains('launcher-idle')
    &&!document.documentElement.classList.contains('background-hidden')&&!document.documentElement.classList.contains('internal-dsh-active');
  function draw(){
    gl.uniform2f(uniforms.resolution,canvas.width,canvas.height);
    gl.uniform1f(uniforms.time,time);
    gl.uniform1f(uniforms.night,document.documentElement.dataset.colorScheme==='dark'?1:0);
    gl.uniform3fv(uniforms['ripples[0]'],ripples);
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
  function sync(){cancelAnimationFrame(frame);frame=0;last=0;if(!lost)draw();if(active())frame=requestAnimationFrame(tick);}
  window.addEventListener('pointerdown',e=>{
    if(!active()||e.button!==0||time-lastRipple<.08||e.target.closest('button,a,input,select,textarea,.card,nav'))return;
    const size=Math.min(innerWidth,innerHeight);
    ripples[slot*3]=e.clientX/size;ripples[slot*3+1]=(innerHeight-e.clientY)/size;ripples[slot*3+2]=time;
    slot=(slot+1)%6;lastRipple=time;
  },{passive:true});
  new MutationObserver(sync).observe(document.documentElement,{attributes:true,attributeFilter:['class','data-color-scheme']});
  document.addEventListener('visibilitychange',sync);if(shared?.onReduceChange)shared.onReduceChange(sync);else reduced.addEventListener('change',sync);
  window.addEventListener('resize',resize);
  canvas.addEventListener('webglcontextlost',()=>{lost=true;canvas.hidden=true;sync();});
  resize();sync();
})();

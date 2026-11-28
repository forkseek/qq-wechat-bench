// 讯课 · 手绘卡通 3D 扭蛋机（three.js）
// 画风：卡通分档明暗 + 粗黑描边（呼应讯课手账的粗框），玻璃罩用边缘光 + 手画高光，不用昂贵的透射玻璃。
// 只在有动静时渲染：拧旋钮、球在滚、胶囊在动、鼠标悬停视差；静止时一帧都不画。

import * as THREE from 'three';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';

const INK = '#23211e';
const PAPER = '#fffdf5';
const BODY = '#fb9fb4';
const BODY_DEEP = '#f27c97';
const BUTTER = '#fde047';

// 机身尺寸（1 单位约 10 cm）
const DOME_C = new THREE.Vector3(0, 2.37, 0);
const DOME_R = 1.0;
const FLOOR_Y = 1.645; // 略高于黄色领圈顶面（1.63），不然领圈会把球的下半截盖住
const BALL_R = 0.235;
// 掉出来的胶囊比罩子里的球大一号：这是主角，得一眼看见
const CAP_R = 0.3;
const GRAVITY = 14;
// 半壳（球壳 + 一片圆盖）的重心离球心多远（× 半径）；在球心和圆顶之间，所以圆顶朝下时像不倒翁
const SHELL_COM = 0.4;

const NO_OUTLINE = { visible: false };

function toonGradient() {
  const tex = new THREE.DataTexture(new Uint8Array([120, 200, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeOutBack(t) {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export class GachaScene {
  /**
   * @param {HTMLElement} host 放 canvas 的容器
   * @param {object} hooks { onTurned, onCapsuleClick, onTick, onImpact, onDropLand }
   */
  constructor(host, hooks = {}) {
    this.host = host;
    this.hooks = hooks;
    this.reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 创建失败（没有 WebGL）会直接抛错，由外面退回 CSS 版
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'gacha3d-canvas';
    host.appendChild(this.canvas);

    this.effect = new OutlineEffect(this.renderer, {
      // 描边加粗一点，跟页面上卡片的粗黑框是一个分量
      defaultThickness: 0.0145,
      defaultColor: new THREE.Color(INK).toArray(),
      defaultAlpha: 1,
      defaultKeepAlive: true
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(26, 1, 0.1, 60);
    this.camTarget = new THREE.Vector3(0, 1.56, 0.3);

    this.gradient = toonGradient();
    this.disposables = [this.gradient];

    this.toon = color => {
      const m = new THREE.MeshToonMaterial({ color, gradientMap: this.gradient });
      this.disposables.push(m);
      return m;
    };

    this._lights();
    this.rig = new THREE.Group(); // 整台机器，用来做悬停视差和抖动
    this.scene.add(this.rig);
    this._buildMachine();
    this._buildCapsule();

    this.balls = [];
    this.ballGeoTop = new THREE.SphereGeometry(BALL_R, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2);
    this.ballGeoBottom = new THREE.SphereGeometry(BALL_R, 28, 14, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    // 罩子里的也是小胶囊：同样的波点、彩带和咬合凸边
    this.ballSeamGeo = new THREE.TorusGeometry(BALL_R * 1.0, BALL_R * 0.075, 6, 36);
    this.seamMat = this.toon('#fffaf0');
    this.disposables.push(this.ballGeoTop, this.ballGeoBottom, this.ballSeamGeo);
    this.ballMats = new Map();

    // 交互 / 动画状态
    this.knobAngle = 0;       // 累计顺时针转角
    this.turnBase = 0;        // 这一轮开始时的转角
    this.lastNotch = 0;
    this.knobSpeed = 0;       // rad/s，用来带动球
    this.dragging = null;
    this.autoSpin = null;
    this.tweens = [];
    this.locked = false;      // 胶囊出来后到重置前不能再转
    this.parallax = { x: 0, y: 0, tx: 0, ty: 0 };
    this.shake = 0;
    this.tilt = 0;            // 入场时机身歪一下
    this.intro = false;       // 入场动画播放中
    this.physicsCalm = 0;
    this.running = false;
    this.visible = true;
    this.lastTime = 0;
    this.lastImpactAt = 0;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._bindEvents();
    this.resize();
    this.render();  }

  // ---------------------------------------------------------------- 场景搭建

  _lights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-3.2, 5.5, 4.5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xfff1e0, 0.35);
    fill.position.set(4, 1, 3);
    this.scene.add(fill);
  }

  _lathe(points, mat, segments = 56) {
    const geo = new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segments);
    this.disposables.push(geo);
    return new THREE.Mesh(geo, mat);
  }

  _buildMachine() {
    const rig = this.rig;

    // 偏右下的硬影子：呼应讯课卡片右下角的粗黑投影
    const shadowGeo = new THREE.CircleGeometry(1.25, 48);
    const shadowMat = new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.9, depthWrite: false });
    shadowMat.userData.outlineParameters = NO_OUTLINE;
    this.disposables.push(shadowGeo, shadowMat);
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    // 以前影子比机身大一圈、又往右偏很多，看着像地上一个黑洞；收紧成贴着脚底的一小片
    shadow.scale.set(0.96, 0.6, 1);
    shadow.position.set(0.16, 0.002, 0.08);
    shadow.renderOrder = -2;
    this.scene.add(shadow);
    this.shadow = shadow;

    // 四只小脚
    const footGeo = new THREE.SphereGeometry(0.17, 20, 12);
    this.disposables.push(footGeo);
    const footMat = this.toon(BODY_DEEP);
    for (const [x, z] of [[-0.62, -0.55], [0.62, -0.55], [-0.62, 0.55], [0.62, 0.55]]) {
      const f = new THREE.Mesh(footGeo, footMat);
      f.scale.set(1, 0.62, 1);
      f.position.set(x, 0.12, z);
      rig.add(f);
    }

    // 圆滚滚的机身
    const body = this._lathe(
      [[0, 0.12], [0.72, 0.12], [0.95, 0.18], [1.08, 0.34], [1.13, 0.62], [1.14, 0.95], [1.11, 1.24], [1.02, 1.42], [0.9, 1.48], [0, 1.48]],
      this.toon(BODY)
    );
    rig.add(body);

    // 黄色领圈
    const collar = this._lathe(
      [[0, 1.44], [0.97, 1.44], [1.04, 1.48], [1.06, 1.55], [1.03, 1.61], [0.96, 1.63], [0, 1.63]],
      this.toon(BUTTER)
    );
    rig.add(collar);

    // 领圈上一圈小铆钉（像手账贴纸上的圆点花边）
    const rivetGeo = new THREE.SphereGeometry(0.045, 12, 8);
    this.disposables.push(rivetGeo);
    const rivetMat = this.toon(PAPER);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.11;
      const rv = new THREE.Mesh(rivetGeo, rivetMat);
      rv.position.set(Math.sin(a) * 1.055, 1.535, Math.cos(a) * 1.055);
      rv.scale.set(1, 1, 0.7);
      rv.lookAt(rv.position.x * 2, rv.position.y, rv.position.z * 2);
      rig.add(rv);
    }

    // 罩子里的“地板”（球落在上面）
    const floorGeo = new THREE.CircleGeometry(0.95, 48);
    const floorMat = this.toon('#fde7ee');
    floorMat.userData.outlineParameters = NO_OUTLINE;
    this.disposables.push(floorGeo);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y + 0.002;
    rig.add(floor);

    // 玻璃罩：边缘光 + 手画高光，外圈黑描边用模板缓冲画成一圈（不然描边会把罩子里面涂黑）
    const thetaLen = Math.acos((FLOOR_Y - DOME_C.y) / DOME_R);
    const domeGeo = new THREE.SphereGeometry(DOME_R, 64, 40, 0, Math.PI * 2, 0, thetaLen);
    const rimGeo = new THREE.SphereGeometry(DOME_R * 1.035, 64, 40, 0, Math.PI * 2, 0, thetaLen);
    this.disposables.push(domeGeo, rimGeo);

    const maskMat = new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: false,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp
    });
    maskMat.userData.outlineParameters = NO_OUTLINE;
    const mask = new THREE.Mesh(domeGeo, maskMat);
    mask.position.copy(DOME_C);
    mask.renderOrder = 1;

    const rimMat = new THREE.MeshBasicMaterial({
      color: INK, side: THREE.BackSide, depthWrite: false,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc
    });
    rimMat.userData.outlineParameters = NO_OUTLINE;
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.copy(DOME_C);
    rim.renderOrder = 2;

    const glassMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { tint: { value: new THREE.Color('#bfe3fb') } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 tint; varying vec3 vN; varying vec3 vV;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
          float a = 0.14 + 0.5 * smoothstep(0.2, 1.0, f);
          gl_FragColor = vec4(tint, a);
          #include <colorspace_fragment>
        }`
    });
    glassMat.userData.outlineParameters = NO_OUTLINE;
    this.disposables.push(maskMat, rimMat, glassMat);
    const glass = new THREE.Mesh(domeGeo, glassMat);
    glass.position.copy(DOME_C);
    glass.renderOrder = 3;
    rig.add(mask, rim, glass);

    // 高光：一条弯弯的长条 + 一个小点
    const hiMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.92, depthWrite: false });
    hiMat.userData.outlineParameters = NO_OUTLINE;
    const stripeGeo = new THREE.SphereGeometry(DOME_R * 1.004, 24, 16, 0.5, 0.26, 0.38, 0.78);
    const dotGeo = new THREE.SphereGeometry(DOME_R * 1.004, 12, 8, 0.9, 0.13, 0.36, 0.13);
    this.disposables.push(hiMat, stripeGeo, dotGeo);
    this.glints = [];
    for (const g of [stripeGeo, dotGeo]) {
      const h = new THREE.Mesh(g, hiMat);
      h.position.copy(DOME_C);
      h.renderOrder = 4;
      rig.add(h);
      this.glints.push(h);
    }

    // 顶上的小黄帽
    const cap = this._lathe(
      [[0, DOME_C.y + 0.97], [0.24, DOME_C.y + 0.97], [0.27, DOME_C.y + 1.02], [0.25, DOME_C.y + 1.1], [0.14, DOME_C.y + 1.15], [0, DOME_C.y + 1.16]],
      this.toon(BUTTER), 40
    );
    rig.add(cap);
    const bobGeo = new THREE.SphereGeometry(0.1, 20, 12);
    this.disposables.push(bobGeo);
    const bob = new THREE.Mesh(bobGeo, this.toon(BODY));
    bob.position.set(0, DOME_C.y + 1.22, 0);
    rig.add(bob);
    this.bob = bob;

    // 入场时在罩子旁边蹦出来的手账小星星（平时藏着）；挤出一点厚度，粗描边才画得出来
    const star = new THREE.Shape();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 2;
      const b = a + Math.PI / 4;
      const c = a + Math.PI / 2;
      if (i === 0) star.moveTo(Math.cos(a), Math.sin(a));
      star.quadraticCurveTo(Math.cos(b) * 0.22, Math.sin(b) * 0.22, Math.cos(c), Math.sin(c));
    }
    const starGeo = new THREE.ExtrudeGeometry(star, { depth: 0.12, bevelEnabled: false, curveSegments: 8 });
    starGeo.center();
    this.disposables.push(starGeo);
    const starMat = this.toon(BUTTER);
    this.stars = [
      [-0.88, 0.82, 0.38, 0.17],
      [1.06, 0.4, 0.3, 0.13],
      [0.6, 1.02, 0.28, 0.1]
    ].map(([x, y, z, size]) => {
      const m = new THREE.Mesh(starGeo, starMat);
      m.position.set(DOME_C.x + x, DOME_C.y + y, DOME_C.z + z);
      m.userData.size = size;
      m.visible = false;
      rig.add(m);
      return m;
    });

    // 腰上绕一圈的手账贴纸：波浪花边 + 缝线 + 星星，正中是「必做 × N」
    this.plateCanvas = document.createElement('canvas');
    this.plateCanvas.width = 4096;
    this.plateCanvas.height = 160;
    this.plateTex = new THREE.CanvasTexture(this.plateCanvas);
    this.plateTex.colorSpace = THREE.SRGBColorSpace;
    this.plateTex.anisotropy = 4;
    // thetaStart = -π：贴纸展开图的正中间（u = 0.5）正对镜头
    const plateGeo = new THREE.CylinderGeometry(1.092, 1.152, 0.3, 96, 1, true, -Math.PI, Math.PI * 2);
    const plateMat = new THREE.MeshBasicMaterial({ map: this.plateTex, transparent: true, alphaTest: 0.5 });
    plateMat.userData.outlineParameters = NO_OUTLINE;
    this.disposables.push(this.plateTex, plateGeo, plateMat);
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.y = 1.18;
    rig.add(plate);
    this._drawPlate(0);

    // 出口 + 托盘（朝向机身左前方的法线）
    const chute = new THREE.Group();
    const chuteAngle = -0.42;
    chute.position.set(Math.sin(chuteAngle) * 1.06, 0.66, Math.cos(chuteAngle) * 1.06);
    chute.rotation.y = chuteAngle;
    rig.add(chute);
    this.chute = chute;

    const holeGeo = new THREE.ExtrudeGeometry(roundedRectShape(0.74, 0.6, 0.18), { depth: 0.14, bevelEnabled: false, curveSegments: 10 });
    const holeMat = new THREE.MeshBasicMaterial({ color: INK });
    holeMat.userData.outlineParameters = NO_OUTLINE;
    this.disposables.push(holeGeo, holeMat);
    const hole = new THREE.Mesh(holeGeo, holeMat);
    hole.position.set(0, 0.02, -0.06);
    chute.add(hole);

    const lipGeo = new THREE.TorusGeometry(0.35, 0.045, 10, 40, Math.PI);
    this.disposables.push(lipGeo);
    const lip = new THREE.Mesh(lipGeo, this.toon(BUTTER));
    lip.position.set(0, 0.04, 0.09);
    lip.scale.set(1.08, 0.86, 1);
    chute.add(lip);

    // 出口小门帘：上沿是合页，胶囊冲出来时被顶开，再晃几下荡回去
    const flapPivot = new THREE.Group();
    flapPivot.position.set(0, 0.3, 0.075);
    chute.add(flapPivot);
    const flapGeo = new THREE.ExtrudeGeometry(roundedRectShape(0.62, 0.5, 0.12), { depth: 0.035, bevelEnabled: false, curveSegments: 8 });
    const knobBarGeo = new THREE.CapsuleGeometry(0.035, 0.18, 4, 10);
    this.disposables.push(flapGeo, knobBarGeo);
    const flap = new THREE.Mesh(flapGeo, this.toon('#ffe4ec'));
    flap.position.set(0, -0.25, -0.0175);
    const flapBar = new THREE.Mesh(knobBarGeo, this.toon(BODY_DEEP));
    flapBar.rotation.z = Math.PI / 2;
    flapBar.position.set(0, -0.4, 0.03);
    flapPivot.add(flap, flapBar);
    this.flap = { pivot: flapPivot, angle: 0, vel: 0 };

    // 托盘用纸白：以前是黄色，抽到黄球（今天截止）时胶囊和托盘、出口黄边糊成一片，根本看不出掉了东西
    // 托盘往后伸到出口底下，和机身连成一体（只往前挪会像一只飘在外面的碟子）
    const trayShape = roundedRectShape(0.94, 1.04, 0.22);
    const trayGeo = new THREE.ExtrudeGeometry(trayShape, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 4, curveSegments: 12 });
    this.disposables.push(trayGeo);
    const tray = new THREE.Mesh(trayGeo, this.toon(PAPER));
    tray.rotation.x = -Math.PI / 2;
    tray.position.set(0, -0.5, 0.32);
    chute.add(tray);
    this.trayTopY = -0.5 + 0.1 + 0.03; // chute 局部坐标

    // 托盘一圈矮围边：拆开的半壳和纸屑会撞在上面弹回来（物理碰撞感的来源）
    const rimOuter = roundedRectShape(0.94, 1.04, 0.22);
    rimOuter.holes.push(roundedRectShape(0.78, 0.88, 0.15));
    const trayRimGeo = new THREE.ExtrudeGeometry(rimOuter, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 3, curveSegments: 12 });
    this.disposables.push(trayRimGeo);
    const trayRim = new THREE.Mesh(trayRimGeo, this.toon(BUTTER));
    trayRim.rotation.x = -Math.PI / 2;
    trayRim.position.set(0, this.trayTopY - 0.01, 0.32);
    chute.add(trayRim);
    // 围边里面能活动的范围（chute 局部坐标，留出围边厚度）
    this.trayInner = { xMin: -0.39, xMax: 0.39, zMin: 0.32 - 0.44, zMax: 0.32 + 0.44 };
    this.trayFrontZ = this.trayInner.zMax;

    // 旋钮（朝向机身右前方）
    const knobAngle = 0.4;
    const knob = new THREE.Group();
    knob.position.set(Math.sin(knobAngle) * 1.1, 0.72, Math.cos(knobAngle) * 1.1);
    knob.rotation.y = knobAngle;
    rig.add(knob);
    const knobSpin = new THREE.Group();
    knob.add(knobSpin);
    this.knob = knob;
    this.knobSpin = knobSpin;

    // 花瓣形旋钮：六瓣波浪边，比光秃秃的圆盘可爱，也更像「能拧」的东西
    const petal = new THREE.Shape();
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const rr = 0.33 + 0.045 * Math.cos(a * 6);
      if (i === 0) petal.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else petal.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    const discGeo = new THREE.ExtrudeGeometry(petal, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 3, curveSegments: 4 });
    const handleGeo = new THREE.CapsuleGeometry(0.085, 0.5, 6, 16);
    const hubGeo = new THREE.SphereGeometry(0.09, 16, 10);
    this.disposables.push(discGeo, handleGeo, hubGeo);
    const disc = new THREE.Mesh(discGeo, this.toon(BUTTER));
    disc.position.z = -0.03;
    const handle = new THREE.Mesh(handleGeo, this.toon(PAPER));
    handle.rotation.z = Math.PI / 2;
    handle.position.z = 0.16;
    const hub = new THREE.Mesh(hubGeo, this.toon(BODY_DEEP));
    hub.position.set(0.22, 0, 0.24);
    knobSpin.add(disc, handle, hub);
    this.knobMeshes = [disc, handle, hub];
  }

  // 胶囊花纹：上半个是彩色 + 浅色波点，下半个是奶油白 + 一圈同色彩带。按颜色缓存，罩子里的球和掉出来的胶囊共用
  _capTextures(color) {
    if (!this.capTex) this.capTex = new Map();
    if (this.capTex.has(color)) return this.capTex.get(color);
    const base = new THREE.Color(color);
    const light = base.clone().lerp(new THREE.Color('#ffffff'), 0.68).getStyle();
    const deep = base.clone().lerp(new THREE.Color(INK), 0.16).getStyle();
    const make = draw => {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 128;
      draw(c.getContext('2d'), c.width, c.height);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.disposables.push(t);
      return t;
    };
    // 半球的贴图：画布顶边 = 极点（上半个）/ 赤道（下半个），一行越靠近极点一圈越短，所以点要横向拉宽才是圆的
    const top = make((g, w, h) => {
      g.fillStyle = color;
      g.fillRect(0, 0, w, h);
      g.fillStyle = light;
      [[0.36, 4, 0], [0.6, 6, 0.5], [0.83, 8, 0.25]].forEach(([t, n, shift]) => {
        const ry = h * 0.07;
        const rx = Math.min(w / n / 2.4, ry / (2 * Math.sin((t * Math.PI) / 2)) * (w / h) / 2);
        for (let i = 0; i < n; i++) {
          const x = ((i + shift) / n) * w;
          for (const dx of [0, -w, w]) {
            g.beginPath();
            g.ellipse(x + dx, t * h, rx, ry, 0, 0, Math.PI * 2);
            g.fill();
          }
        }
      });
      g.fillStyle = deep;
      g.fillRect(0, h * 0.94, w, h * 0.06);
    });
    const bottom = make((g, w, h) => {
      g.fillStyle = '#fffaf0';
      g.fillRect(0, 0, w, h);
      g.fillStyle = color;
      g.fillRect(0, h * 0.12, w, h * 0.14);
      g.fillStyle = light;
      g.fillRect(0, h * 0.32, w, h * 0.05);
    });
    const pair = { top, bottom };
    this.capTex.set(color, pair);
    return pair;
  }

  _toonMap(map) {
    const m = new THREE.MeshToonMaterial({ color: '#ffffff', map, gradientMap: this.gradient });
    this.disposables.push(m);
    return m;
  }

  _buildCapsule() {
    const r = CAP_R;
    const topGeo = new THREE.SphereGeometry(r, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2);
    const botGeo = new THREE.SphereGeometry(r, 40, 20, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const lidGeo = new THREE.CircleGeometry(r * 0.995, 40);
    const lipGeo = new THREE.TorusGeometry(r * 1.0, r * 0.075, 8, 48);
    const rollGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.44, 20);
    const ribbonGeo = new THREE.TorusGeometry(0.104, 0.022, 6, 24);
    // 上半个的高光：一条弯弯的白条 + 一个小点（和玻璃罩的高光同一个画法）
    const glossGeo = new THREE.SphereGeometry(r * 1.012, 16, 8, 0.55, 0.55, 0.3, 0.42);
    const glossDotGeo = new THREE.SphereGeometry(r * 1.012, 8, 6, 1.22, 0.17, 0.3, 0.13);
    this.disposables.push(topGeo, botGeo, lidGeo, lipGeo, rollGeo, ribbonGeo, glossGeo, glossDotGeo);

    const tex = this._capTextures('#fda4af');
    this.capTopMat = this._toonMap(tex.top);
    this.capBotMat = this._toonMap(tex.bottom);
    const inside = this.toon('#fff7ea');
    inside.side = THREE.DoubleSide;
    inside.userData.outlineParameters = NO_OUTLINE;
    const gloss = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    gloss.userData.outlineParameters = NO_OUTLINE;
    this.disposables.push(gloss);

    const cap = new THREE.Group();
    const top = new THREE.Group();
    const topShell = new THREE.Mesh(topGeo, this.capTopMat);
    const topLid = new THREE.Mesh(lidGeo, inside);
    topLid.rotation.x = Math.PI / 2;
    top.add(topShell, topLid, new THREE.Mesh(glossGeo, gloss), new THREE.Mesh(glossDotGeo, gloss));

    const bottom = new THREE.Group();
    const botShell = new THREE.Mesh(botGeo, this.capBotMat);
    const botLid = new THREE.Mesh(lidGeo, inside);
    botLid.rotation.x = -Math.PI / 2;
    // 两半咬合处的凸边（下半个的口沿），描边一勾就是手绘胶囊的样子
    const lip = new THREE.Mesh(lipGeo, this.toon('#fffaf0'));
    lip.rotation.x = Math.PI / 2;
    const roll = new THREE.Group();
    const paper = new THREE.Mesh(rollGeo, this.toon('#fff1b8'));
    const ribbon = new THREE.Mesh(ribbonGeo, this.toon('#fb7185'));
    ribbon.rotation.x = Math.PI / 2;
    roll.add(paper, ribbon);
    roll.rotation.z = Math.PI / 2;
    roll.position.y = 0.02;
    roll.scale.set(1, 1, 0.01);
    bottom.add(botShell, botLid, lip, roll);

    cap.add(top, bottom);
    // holder 管位置和落地压扁（不跟着滚动转），cap 管滚动和摇摆
    const holder = new THREE.Group();
    holder.add(cap);
    holder.visible = false;
    this.chute.add(holder);
    this.capsule = { holder, group: cap, top, bottom, lip, roll, shells: [topShell, botShell], state: 'none' };
    this.confetti = [];
  }

  _drawPlate(count) {
    const c = this.plateCanvas;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    // 圆柱一圈比贴纸高宽得多：横向 1 像素比纵向 1 像素「宽」，画图案时横向放大来抵消，别画成扁的
    const sx = (W / (Math.PI * 2 * 1.12)) / (H / 0.3);
    g.clearRect(0, 0, W, H);

    // 波浪花边的纸带
    const top = 20;
    const bot = H - 20;
    const wave = 64;
    const amp = 9;
    g.beginPath();
    g.moveTo(0, top);
    for (let x = 0; x <= W; x += wave) {
      g.quadraticCurveTo(x + wave / 2, top - amp, x + wave, top);
    }
    g.lineTo(W, bot);
    for (let x = W; x >= 0; x -= wave) {
      g.quadraticCurveTo(x - wave / 2, bot + amp, x - wave, bot);
    }
    g.closePath();
    g.fillStyle = PAPER;
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = INK;
    g.stroke();

    // 缝线
    g.setLineDash([22, 16]);
    g.lineWidth = 4;
    g.strokeStyle = BODY_DEEP;
    for (const y of [top + 16, bot - 16]) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    g.setLineDash([]);

    const star = (cx, cy, rr, fill) => {
      g.save();
      g.translate(cx, cy);
      g.scale(sx, 1);
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 ? rr * 0.45 : rr;
        g.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.lineWidth = 4;
      g.lineJoin = 'round';
      g.strokeStyle = INK;
      g.stroke();
      g.restore();
    };
    const text = (str, cx, cy, size, color = INK) => {
      g.save();
      g.translate(cx, cy);
      g.scale(sx, 1);
      g.fillStyle = color;
      g.font = `bold ${size}px "YouYuan", "Microsoft YaHei UI", "PingFang SC", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(str, 0, 2);
      g.restore();
    };

    // 两侧和背面：小字 + 星星
    const mid = H / 2;
    const deco = ['#fde047', '#7dd3fc', '#fda4af', '#86efac'];
    for (let i = 0; i < 8; i++) {
      const x = (i + 0.5) * (W / 8);
      if (Math.abs(x - W / 2) < W * 0.12) continue; // 正中留给「必做 × N」
      if (i % 2) text('讯课扭蛋', x, mid, 48, '#8a7f72');
      else star(x, mid, 26, deco[(i / 2) % deco.length]);
    }

    // 正中：黄底胶囊签「必做 × N」，两边各一颗星
    const pw = 360 * sx;
    const ph = 92;
    const px = W / 2 - pw / 2;
    const py = mid - ph / 2;
    const pr = ph / 2;
    g.beginPath();
    g.moveTo(px + pr, py);
    g.arcTo(px + pw, py, px + pw, py + ph, pr);
    g.arcTo(px + pw, py + ph, px, py + ph, pr);
    g.arcTo(px, py + ph, px, py, pr);
    g.arcTo(px, py, px + pw, py, pr);
    g.closePath();
    g.fillStyle = BUTTER;
    g.fill();
    g.lineWidth = 7;
    g.strokeStyle = INK;
    g.stroke();
    text(`必做 × ${count}`, W / 2, mid, 60);
    star(W / 2 - pw / 2 - 52 * sx, mid, 22, '#fda4af');
    star(W / 2 + pw / 2 + 52 * sx, mid, 22, '#7dd3fc');
    this.plateTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- 球

  _ballMat(color) {
    if (!this.ballMats.has(color)) this.ballMats.set(color, this._toonMap(this._capTextures(color).top));
    return this.ballMats.get(color);
  }

  // 下半个奶油白 + 同色彩带
  _ballTint(color) {
    const key = `tint:${color}`;
    if (!this.ballMats.has(key)) this.ballMats.set(key, this._toonMap(this._capTextures(color).bottom));
    return this.ballMats.get(key);
  }

  /** @param {{id:string,color:string}[]} list */
  setBalls(list) {
    const keep = new Map(this.balls.map(b => [b.id, b]));
    const next = [];
    for (const item of list.slice(0, 16)) {
      let b = keep.get(item.id);
      if (b) {
        keep.delete(item.id);
        b.top.material = this._ballMat(item.color);
        b.bottom.material = this._ballTint(item.color);
        b.color = item.color;
      } else {
        b = this._makeBall(item);
      }
      next.push(b);
    }
    for (const b of keep.values()) this.rig.remove(b.group);
    const fresh = next.filter(b => !this.balls.includes(b));
    this.balls = next;
    this._drawPlate(list.length);
    if (fresh.length) {
      fresh.forEach((b, i) => this._placeBall(b, i));
      this._settle(260);
    }
    this.requestRender();
  }

  _makeBall(item) {
    const group = new THREE.Group();
    const top = new THREE.Mesh(this.ballGeoTop, this._ballMat(item.color));
    const bottom = new THREE.Mesh(this.ballGeoBottom, this._ballTint(item.color));
    const seam = new THREE.Mesh(this.ballSeamGeo, this.seamMat);
    seam.rotation.x = Math.PI / 2;
    group.add(top, bottom, seam);
    group.quaternion.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    this.rig.add(group);
    return {
      id: item.id, color: item.color, group, top, bottom,
      p: new THREE.Vector3(), v: new THREE.Vector3(),
      hidden: false, scale: 1
    };
  }

  _placeBall(b, i) {
    const ring = i % 6;
    const layer = Math.floor(i / 6);
    const a = (ring / 6) * Math.PI * 2 + layer * 0.5;
    const rr = layer === 0 ? 0.5 : 0.3;
    b.p.set(Math.cos(a) * rr, FLOOR_Y + BALL_R + 0.05 + layer * 0.4, Math.sin(a) * rr);
    b.v.set(0, 0, 0);
  }

  _settle(steps) {
    const quiet = this.hooks.onImpact;
    this.hooks.onImpact = null;
    for (let i = 0; i < steps; i++) this._physics(1 / 120);
    this.hooks.onImpact = quiet;
    this._syncBalls(0);
  }

  _impact(strength) {
    if (!this.hooks.onImpact || strength < 0.12) return;
    const now = performance.now();
    if (now - this.lastImpactAt < 28) return;
    this.lastImpactAt = now;
    this.hooks.onImpact(Math.min(1, strength));
  }

  _physics(dt) {
    const balls = this.balls.filter(b => !b.hidden);
    const swirl = Math.min(Math.abs(this.knobSpeed), 14);
    const tmp = new THREE.Vector3();
    for (const b of balls) {
      b.v.y -= GRAVITY * dt;
      if (swirl > 0.2) {
        // 拧旋钮时罩子里刮起一阵旋风，地上的球被掀起来
        const rx = b.p.x - DOME_C.x;
        const rz = b.p.z - DOME_C.z;
        const len = Math.hypot(rx, rz) || 1;
        // 以前旋风太弱，转一圈球只是挪了挪；现在要看得出「哗啦啦翻起来」
        b.v.x += (-rz / len) * swirl * 1.7 * dt;
        b.v.z += (rx / len) * swirl * 1.7 * dt;
        if (b.p.y < FLOOR_Y + BALL_R + 0.06 && Math.random() < swirl * 0.05) {
          b.v.y += 1.8 + Math.random() * swirl * 0.36;
          b.v.x += (Math.random() - 0.5) * 1.6;
          b.v.z += (Math.random() - 0.5) * 1.6;
        }
      }
      b.v.multiplyScalar(1 - 0.35 * dt);
      b.p.addScaledVector(b.v, dt);
    }

    for (let iter = 0; iter < 3; iter++) {
      // 球和球
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          const a = balls[i];
          const c = balls[j];
          tmp.subVectors(c.p, a.p);
          const d = tmp.length();
          const min = BALL_R * 2;
          if (d > 0 && d < min) {
            tmp.divideScalar(d);
            const push = (min - d) / 2;
            a.p.addScaledVector(tmp, -push);
            c.p.addScaledVector(tmp, push);
            const rel = c.v.clone().sub(a.v).dot(tmp);
            if (rel < 0) {
              const imp = -(1 + 0.45) * rel / 2;
              a.v.addScaledVector(tmp, -imp);
              c.v.addScaledVector(tmp, imp);
              if (iter === 0) this._impact(-rel / 5);
            }
          }
        }
      }
      // 罩子和地板
      for (const b of balls) {
        tmp.subVectors(b.p, DOME_C);
        const d = tmp.length();
        const max = DOME_R - BALL_R - 0.03;
        if (d > max) {
          tmp.divideScalar(d);
          b.p.copy(DOME_C).addScaledVector(tmp, max);
          const vn = b.v.dot(tmp);
          if (vn > 0) {
            b.v.addScaledVector(tmp, -(1 + 0.4) * vn);
            b.v.multiplyScalar(0.97);
            if (iter === 0) this._impact(vn / 5);
          }
        }
        const fy = FLOOR_Y + BALL_R;
        if (b.p.y < fy) {
          b.p.y = fy;
          if (b.v.y < 0) {
            if (iter === 0) this._impact(-b.v.y / 6);
            b.v.y *= -0.38;
            b.v.x *= 0.9;
            b.v.z *= 0.9;
          }
        }
      }
    }
  }

  _syncBalls(dt) {
    const axis = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (const b of this.balls) {
      b.group.position.copy(b.p);
      if (dt > 0) {
        const speed = Math.hypot(b.v.x, b.v.z);
        if (speed > 0.01) {
          axis.set(b.v.z, 0, -b.v.x).normalize();
          q.setFromAxisAngle(axis, (speed / BALL_R) * dt);
          b.group.quaternion.premultiply(q);
        }
      }
      b.group.scale.setScalar(b.scale);
      b.group.visible = b.scale > 0.01;
    }
  }

  _energy() {
    let e = 0;
    for (const b of this.balls) if (!b.hidden) e += b.v.lengthSq();
    return e;
  }

  // ---------------------------------------------------------------- 旋钮

  _knobCenterScreen() {
    const v = new THREE.Vector3();
    this.knob.getWorldPosition(v);
    v.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
  }

  _setKnobAngle(angle, dt) {
    const delta = angle - this.knobAngle;
    this.knobAngle = angle;
    this.knobSpin.rotation.z = -angle;
    if (dt > 0) this.knobSpeed = this.knobSpeed * 0.6 + (delta / dt) * 0.4;
    const notch = Math.floor((angle - this.turnBase) / (Math.PI / 3));
    if (notch > this.lastNotch) {
      this.lastNotch = notch;
      this.hooks.onTick?.();
      this.shake = Math.min(1, this.shake + 0.35);
    }
    if (!this.locked && angle - this.turnBase >= Math.PI * 2 - 1e-3) {
      this.locked = true;
      this.dragging = null;
      this.autoSpin = null;
      this.hooks.onTurned?.();
    }
    this.requestRender();
  }

  /** 点一下：旋钮自己转满一圈 */
  spin() {
    if (this.locked || this.autoSpin || this.intro) return;
    const from = this.knobAngle;
    const to = this.turnBase + Math.PI * 2;
    this.autoSpin = { from, to, t: 0, dur: this.reduceMotion ? 0.25 : 1.15 * ((to - from) / (Math.PI * 2)) + 0.15 };
    this.requestRender();
  }

  get canSpin() {
    return !this.locked && !this.intro;
  }

  // ---------------------------------------------------------------- 入场

  /**
   * 入场动画（约 1.5 秒）：机器从上面掉下来 → 落地压扁再弹回 → 罩子里的球被震得跳起来、门帘晃 →
   * 顶上小球和旋钮跟着弹两下 → 玻璃上扫过一道高光。播放期间不能拧。
   */
  playIntro() {
    if (this.reduceMotion || this.intro) return Promise.resolve();
    this.intro = true;
    const rig = this.rig;
    const shadow = this.shadow;
    const hiMat = this.glints[0].material;
    const H = 2.6;          // 从多高掉下来（画面上沿外面）
    const FALL = 0.42;
    const KNOB_AT = FALL + 0.1;
    const GLINT_AT = FALL + 0.2;
    const GLINT_DUR = 0.62;
    const END = 1.55;
    let landed = false;
    let ticked = false;
    let chimed = false;

    const apply = el => {
      // 1) 下落：越掉越快，身子略微拉长、歪一点
      if (el < FALL) {
        const u = el / FALL;
        rig.position.y = H * (1 - u * u);
        rig.scale.set(1 - 0.035 * u, 1 + 0.07 * u, 1 - 0.035 * u);
        this.tilt = 0.07 * (1 - u);
        const k = 0.3 + 0.7 * u;
        shadow.scale.set(0.96 * k, 0.6 * k, 1);
        shadow.material.opacity = 0.9 * (0.25 + 0.75 * u);
      } else {
        // 2) 落地：压扁后像果冻一样弹几下回原形
        const tau = el - FALL;
        const sq = 0.17 * Math.exp(-7 * tau) * Math.cos(19 * tau);
        rig.position.y = 0;
        rig.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
        this.tilt = -0.045 * Math.exp(-5 * tau) * Math.sin(12 * tau);
        shadow.scale.set(0.96 * (1 + sq * 0.5), 0.6 * (1 + sq * 0.5), 1);
        shadow.material.opacity = 0.9;
        // 顶上的小球晚一拍弹起来
        const tb = Math.max(0, tau - 0.05);
        const bs = 0.38 * Math.exp(-6 * tb) * Math.sin(16 * tb);
        this.bob.scale.set(1 - bs * 0.4, 1 + bs, 1 - bs * 0.4);
      }
      // 3) 旋钮被震得来回弹一下
      if (el >= KNOB_AT) {
        const tk = el - KNOB_AT;
        this.knobSpin.rotation.z = -this.knobAngle - 0.55 * Math.exp(-4.5 * tk) * Math.sin(13 * tk);
      }
      // 4) 玻璃高光从左边扫到原位
      if (el < GLINT_AT) {
        for (const g of this.glints) g.visible = false;
      } else {
        const v = Math.min(1, (el - GLINT_AT) / GLINT_DUR);
        for (const g of this.glints) {
          g.visible = true;
          g.rotation.y = -1.35 * (1 - easeInOut(v));
        }
        hiMat.opacity = 0.92 * Math.min(1, v / 0.3);
      }
      // 5) 罩子旁边一颗接一颗蹦出小星星，转半圈再缩回去
      this.stars.forEach((st, i) => {
        const local = el - (GLINT_AT + 0.05 + i * 0.1);
        if (local <= 0 || local >= 0.55) { st.visible = false; return; }
        const k = local < 0.2 ? easeOutBack(local / 0.2) : local < 0.35 ? 1 : 1 - easeInOut((local - 0.35) / 0.2);
        st.visible = k > 0.01;
        st.scale.setScalar(Math.max(0.001, k * st.userData.size));
        st.rotation.set(-0.29, 0, local * 2.4 - 0.4);
      });
    };

    apply(0);
    this.render();

    return new Promise(resolve => {
      this._tween(END, (t, dt, el) => {
        if (!landed && el >= FALL) {
          landed = true;
          this.hooks.onDropLand?.(1);
          this.shake = Math.min(1, this.shake + 0.7);
          // 罩子里的球被震得跳起来，落回去时自己会咔哒咔哒响
          for (const b of this.balls) {
            if (b.hidden) continue;
            b.v.y += 2.2 + Math.random() * 2.2;
            b.v.x += (Math.random() - 0.5) * 1.3;
            b.v.z += (Math.random() - 0.5) * 1.3;
          }
          if (this.flap) this.flap.vel -= 7;
        }
        if (!ticked && el >= KNOB_AT + 0.04) {
          ticked = true;
          // 不走 onTick：那个会把外面的步骤推进到「拧动中」
          this.hooks.onIntroTick?.();
        }
        if (!chimed && el >= GLINT_AT + GLINT_DUR * 0.55) {
          chimed = true;
          this.hooks.onIntroShine?.();
        }
        apply(el);
      }, () => {
        rig.position.y = 0;
        rig.scale.set(1, 1, 1);
        this.tilt = 0;
        shadow.scale.set(0.96, 0.6, 1);
        shadow.material.opacity = 0.9;
        this.bob.scale.set(1, 1, 1);
        this.knobSpin.rotation.z = -this.knobAngle;
        for (const g of this.glints) { g.visible = true; g.rotation.y = 0; }
        hiMat.opacity = 0.92;
        for (const st of this.stars) st.visible = false;
        this.intro = false;
        this.requestRender();
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------- 胶囊

  /** 抽中的那颗球沉下去，胶囊从出口滚到托盘上 */
  dropCapsule(ballId, color) {
    const ball = this.balls.find(b => b.id === ballId);
    if (ball) {
      ball.hidden = true;
      this._tween(0.28, t => { ball.scale = 1 - t; ball.p.y -= 0.01; });
    }
    const tex = this._capTextures(color);
    this.capTopMat.map = tex.top;
    this.capBotMat.map = tex.bottom;
    const c = this.capsule;
    this._clearConfetti();
    c.state = 'rolling';
    c.holder.visible = true;
    c.holder.scale.set(1, 1, 1);
    c.top.position.set(0, 0, 0);
    c.top.rotation.set(0, 0, 0);
    c.bottom.position.set(0, 0, 0);
    c.bottom.rotation.set(0, 0, 0);
    c.roll.scale.z = 0.01;
    c.roll.position.y = 0.02;
    c.group.rotation.set(0, 0, 0);
    c.group.position.set(0, 0, 0);
    c.holder.position.set(0, 0.02, -0.3);
    // 滚得更远一点，停在托盘前半截，别缩在出口里
    const state = { y: 0.02, z: -0.3, vy: 0.4, vz: 3.0, bounces: 0, done: false, kicked: false, knocked: false };
    const restY = this.trayTopY + CAP_R;
    return new Promise(resolve => {
      const delay = ball ? 0.25 : 0;
      this._tween(delay + (this.reduceMotion ? 0.3 : 1.8), (t, dt, elapsed) => {
        if (elapsed < delay) return;
        if (this.reduceMotion) {
          state.y = restY;
          state.z = 0.38;
        } else if (!state.done) {
          state.vy -= GRAVITY * dt;
          state.y += state.vy * dt;
          state.z += state.vz * dt;
          // 胶囊撞开出口门帘
          if (!state.kicked && state.z > -0.2) {
            state.kicked = true;
            this.flap.vel = -12;
            this.hooks.onImpact?.(0.5);
          }
          if (state.y < restY) {
            state.y = restY;
            if (state.vy < -0.6) {
              this.hooks.onDropLand?.(state.bounces === 0 ? 1 : 0.45);
              this._squash(state.bounces === 0 ? 0.28 : 0.12);
              state.bounces++;
            }
            state.vy = -state.vy * 0.42;
            state.vz *= 0.8;
            if (Math.abs(state.vy) < 0.25) state.vy = 0;
          }
          if (state.z > this.trayFrontZ - CAP_R - 0.02) {
            state.z = this.trayFrontZ - CAP_R - 0.02;
            // 撞到托盘前沿：咚一声，往回弹一点
            if (!state.knocked && state.vz > 0.4) {
              state.knocked = true;
              this.hooks.onImpact?.(Math.min(1, state.vz / 2));
              this._squash(0.1);
            }
            state.vz = -Math.abs(state.vz) * 0.3;
          }
          if (state.vy === 0) state.vz *= Math.max(0, 1 - 2.4 * dt);
          if (state.vy === 0 && Math.abs(state.vz) < 0.05) state.done = true;
          c.group.rotation.x += (state.vz / CAP_R) * dt;
        }
        c.holder.position.set(0, state.y, state.z);
        return this.reduceMotion || state.done;
      }, () => {
        // 落定后把胶囊摆正一点，开口朝上
        const rx = c.group.rotation.x % (Math.PI * 2);
        this._tween(0.25, t => { c.group.rotation.x = rx * (1 - easeInOut(t)); });
        c.state = 'waiting';
        this._startWobble();
        resolve();
      });
    });
  }

  /** 落地压扁再弹回（绕胶囊底部，不会陷进托盘） */
  _squash(amount) {
    if (this.reduceMotion) return;
    const { holder: h, group: g } = this.capsule;
    this._tween(0.32, t => {
      const k = Math.sin(t * Math.PI) * (1 - t * 0.4) * amount;
      h.scale.set(1 + k * 0.6, 1 - k, 1 + k * 0.6);
      // 绕中心压扁时底部会离开托盘；把里面那层往下挪回去（holder 的位置归掉落动画管）
      g.position.y = -CAP_R * k / (1 - k);
    }, () => { h.scale.set(1, 1, 1); g.position.y = 0; });
  }

  /** 胶囊在屏幕上的位置（给网页上的签条做「从胶囊里飞出来」用） */
  capsuleScreenPos() {
    const v = new THREE.Vector3();
    // 拆开后签条是从下半个（纸卷所在）里出来的
    this.capsule.bottom.getWorldPosition(v);
    v.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
  }

  _startWobble() {
    clearInterval(this.wobbleTimer);
    if (this.reduceMotion) return;
    this.wobbleTimer = setInterval(() => {
      if (this.capsule.state !== 'waiting' || !this.visible) return;
      this._tween(0.6, t => {
        this.capsule.group.rotation.z = Math.sin(t * Math.PI * 3) * 0.22 * (1 - t);
      });
    }, 1700);
  }

  /**
   * 开盖：先在托盘上咔咔抖两下蓄力，然后「啵」地弹开——
   * 两个半壳当成真的刚体：有重心、会转、撞托盘会弹、撞围边会反弹，圆顶朝下时像不倒翁一样来回摇几下才停；
   * 纸卷弹出来，再撒一把彩色纸屑。每次撞击都发声、机身跟着轻轻一震。
   * 上半个第一次落地（或 0.75 秒）时就 resolve，让网页上的签条接着飞出来；半壳和纸屑继续自己晃完。
   */
  openCapsule() {
    const c = this.capsule;
    if (c.state !== 'waiting') return Promise.resolve();
    c.state = 'opening';
    clearInterval(this.wobbleTimer);
    c.group.rotation.set(0, 0, 0);
    c.group.position.set(0, 0, 0);
    c.holder.scale.set(1, 1, 1);

    const env = this._openEnv();

    if (this.reduceMotion) {
      c.top.position.set(-0.32, 0, 0);
      c.top.rotation.set(0, 0, Math.PI);
      c.roll.scale.z = 1;
      c.roll.position.y = 0.12;
      c.state = 'open';
      this.requestRender();
      return Promise.resolve();
    }

    return new Promise(resolve => {
      let resolved = false;
      const finish = () => { if (!resolved) { resolved = true; resolve(); } };

      // 1) 蓄力：抖两下、往下压一点
      this._tween(0.3, t => {
        c.group.rotation.z = Math.sin(t * Math.PI * 7) * 0.1 * (0.4 + t);
        const k = t * 0.09;
        c.holder.scale.set(1 + k * 0.6, 1 - k, 1 + k * 0.6);
        c.group.position.y = -CAP_R * k / (1 - k);
      }, () => {
        c.group.rotation.set(0, 0, 0);
        c.group.position.set(0, 0, 0);
        c.holder.scale.set(1, 1, 1);

        // 2) 啵！上半个被弹飞（往左上、带着翻滚），下半个被反冲得跳一下
        this.hooks.onPop?.();
        this.shake = Math.min(1, this.shake + 0.45);
        const rnd = (a, b) => a + Math.random() * (b - a);
        const bodies = [
          this._shellBody(c.top, 1, [rnd(-1.05, -0.7), rnd(2.6, 3.1), rnd(0.1, 0.45)], [rnd(-3, 3), rnd(-2.5, 2.5), rnd(8, 12)]),
          this._shellBody(c.bottom, -1, [rnd(0.15, 0.35), rnd(0.8, 1.1), rnd(-0.15, 0.05)], [rnd(-2.5, 2.5), rnd(-1, 1), rnd(-5, -3)])
        ];
        this._spawnConfetti();
        let elapsed = 0;
        let calm = 0;
        this._tween(5, (t, dt) => {
          if (c.state !== 'opening' && c.state !== 'open') return true; // 中途被「再转一次」收走了
          elapsed += dt;
          const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
          for (let i = 0; i < sub; i++) {
            for (const b of bodies) this._stepShell(b, dt / sub, env);
            this._shellPair(bodies[0], bodies[1]);
          }
          const confettiCalm = this._stepConfetti(dt, env);
          // 纸卷带回弹地钻出来
          const rt = Math.min(1, elapsed / 0.42);
          const pop = easeOutBack(rt);
          c.roll.scale.z = Math.max(0.01, pop);
          c.roll.position.y = 0.02 + pop * 0.12;
          if (!resolved && (bodies[0].hits > 0 || elapsed > 0.75)) finish();
          const still = bodies.every(b => b.v.lengthSq() < 0.003 && b.w.lengthSq() < 0.04);
          calm = still ? calm + dt : 0;
          return calm > 0.35 && confettiCalm && rt >= 1;
        }, () => {
          finish();
          if (c.state === 'opening') c.state = 'open';
        });
      });
    });
  }

  /**
   * 拆胶囊时的「地形」（holder 局部坐标：原点 = 胶囊中心）：
   * 托盘里面 → 托盘面；围边那一圈 → 围边顶；托盘外面 → 桌面（低一截）；再远就是看不见的墙。
   * 高度差就是台阶：半壳侧着撞上去会被挡回来，从上面越过去就掉到桌上。
   */
  _openEnv() {
    const hp = this.capsule.holder.position;
    const inner = this.trayInner;
    const outer = { xMin: -0.47, xMax: 0.47, zMin: 0.32 - 0.52, zMax: 0.32 + 0.52 };
    const tray = -CAP_R;
    const rimTop = this.trayTopY + 0.075 - hp.y;
    const ground = -this.chute.position.y - hp.y;
    const ix0 = inner.xMin - hp.x;
    const ix1 = inner.xMax - hp.x;
    const iz0 = inner.zMin - hp.z;
    const iz1 = inner.zMax - hp.z;
    const ox0 = outer.xMin - hp.x;
    const ox1 = outer.xMax - hp.x;
    const oz0 = outer.zMin - hp.z;
    const oz1 = outer.zMax - hp.z;
    // 桌面上能滚的范围：别滚进机身里，也别滚出画面
    // （出口朝左前方转了 0.42 rad，局部 -x / +z 都是往画面左下角去，所以收得紧一点）
    const fx0 = -0.9 - hp.x;
    const fx1 = 0.6 - hp.x;
    const fz0 = -0.2 - hp.z;
    const fz1 = 0.98 - hp.z;
    return {
      tray,
      inner: { xMin: ix0, xMax: ix1, zMin: iz0, zMax: iz1 },
      floorAt(x, z) {
        if (x < fx0 || x > fx1 || z < fz0 || z > fz1) return Infinity;
        if (x >= ix0 && x <= ix1 && z >= iz0 && z <= iz1) return tray;
        if (x >= ox0 && x <= ox1 && z >= oz0 && z <= oz1) return rimTop;
        return ground;
      }
    };
  }

  /** 半壳刚体。pole = 1：圆顶朝局部 +y（上半个）；-1：朝 -y（下半个） */
  _shellBody(group, pole, v, w) {
    const d = new THREE.Vector3(0, pole, 0).applyQuaternion(group.quaternion);
    return {
      g: group, pole,
      P: group.position.clone().addScaledVector(d, CAP_R * SHELL_COM), // 重心（在球心和圆顶之间）
      v: new THREE.Vector3(...v), w: new THREE.Vector3(...w),
      hits: 0, lastHit: 0
    };
  }

  _stepShell(b, h, env) {
    const r = CAP_R;
    const off = r * SHELL_COM;
    const I = 0.42 * r * r;      // 转动惯量（质量 = 1）
    const e = 0.45;              // 撞托盘的弹性
    const mu = 0.5;              // 摩擦
    const T = this._tmp || (this._tmp = {
      q: new THREE.Quaternion(), a: new THREE.Vector3(), d: new THREE.Vector3(), c: new THREE.Vector3(),
      p: new THREE.Vector3(), rc: new THREE.Vector3(), vp: new THREE.Vector3(), x: new THREE.Vector3(), t: new THREE.Vector3()
    });

    b.v.y -= GRAVITY * h;
    const prevX = b.P.x;
    const prevZ = b.P.z;
    b.P.addScaledVector(b.v, h);
    const wl = b.w.length();
    if (wl > 1e-6) {
      T.q.setFromAxisAngle(T.a.copy(b.w).divideScalar(wl), wl * h);
      b.g.quaternion.premultiply(T.q);
    }
    b.w.multiplyScalar(1 - 0.3 * h);

    const d = T.d.set(0, b.pole, 0).applyQuaternion(b.g.quaternion);
    const c = T.c.copy(b.P).addScaledVector(d, -off); // 球心
    // 半壳最低的那一点：圆顶朝下时是球的最低点；圆顶朝上时是开口边沿上最低的那一点
    const p = T.p;
    let flat = false;
    if (d.y <= 0) {
      p.copy(c).y -= r;
    } else if (d.y > 0.96) {
      // 开口朝下、几乎平躺：整圈口沿都贴着地，接触点取重心正下方（不然最低点在口沿上来回跳，会一直原地打转）
      flat = true;
      p.set(b.P.x, c.y - r * Math.sqrt(Math.max(0, 1 - d.y * d.y)), b.P.z);
    } else {
      T.t.set(0, -1, 0).addScaledVector(d, d.y);
      if (T.t.lengthSq() < 1e-6) T.t.set(1, 0, 0);
      p.copy(c).addScaledVector(T.t.normalize(), r);
    }

    // 台阶 / 墙：往前探一个半径，那边的地面比半壳最低点还高 → 撞上了，弹回来
    const ext = r * 0.9;
    for (const axis of ['x', 'z']) {
      const vAx = b.v[axis];
      if (Math.abs(vAx) < 1e-4) continue;
      const px = axis === 'x' ? c.x + Math.sign(vAx) * ext : c.x;
      const pz = axis === 'z' ? c.z + Math.sign(vAx) * ext : c.z;
      if (env.floorAt(px, pz) > p.y + 0.012) {
        const back = (axis === 'x' ? prevX : prevZ) - b.P[axis];
        b.P[axis] += back;
        c[axis] += back;
        p[axis] += back;
        const s = Math.abs(vAx);
        if (s > 0.3) {
          // 撞得够快：弹回来，还带点打转
          b.v[axis] = -vAx * 0.45;
          b.w.y += (Math.random() - 0.5) * s * 4;
          if (s > 0.35) this._shellHit(b, s * 0.8);
        } else {
          // 只是慢慢靠上去：贴住不弹，免得靠着托盘侧面一直抖
          b.v[axis] = 0;
          b.w.multiplyScalar(1 - 8 * h);
        }
      }
    }

    const floor = env.floorAt(p.x, p.z);
    if (p.y < floor && floor !== Infinity) {
      const pen = floor - p.y;
      b.P.y += pen;
      c.y += pen;
      p.y = floor;
      const rc = T.rc.subVectors(p, b.P);
      const vp = T.vp.copy(b.w).cross(rc).add(b.v);
      if (vp.y < 0) {
        // 法向冲量（n = +y）；很慢的接触不反弹，免得原地抖
        const rxn = T.x.set(-rc.z, 0, rc.x); // rc × (0,1,0)
        const denom = 1 + rxn.lengthSq() / I;
        const j = -(1 + (vp.y < -0.6 ? e : 0)) * vp.y / denom;
        b.v.y += j;
        b.w.addScaledVector(rxn, j / I);
        if (vp.y < -0.7) this._shellHit(b, -vp.y);
        // 摩擦冲量：把接触点的滑动吃掉一部分，转成滚动/摇摆
        const vp2 = T.vp.copy(b.w).cross(rc).add(b.v);
        vp2.y = 0;
        const vt = vp2.length();
        if (vt > 1e-5) {
          const tdir = vp2.divideScalar(vt);
          const rxt = T.t.copy(rc).cross(tdir);
          const jt = Math.max(-mu * j, -vt / (1 + rxt.lengthSq() / I));
          b.v.addScaledVector(tdir, jt);
          b.w.addScaledVector(rxt, jt / I);
        }
      }
      // 贴着地面时的滚动阻力：让不倒翁式的摇摆摇几下就停（太小会晃个没完，太大就像粘住）
      b.w.multiplyScalar(1 - 3.6 * h);
      b.v.x *= 1 - 2.4 * h;
      b.v.z *= 1 - 2.4 * h;
      // 快停的时候再多收一点，免得最后一点点余晃拖很久
      if (b.w.lengthSq() < 0.6 && b.v.lengthSq() < 0.02) {
        b.w.multiplyScalar(1 - 6 * h);
        b.v.multiplyScalar(1 - 6 * h);
      }
      if (flat) {
        // 平躺：转动很快被吃掉，再轻轻扶正成完全平放
        b.w.multiplyScalar(1 - 8 * h);
        T.a.set(-d.z, 0, d.x); // d × (0,1,0)：绕这根轴转，d 会转向正上方
        b.w.addScaledVector(T.a, 12 * h);
      }
    }

    b.g.position.copy(c);
  }

  /** 两个半壳互相撞：各当成一个包着重心的小球，挤开 + 交换一点动量（不然盖子会落进下半个里重叠） */
  _shellPair(a, b) {
    const min = CAP_R * 1.25;
    const d = (this._pairTmp || (this._pairTmp = new THREE.Vector3())).subVectors(b.P, a.P);
    const dist = d.length();
    if (dist >= min || dist < 1e-6) return;
    d.divideScalar(dist);
    const push = (min - dist) / 2;
    a.P.addScaledVector(d, -push);
    b.P.addScaledVector(d, push);
    // 位置改了要同步回网格（球心 = 重心 - 朝向 × 偏移）
    for (const s of [a, b]) {
      const dir = new THREE.Vector3(0, s.pole, 0).applyQuaternion(s.g.quaternion);
      s.g.position.copy(s.P).addScaledVector(dir, -CAP_R * SHELL_COM);
    }
    const rel = b.v.clone().sub(a.v).dot(d);
    if (rel < 0) {
      const j = -(1 + 0.3) * rel / 2;
      a.v.addScaledVector(d, -j);
      b.v.addScaledVector(d, j);
      // 擦碰带一点转
      a.w.y += (Math.random() - 0.5) * j * 6;
      b.w.y += (Math.random() - 0.5) * j * 6;
      if (-rel > 0.5) this._shellHit(a, -rel);
    }
  }

  _shellHit(b, speed) {
    const now = performance.now();
    if (now - b.lastHit < 70) return;
    b.lastHit = now;
    b.hits++;
    const s = Math.min(1, speed / 3);
    if (s > 0.35) this.hooks.onDropLand?.(s);
    else this.hooks.onImpact?.(Math.max(0.2, s * 1.6));
    this.shake = Math.min(1, this.shake + s * 0.25);
  }

  // ---------- 彩色纸屑 ----------
  _spawnConfetti() {
    if (!this.confettiGeo) {
      this.confettiGeo = new THREE.BoxGeometry(0.11, 0.012, 0.07);
      this.confettiMats = ['#fda4af', '#fde047', '#7dd3fc', '#c4b5fd', '#86efac', '#fdba74'].map(col => {
        const m = this.toon(col);
        m.userData.outlineParameters = NO_OUTLINE;
        return m;
      });
      this.disposables.push(this.confettiGeo);
    }
    this._clearConfetti();
    for (let i = 0; i < 22; i++) {
      const mesh = new THREE.Mesh(this.confettiGeo, this.confettiMats[i % this.confettiMats.length]);
      const a = Math.random() * Math.PI * 2;
      const sp = 0.4 + Math.random() * 1.0;
      const bit = {
        mesh,
        p: new THREE.Vector3(Math.cos(a) * 0.05, 0.05, Math.sin(a) * 0.05),
        v: new THREE.Vector3(Math.cos(a) * sp, 2.2 + Math.random() * 1.4, Math.sin(a) * sp),
        spin: new THREE.Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 18),
        phase: Math.random() * 6, rest: false
      };
      mesh.position.copy(bit.p);
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.capsule.holder.add(mesh);
      this.confetti.push(bit);
    }
  }

  _stepConfetti(dt, env) {
    let allRest = true;
    for (const bit of this.confetti) {
      if (bit.rest) continue;
      allRest = false;
      const { p, v, mesh } = bit;
      bit.phase += dt * 9;
      // 纸片会飘：重力小一点、空气阻力大一点、左右晃
      v.y -= GRAVITY * 0.45 * dt;
      v.multiplyScalar(1 - 1.4 * dt);
      if (v.y < 0) v.x += Math.sin(bit.phase) * 1.2 * dt;
      p.addScaledVector(v, dt);
      mesh.rotation.x += bit.spin.x * dt;
      mesh.rotation.y += bit.spin.y * dt;
      mesh.rotation.z += bit.spin.z * dt;
      // 纸屑轻，只在托盘围边里面飘，撞到围边就弹回来
      const box = env.inner;
      if (p.x < box.xMin + 0.03) { p.x = box.xMin + 0.03; v.x = Math.abs(v.x) * 0.4; }
      if (p.x > box.xMax - 0.03) { p.x = box.xMax - 0.03; v.x = -Math.abs(v.x) * 0.4; }
      if (p.z < box.zMin + 0.03) { p.z = box.zMin + 0.03; v.z = Math.abs(v.z) * 0.4; }
      if (p.z > box.zMax - 0.03) { p.z = box.zMax - 0.03; v.z = -Math.abs(v.z) * 0.4; }
      const floor = env.tray + 0.006;
      if (p.y < floor) {
        p.y = floor;
        v.y = Math.abs(v.y) * 0.2;
        v.x *= 0.5;
        v.z *= 0.5;
        bit.spin.multiplyScalar(0.4);
        if (v.lengthSq() < 0.02) {
          // 躺平在托盘上
          bit.rest = true;
          mesh.rotation.x = 0;
          mesh.rotation.z = 0;
        }
      }
      mesh.position.copy(p);
    }
    return allRest;
  }

  _clearConfetti() {
    for (const bit of this.confetti || []) bit.mesh.removeFromParent();
    this.confetti = [];
  }

  /** 再转一次：收走胶囊，把刚才那颗球从罩顶扔回去 */
  reset() {
    clearInterval(this.wobbleTimer);
    const c = this.capsule;
    c.holder.visible = false;
    c.state = 'none';
    this._clearConfetti();
    for (const b of this.balls) {
      if (b.hidden) {
        b.hidden = false;
        b.scale = 1;
        b.p.set((Math.random() - 0.5) * 0.3, DOME_C.y + 0.45, (Math.random() - 0.5) * 0.3);
        b.v.set(0, 0, 0);
      }
    }
    this.turnBase = this.knobAngle;
    this.lastNotch = 0;
    this.locked = false;
    this.requestRender();
  }

  // ---------------------------------------------------------------- 输入

  _bindEvents() {
    this._onDown = e => this._pointerDown(e);
    this._onMove = e => this._pointerMove(e);
    this._onUp = e => this._pointerUp(e);
    this._onLeave = () => { this.parallax.tx = 0; this.parallax.ty = 0; this.canvas.style.cursor = ''; this.requestRender(); };
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('pointercancel', this._onUp);
    this.canvas.addEventListener('pointerleave', this._onLeave);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.host);
    this.ioObs = new IntersectionObserver(entries => {
      this.visible = entries.some(en => en.isIntersecting);
      if (this.visible) this.requestRender();
    });
    this.ioObs.observe(this.host);
    this._onVis = () => { if (!document.hidden) this.requestRender(); };
    document.addEventListener('visibilitychange', this._onVis);
  }

  _hit(e, meshes) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(meshes, false).length > 0;
  }

  _pointerDown(e) {
    if (this.capsule.state === 'waiting' && this._hit(e, this.capsule.shells)) {
      this.hooks.onCapsuleClick?.();
      return;
    }
    if (!this.locked && !this.autoSpin && !this.intro && this._hit(e, this.knobMeshes)) {
      const c = this._knobCenterScreen();
      this.dragging = { cx: c.x, cy: c.y, last: Math.atan2(e.clientY - c.y, e.clientX - c.x), moved: 0, sx: e.clientX, sy: e.clientY, t: performance.now() };
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.canvas.style.cursor = 'grabbing';
      e.preventDefault();
    }
  }

  _pointerMove(e) {
    if (this.dragging) {
      const d = this.dragging;
      const a = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
      let delta = a - d.last;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      d.last = a;
      d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.sx, e.clientY - d.sy));
      const now = performance.now();
      const dt = Math.max(0.008, (now - d.t) / 1000);
      d.t = now;
      // 屏幕坐标 y 向下，所以 atan2 增大 = 顺时针；棘轮只许顺时针
      if (delta > 0) this._setKnobAngle(this.knobAngle + delta, dt);
      return;
    }
    if (!this.reduceMotion) {
      const rect = this.canvas.getBoundingClientRect();
      this.parallax.tx = (((e.clientX - rect.left) / rect.width) - 0.5) * 0.32;
      this.parallax.ty = (((e.clientY - rect.top) / rect.height) - 0.5) * 0.1;
    }
    const overKnob = !this.locked && this._hit(e, this.knobMeshes);
    const overCap = this.capsule.state === 'waiting' && this._hit(e, this.capsule.shells);
    this.canvas.style.cursor = overCap ? 'pointer' : overKnob ? 'grab' : '';
    this.requestRender();
  }

  _pointerUp(e) {
    const d = this.dragging;
    if (!d) return;
    this.dragging = null;
    this.canvas.style.cursor = '';
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // 几乎没拖动 = 点了一下，旋钮自己转一圈
    if (d.moved < 6 && !this.locked) this.spin();
  }

  // ---------------------------------------------------------------- 循环

  _tween(dur, step, done) {
    this.tweens.push({ dur, elapsed: 0, step, done });
    this.requestRender();
  }

  requestRender() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(t => this._frame(t));
  }

  _frame(now) {
    if (this.disposed) return;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    let busy = false;

    if (this.autoSpin) {
      const s = this.autoSpin;
      s.t = Math.min(1, s.t + dt / s.dur);
      this._setKnobAngle(s.from + (s.to - s.from) * easeInOut(s.t), dt);
      if (s.t >= 1) this.autoSpin = null;
      busy = true;
    } else if (!this.dragging) {
      this.knobSpeed *= Math.max(0, 1 - 6 * dt);
    }
    if (this.dragging) busy = true;

    // 球的物理：固定步长
    const steps = Math.max(1, Math.round(dt / (1 / 120)));
    for (let i = 0; i < steps; i++) this._physics(dt / steps);
    this._syncBalls(dt);
    if (this._energy() > 0.004 || Math.abs(this.knobSpeed) > 0.05) {
      this.physicsCalm = 0;
      busy = true;
    } else if (this.physicsCalm < 20) {
      this.physicsCalm++;
      busy = true;
    }

    // 补间动画
    if (this.tweens.length) {
      busy = true;
      const list = this.tweens;
      this.tweens = [];
      for (const tw of list) {
        tw.elapsed += dt;
        const t = Math.min(1, tw.elapsed / tw.dur);
        const stopEarly = tw.step(t, dt, tw.elapsed) === true; // step 返回 true = 提前收工
        if (t < 1 && !stopEarly) this.tweens.push(tw);
        else tw.done?.();
      }
    }

    // 出口门帘：弹簧 + 阻尼，被顶开后来回荡几下停住
    const f = this.flap;
    if (f && (Math.abs(f.angle) > 0.002 || Math.abs(f.vel) > 0.01)) {
      const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
      for (let i = 0; i < sub; i++) {
        const h = dt / sub;
        f.vel += (-70 * f.angle - 4.5 * f.vel) * h;
        f.angle += f.vel * h;
      }
      if (f.angle < -1.45) { f.angle = -1.45; f.vel = Math.abs(f.vel) * 0.3; }
      if (f.angle > 0.3) { f.angle = 0.3; f.vel = -Math.abs(f.vel) * 0.3; }
      f.pivot.rotation.x = f.angle;
      busy = true;
    }

    // 悬停视差 + 拧动时机身抖一抖
    const p = this.parallax;
    p.x += (p.tx - p.x) * Math.min(1, dt * 6);
    p.y += (p.ty - p.y) * Math.min(1, dt * 6);
    if (Math.abs(p.tx - p.x) > 0.001 || Math.abs(p.ty - p.y) > 0.001) busy = true;
    this.shake *= Math.max(0, 1 - 7 * dt);
    if (this.shake > 0.01) busy = true;
    const wob = this.reduceMotion ? 0 : Math.sin(now / 38) * this.shake * 0.035;
    this.rig.rotation.set(p.y * 0.6, p.x, wob + this.tilt);

    this.render();

    if (busy && this.visible && !document.hidden) {
      this.raf = requestAnimationFrame(t => this._frame(t));
    } else {
      this.running = false;
    }
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camera.aspect = w / h;
    // 让整台机器（含托盘和影子）都框进画面
    const fitH = 4.85;
    const fitW = 3.3;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const distH = fitH / 2 / Math.tan(vFov / 2);
    const distW = fitW / 2 / Math.tan(vFov / 2) / this.camera.aspect;
    const dist = Math.max(distH, distW);
    const dir = new THREE.Vector3(0, 0.3, 1).normalize();
    this.camera.position.copy(this.camTarget).addScaledVector(dir, dist);
    this.camera.lookAt(this.camTarget);
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  render() {
    // OutlineEffect 里 autoClear 没初始化（undefined），three 不会自己清画布；
    // 平常靠浏览器每帧换缓冲清掉，一帧里画两次（构造时 + 入场第一帧）就会叠出残影、玻璃变成实心蓝
    this.renderer.clear();
    this.effect.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.wobbleTimer);
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
    document.removeEventListener('visibilitychange', this._onVis);
    this.resizeObs?.disconnect();
    this.ioObs?.disconnect();
    for (const d of this.disposables) d.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}

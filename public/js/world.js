// Lingkungan 3D: langit, kampung, zona badai, partikel angin
import * as THREE from 'three';
import { ROOF_HEIGHT } from '/shared/constants.js';
import { LAYOUT } from '/shared/arena.js';

export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Membuat InstancedMesh untuk setiap mesh di dalam template GLB */
export function instanceModel(template, matrices, { castShadow = false, receiveShadow = true } = {}) {
  const group = new THREE.Group();
  template.updateMatrixWorld(true);
  const tmp = new THREE.Matrix4();
  template.traverse((o) => {
    if (!o.isMesh) return;
    const im = new THREE.InstancedMesh(o.geometry, o.material, matrices.length);
    matrices.forEach((m, i) => im.setMatrixAt(i, tmp.multiplyMatrices(m, o.matrixWorld)));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = castShadow;
    im.receiveShadow = receiveShadow;
    im.computeBoundingSphere();
    group.add(im);
  });
  return group;
}

export function findMaterial(root, name) {
  let found = null;
  root.traverse((o) => {
    if (found || !o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m.name === name) found = m;
  });
  return found;
}

/** Clone model & ganti material bernama `matName` dengan warna tertentu */
export function cloneTinted(template, matName, color) {
  const obj = template.clone(true);
  obj.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) {
      o.material = o.material.map((m) => (m.name === matName ? tint(m, color) : m));
    } else if (o.material.name === matName) {
      o.material = tint(o.material, color);
    }
  });
  return obj;
}
function tint(m, color) {
  const c = m.clone();
  c.color = new THREE.Color(color);
  return c;
}

export class World {
  constructor(scene, renderer, assets, quality) {
    this.scene = scene;
    this.renderer = renderer;
    this.assets = assets;
    this.quality = quality;
    this.basesGroup = new THREE.Group();
    scene.add(this.basesGroup);
    this.players = new Map();
    this.clouds = [];
    this.time = 0;
    this.build();
  }

  build() {
    const scene = this.scene;
    const rand = mulberry32(20260915);

    // --- langit & cahaya
    // langit gradasi pastel (serasi dengan UI krem-hijau), juga tetap lembut saat kamera mendongak
    const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(62), THREE.MathUtils.degToRad(210));
    this.sunDir = sun;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(4500, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uTop: { value: new THREE.Color(0xa9c9cf) },
          uMid: { value: new THREE.Color(0xd3e2da) },
          uHorizon: { value: new THREE.Color(0xeef0dd) },
          uSun: { value: sun },
        },
        vertexShader: /* glsl */`
          varying vec3 vDir;
          void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */`
          uniform vec3 uTop, uMid, uHorizon, uSun; varying vec3 vDir;
          void main(){
            float h = clamp(vDir.y, 0.0, 1.0);
            vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.25, h));
            col = mix(col, uTop, smoothstep(0.25, 1.0, h));
            float glow = pow(max(dot(normalize(vDir), normalize(uSun)), 0.0), 24.0);
            col += vec3(1.0, 0.93, 0.78) * glow * 0.35;
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    sky.renderOrder = -1;
    scene.add(sky);
    this.sky = sky;
    this.skyMesh = sky;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    scene.environmentIntensity = 0.35;

    this.fogColor = new THREE.Color(0xdfe6d3);
    scene.fog = new THREE.Fog(this.fogColor.clone(), 160, 1500);

    const hemi = new THREE.HemisphereLight(0xffffe9, 0x789268, 1.4);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xfff1d6, 2.4);
    dir.position.copy(sun).multiplyScalar(300);
    if (this.quality.shadows) {
      dir.castShadow = true;
      dir.shadow.mapSize.set(2048, 2048);
      const s = 120;
      Object.assign(dir.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 10, far: 700 });
      dir.shadow.bias = -0.0006;
      dir.shadow.normalBias = 0.4;
    }
    scene.add(dir);
    scene.add(dir.target);
    this.sun = dir;

    // --- tanah
    const size = 4000, seg = 160;
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cA = new THREE.Color(0x9bb07a), cB = new THREE.Color(0xb3c28e), cC = new THREE.Color(0xd9c9a3), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r = Math.hypot(x, z);
      const n = Math.sin(x * 0.013) * Math.cos(z * 0.017) + Math.sin((x + z) * 0.041) * 0.5;
      let h = 0;
      if (r > 500) h = ((r - 500) / 1500) ** 2 * 60 * (0.6 + 0.4 * Math.sin(x * 0.004 + z * 0.003));
      pos.setY(i, h - 0.05);
      c.copy(cA).lerp(cB, n * 0.5 + 0.5);
      if (Math.sin(x * 0.007) * Math.sin(z * 0.009) > 0.6) c.lerp(cC, 0.35);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    ground.receiveShadow = true;
    scene.add(ground);

    // --- sawah (petak-petak hijau muda) & jalan
    const paddyMat = new THREE.MeshStandardMaterial({ color: 0xc9d39c, roughness: 0.9 });
    const paddyWet = new THREE.MeshStandardMaterial({ color: 0x9fbfb0, roughness: 0.3, metalness: 0.05 });
    const paddyGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const paddyM = [], wetM = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p3 = new THREE.Vector3();
    for (let i = 0; i < 160; i++) {
      const a = rand() * Math.PI * 2, r = 180 + rand() * 700;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) < 8 || Math.abs(z) < 8) continue;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.round(rand() * 2) * (Math.PI / 2) + (rand() - 0.5) * 0.1);
      m4.compose(p3.set(x, 0.03, z), q, sc.set(20 + rand() * 30, 1, 14 + rand() * 24));
      (rand() < 0.3 ? wetM : paddyM).push(m4.clone());
    }
    const paddy = new THREE.InstancedMesh(paddyGeo, paddyMat, paddyM.length);
    paddyM.forEach((m, i) => paddy.setMatrixAt(i, m));
    const wet = new THREE.InstancedMesh(paddyGeo, paddyWet, wetM.length);
    wetM.forEach((m, i) => wet.setMatrixAt(i, m));
    paddy.receiveShadow = wet.receiveShadow = true;
    scene.add(paddy, wet);

    const roadMat = new THREE.MeshStandardMaterial({ color: 0xe2d3b4, roughness: 1 });
    for (const [w, d, x, z] of [[9, 1600, -60, 0], [1600, 9, 0, 70], [7, 900, 140, -300]]) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), roadMat);
      road.position.set(x, 0.05, z);
      road.receiveShadow = true;
      scene.add(road);
    }

    // --- rumah-rumah kampung
    const A = this.assets;
    // tata letak dari shared/arena.js — identik dengan collider fisika di server
    const place = ({ x, z, rot, s = 1 }) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      return new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
    };
    const houseA = LAYOUT.houses.filter((h) => h.variant === 'a').map(place);
    const houseB = LAYOUT.houses.filter((h) => h.variant === 'b').map(place);
    const palms = LAYOUT.palms.map(place);
    const trees = LAYOUT.trees.map(place);
    const shadowed = this.quality.shadows;
    scene.add(instanceModel(A.house_a, houseA, { castShadow: shadowed }));
    scene.add(instanceModel(A.house_b, houseB, { castShadow: shadowed }));
    scene.add(instanceModel(A.palm, palms, { castShadow: shadowed }));
    scene.add(instanceModel(A.tree, trees, { castShadow: shadowed }));

    const mosque = A.mosque.clone();
    mosque.position.set(LAYOUT.mosque.x, 0, LAYOUT.mosque.z);
    mosque.rotation.y = LAYOUT.mosque.rot;
    mosque.traverse((o) => { if (o.isMesh) { o.castShadow = shadowed; o.receiveShadow = true; } });
    scene.add(mosque);

    // --- gunung di kejauhan
    const mountains = [];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.3;
      const r = 1300 + rand() * 350;
      const s = 2.4 + rand() * 2.2;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 6.28);
      mountains.push(new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * r, -5, Math.sin(a) * r), q, new THREE.Vector3(s, s * (0.7 + rand() * 0.8), s)));
    }
    scene.add(instanceModel(A.mountain, mountains, { receiveShadow: false }));

    // --- awan
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xc9cfbf, emissiveIntensity: 0.75, flatShading: true, transparent: true, opacity: 0.92 });
    const cloudGeo = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 38; i++) {
      const cg = new THREE.Group();
      const blobs = 4 + Math.floor(rand() * 5);
      for (let b = 0; b < blobs; b++) {
        const m = new THREE.Mesh(cloudGeo, cloudMat);
        const s = 14 + rand() * 20;
        m.scale.set(s * 1.4, s * 0.7, s);
        m.position.set((b - blobs / 2) * 18 + rand() * 8, rand() * 8, rand() * 16);
        cg.add(m);
      }
      const a = rand() * Math.PI * 2, r = 150 + rand() * 1300;
      cg.position.set(Math.cos(a) * r, 200 + rand() * 130, Math.sin(a) * r);
      cg.rotation.y = rand() * 6;
      scene.add(cg);
      this.clouds.push(cg);
    }

    // --- dinding zona badai
    this.zoneMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x8fb597) } },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying vec3 vWorld;
        void main(){
          vUv = uv;
          vec4 w = modelMatrix * vec4(position,1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform vec3 uColor; varying vec2 vUv; varying vec3 vWorld;
        void main(){
          float s1 = sin(vUv.x*220.0 + vUv.y*30.0 - uTime*3.0)*0.5+0.5;
          float s2 = sin(vUv.x*70.0 - vUv.y*14.0 + uTime*1.7)*0.5+0.5;
          float fade = smoothstep(1.0, 0.35, vUv.y) * smoothstep(0.0, 0.02, vUv.y);
          float near = mix(1.0, 0.18, smoothstep(30.0, 220.0, distance(vWorld, cameraPosition)));
          float a = (0.08 + 0.4*s1*s2) * fade * near;
          vec3 col = mix(uColor, vec3(0.85,0.9,1.0), s1*s2*0.5);
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.zoneWall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 128, 1, true), this.zoneMat);
    this.zoneWall.scale.set(150, 420, 150);
    this.zoneWall.position.y = 205;
    this.zoneWall.renderOrder = 5;
    scene.add(this.zoneWall);
    this.zoneRing = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1, 128).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xe3b566, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.zoneRing.position.y = 0.4;
    scene.add(this.zoneRing);
    this.setZone(150, false);

    // --- partikel angin
    const N = 220;
    this.windN = N;
    this.windSeeds = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) this.windSeeds[i] = rand();
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    this.windLines = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    this.windLines.frustumCulled = false;
    scene.add(this.windLines);
  }

  setZone(r, visible = true) {
    this.zoneWall.visible = visible;
    this.zoneRing.visible = visible;
    this.zoneWall.scale.x = this.zoneWall.scale.z = r;
    this.zoneRing.scale.set(r, 1, r);
  }

  /** Rumah dak + figur pemain untuk setiap peserta */
  setBases(roster) {
    for (const c of [...this.basesGroup.children]) this.basesGroup.remove(c);
    this.players.clear();
    const shadowed = this.quality.shadows;
    for (const r of roster) {
      const base = this.assets.rooftop_base.clone();
      base.position.set(r.ax, 0, r.az);
      base.rotation.y = -Math.atan2(r.az, r.ax) + Math.PI / 2;
      base.traverse((o) => { if (o.isMesh) { o.castShadow = shadowed; o.receiveShadow = true; } });
      this.basesGroup.add(base);
      const fig = cloneTinted(this.assets.player, 'Shirt', r.color);
      fig.position.set(r.ax, ROOF_HEIGHT, r.az);
      fig.traverse((o) => { if (o.isMesh) o.castShadow = shadowed; });
      this.basesGroup.add(fig);
      this.players.set(r.id, { fig, ax: r.ax, az: r.az, yaw: 0 });
    }
  }

  /** Arahkan figur pemain ke layangannya */
  aimPlayer(id, kx, kz, dt) {
    const p = this.players.get(id);
    if (!p) return;
    const target = Math.atan2(kx - p.ax, kz - p.az);
    let d = target - p.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    p.yaw += d * Math.min(1, dt * 6);
    p.fig.rotation.y = p.yaw;
    // tangan (offset 0.47 ke depan) tepat di jangkar benang
    p.fig.position.x = p.ax - Math.sin(p.yaw) * 0.47;
    p.fig.position.z = p.az - Math.cos(p.yaw) * 0.47;
  }

  update(dt, camera, wind) {
    this.time += dt;
    this.zoneMat.uniforms.uTime.value = this.time;
    const wx = Math.cos(wind.angle), wz = Math.sin(wind.angle);
    for (const c of this.clouds) {
      c.position.x += wx * wind.speed * 0.25 * dt;
      c.position.z += wz * wind.speed * 0.25 * dt;
      if (Math.hypot(c.position.x, c.position.z) > 1600) { c.position.x *= -0.95; c.position.z *= -0.95; }
    }
    // sun shadow follows camera
    if (this.quality.shadows) {
      const t = camera.position;
      this.sun.target.position.set(t.x, 0, t.z);
      this.sun.position.set(t.x, 0, t.z).addScaledVector(this.sunDir, 300);
    }
    // wind streaks around camera
    const arr = this.windLines.geometry.attributes.position.array;
    const B = 90, sp = wind.speed * 2.2;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (let i = 0; i < this.windN; i++) {
      const s = this.windSeeds;
      const phase = (this.time * sp * (0.7 + s[i * 3] * 0.6) / (B * 2) + s[i * 3 + 1]) % 1;
      const along = (phase - 0.5) * B * 2;
      const side = (s[i * 3 + 2] - 0.5) * B * 2;
      const up = (s[(i * 7) % (this.windN * 3)] - 0.5) * 60;
      const bx = cx + wx * along - wz * side;
      const bz = cz + wz * along + wx * side;
      const by = Math.max(4, cy + up);
      const len = 2.5 + s[i * 3] * 3;
      arr.set([bx, by, bz, bx + wx * len, by, bz + wz * len], i * 6);
    }
    this.windLines.geometry.attributes.position.needsUpdate = true;
  }
}

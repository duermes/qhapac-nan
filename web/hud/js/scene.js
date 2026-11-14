// Ñawi 3D world: local MOLA terrain (bilinear, 1:1 vertical), astronaut, route, POI markers.
import * as THREE from "three";
import { ASSET_REGISTRY } from "/static/shared/js/icons.js";

const WINDOW_M = 3200;  // local terrain window around the start point
const SEG = 160;

export class EvaScene {
  constructor(container, region, origin) {
    this.el = container;
    this.region = region;
    this.origin = origin;  // {lat, lon}
    const lat0 = origin.lat * Math.PI / 180;
    this.mPerDegLat = 3396000 * Math.PI / 180;
    this.mPerDegLon = this.mPerDegLat * Math.cos(lat0);
    this.z0 = region.elevationAt(origin.lat, origin.lon) ?? 0;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xc98a5a);
    this.scene.fog = new THREE.Fog(0xc4875a, 400, 2600);
    const w = container.clientWidth || 1000, h = container.clientHeight || 700;
    this.camera = new THREE.PerspectiveCamera(62, w / h, 0.1, 8000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);
    this.sun = new THREE.DirectionalLight(0xffe2c0, 1.7);
    this.sun.position.set(600, 900, 300);
    this.scene.add(this.sun, new THREE.HemisphereLight(0xe0a070, 0x3a1e10, 0.7));
    this.buildSky();
    this.buildTerrain();
    this.buildRocks();
    this.astronaut = this.buildAstronaut();
    this.scene.add(this.astronaut);
    this.markers = [];
    this.labelLayer = document.createElement("div");
    this.labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    container.appendChild(this.labelLayer);
    this.cameraMode = "third";
    this.yaw = 0; this.pitch = -0.15;
    new ResizeObserver(() => this.resize()).observe(container);
    this.bindLook();
  }

  toLocal(lat, lon) { return { x: (lon - this.origin.lon) * this.mPerDegLon, z: -(lat - this.origin.lat) * this.mPerDegLat }; }
  toLatLon(x, z) { return { lat: this.origin.lat - z / this.mPerDegLat, lon: this.origin.lon + x / this.mPerDegLon }; }
  groundY(x, z) { const ll = this.toLatLon(x, z); const e = this.region.elevationAt(ll.lat, ll.lon); return e == null ? 0 : e - this.z0; }

  buildSky() {
    const geo = new THREE.SphereGeometry(6000, 32, 16);
    const mat = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: "varying vec3 vP; void main(){ float h = clamp(vP.y*1.6,0.0,1.0); vec3 low=vec3(0.80,0.55,0.38); vec3 high=vec3(0.35,0.20,0.16); gl_FragColor=vec4(mix(low,high,h),1.0);}" });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  buildTerrain() {
    const geo = new THREE.PlaneGeometry(WINDOW_M, WINDOW_M, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = [];
    for (let i = 0; i < pos.count; i++) {
      const y = this.groundY(pos.getX(i), pos.getZ(i));
      pos.setY(i, y);
      const n = Math.sin(pos.getX(i) * 0.05) * Math.cos(pos.getZ(i) * 0.04) * 0.04;
      colors.push(0.62 + n, 0.36 + n * 0.6, 0.24 + n * 0.4);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: false }));
    this.scene.add(this.terrain);
  }

  buildRocks() {
    // Decorative boulders (NOT derived from data; declared in Help).
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const mat = new THREE.MeshStandardMaterial({ color: 0x6b3d28, roughness: 1, flatShading: true });
    for (let i = 0; i < 140; i++) {
      const x = (rnd() - 0.5) * WINDOW_M * 0.8, z = (rnd() - 0.5) * WINDOW_M * 0.8;
      if (Math.hypot(x, z) < 12) continue;
      const s = 0.4 + rnd() ** 3 * 4;
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), mat);
      m.position.set(x, this.groundY(x, z) + s * 0.3, z);
      m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      m.scale.y = 0.6 + rnd() * 0.5;
      m.userData.decorative = true;
      this.scene.add(m);
    }
  }

  buildAstronaut() {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xeef2f5, roughness: 0.6 });
    const teal = new THREE.MeshStandardMaterial({ color: 0x36c4c9, roughness: 0.5 });
    const box = (w, h, d, m, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); g.add(b); return b; };
    box(0.55, 0.7, 0.35, white, 0, 1.15, 0);              // torso
    box(0.45, 0.55, 0.25, white, 0, 1.2, 0.3);            // PLSS backpack
    box(0.18, 0.75, 0.2, white, -0.14, 0.4, 0); box(0.18, 0.75, 0.2, white, 0.14, 0.4, 0);   // legs
    box(0.22, 0.1, 0.32, teal, -0.14, 0.05, -0.04); box(0.22, 0.1, 0.32, teal, 0.14, 0.05, -0.04);
    box(0.14, 0.6, 0.16, white, -0.38, 1.15, 0); box(0.14, 0.6, 0.16, white, 0.38, 1.15, 0);   // arms
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.24, 20, 14), white); helmet.position.set(0, 1.7, 0); g.add(helmet);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 14, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0x0c2a12, emissive: 0x0a3d14, roughness: 0.2, metalness: 0.4 }));
    visor.position.set(0, 1.71, -0.08); visor.rotation.y = Math.PI; g.add(visor);
    return g;
  }

  setRoute(points) {
    if (this.routeLine) { this.scene.remove(this.routeLine); this.routeLine.geometry.dispose(); }
    if (!points?.length) return;
    const pts = points.map((p) => { const l = this.toLocal(p.lat, p.lon); return new THREE.Vector3(l.x, this.groundY(l.x, l.z) + 0.15, l.z); });
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, Math.max(16, pts.length * 4), 0.09, 5, false);
    this.routeLine = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3fd0d8, transparent: true, opacity: 0.85 }));
    this.scene.add(this.routeLine);
  }

  setMarkers(entities, iconFn) {
    this.labelLayer.innerHTML = "";
    this.markers.forEach((m) => m.obj && this.scene.remove(m.obj));
    this.markers = entities.map((e) => {
      const reg = ASSET_REGISTRY[e.kind] || ASSET_REGISTRY.poi;
      const l = this.toLocal(e.lat, e.lon);
      const y = this.groundY(l.x, l.z);
      let obj = null;
      if (e.kind === "rover") {
        obj = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.4, 5), new THREE.MeshStandardMaterial({ color: 0x3fb8c4 }));
        body.position.y = 1.4; obj.add(body);
        [[-1.6, 1.7], [1.6, 1.7], [-1.6, -1.7], [1.6, -1.7]].forEach(([x, z]) => { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.5, 14), new THREE.MeshStandardMaterial({ color: 0x222 })); w.rotation.z = Math.PI / 2; w.position.set(x, 0.6, z); obj.add(w); });
      } else if (e.kind === "base" || e.kind === "habitat") {
        obj = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 4, 24, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0xd9d2c3 }));
        obj.rotation.z = Math.PI / 2; obj.rotation.y = Math.PI / 2;
      } else if (e.kind === "antenna") {
        obj = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 8, 8), new THREE.MeshStandardMaterial({ color: 0xbbbbbb }));
        obj.position.y = 4;
      } else if (e.kind === "astronaut") {
        obj = this.buildAstronaut();
      }
      if (obj) { obj.position.x = l.x; obj.position.z = l.z; obj.position.y += y; this.scene.add(obj); }
      const el = document.createElement("div");
      el.className = "poi-label";
      el.innerHTML = `<div class="ring" style="border-color:${reg.color};color:${reg.color}">${iconFn(reg.icon)}</div><div class="tag">${e.name.length > 22 ? e.name.slice(0, 21) + "…" : e.name}</div>`;
      this.labelLayer.appendChild(el);
      return { e, el, obj, pos: new THREE.Vector3(l.x, y + (obj ? 6 : 2.5), l.z) };
    });
  }

  bindLook() {
    let down = null;
    const c = this.renderer.domElement;
    c.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; c.setPointerCapture(e.pointerId); });
    c.addEventListener("pointermove", (e) => {
      if (!down) return;
      this.yaw = down.yaw - (e.clientX - down.x) * 0.005;
      this.pitch = Math.max(-0.9, Math.min(0.5, down.pitch - (e.clientY - down.y) * 0.004));
    });
    c.addEventListener("pointerup", () => { down = null; });
  }

  /** yaw 0 = looking north (-z); heading in degrees clockwise from north */
  heading() { return ((-this.yaw * 180 / Math.PI) % 360 + 360) % 360; }

  update(x, z) {
    const y = this.groundY(x, z);
    const a = this.astronaut;
    a.position.set(x, y, z);
    a.rotation.y = this.yaw;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    if (this.cameraMode === "first") {
      a.visible = false;
      this.camera.position.set(x, y + 1.7, z);
    } else {
      a.visible = true;
      const back = fwd.clone().multiplyScalar(-5.5);
      this.camera.position.set(x + back.x + 1.2, y + 2.6, z + back.z);
    }
    const look = new THREE.Vector3(x, y + 1.6, z).add(fwd.clone().multiplyScalar(20)).add(new THREE.Vector3(0, Math.tan(this.pitch) * 20, 0));
    this.camera.lookAt(look);
    this.renderer.render(this.scene, this.camera);
    const w = this.el.clientWidth, h = this.el.clientHeight;
    for (const m of this.markers) {
      const v = m.pos.clone().project(this.camera);
      const dist = m.pos.distanceTo(a.position);
      const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && dist < 2500 && !m.hidden;
      m.el.style.display = vis ? "" : "none";
      if (vis) {
        m.el.style.left = `${(v.x + 1) / 2 * w}px`;
        m.el.style.top = `${(1 - v.y) / 2 * h}px`;
        m.el.style.opacity = String(Math.max(0.45, 1 - dist / 2500));
      }
    }
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}

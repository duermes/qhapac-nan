// 3D terrain view (Three.js, vendored). Terrain mesh from MOLA in isotropic
// tangent-plane metres; the 2D composite (relief + analytical layers) is draped
// as a "mantle" texture on the same mesh; contour lines come from a shader whose
// uniforms stay in sync with the camera distance.
import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";
import { ASSET_REGISTRY } from "./icons.js";

export class Map3D {
  constructor(container, region, opts = {}) {
    this.el = container;
    this.region = region;
    this.g = region.grid;
    this.opts = { exaggeration: 3, segStride: 2, ...opts };
    this.listeners = {};
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b100d);
    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    this.camera = new THREE.PerspectiveCamera(50, w / h, 10, 4e6);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 60;          // micro-scale zoom (~tens of metres)
    this.controls.maxDistance = Math.max(this.g.widthM(), this.g.heightM()) * 1.6;
    this.sunLight = new THREE.DirectionalLight(0xfff1dc, 1.6);
    this.scene.add(this.sunLight, new THREE.AmbientLight(0x6b5a4a, 0.75));
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "labels3d";
    this.labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    container.appendChild(this.labelLayer);
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);
    this.markers = [];
    this.buildTerrain();
    this.setSun(315, 35);
    this.resetCamera();
    this.raycaster = new THREE.Raycaster();
    this.bind();
    new ResizeObserver(() => this.resize()).observe(container);
    this.running = true;
    const loop = () => { if (!this.running) return; requestAnimationFrame(loop); this.frame(); };
    loop();
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { (this.listeners[ev] || []).forEach((f) => f(...a)); }

  buildTerrain() {
    const e = this.region.elev, s = this.opts.segStride;
    const cols = Math.floor((e.cols - 1) / s) + 1, rows = Math.floor((e.rows - 1) / s) + 1;
    const W = this.g.widthM(), H = this.g.heightM();
    // horizontal projection: isotropic metres (east-west scaled by cos(lat) of the region centre)
    const geo = new THREE.PlaneGeometry(W, H, cols - 1, rows - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    this.zBase = this.region.stats.mean;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = e.data[(r * s) * e.cols + c * s];
        pos.setY(r * cols + c, (isFinite(v) ? v - this.zBase : 0) * this.opts.exaggeration);
      }
    }
    geo.computeVertexNormals();
    this.mantleCanvas = document.createElement("canvas");
    this.mantleCanvas.width = 1024; this.mantleCanvas.height = Math.round(1024 * e.rows / e.cols);
    this.texture = new THREE.CanvasTexture(this.mantleCanvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.95, metalness: 0 });
    this.uniforms = { uContourInterval: { value: 100 }, uContourWidth: { value: 1.0 }, uExag: { value: this.opts.exaggeration },
      uZBase: { value: this.zBase }, uContourColor: { value: new THREE.Color(0xf3ebdc) }, uContours: { value: 1 } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying float vElev;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvElev = position.y;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
        varying float vElev; uniform float uContourInterval; uniform float uContourWidth; uniform float uExag;
        uniform float uZBase; uniform vec3 uContourColor; uniform float uContours;`)
        .replace("#include <dithering_fragment>", `#include <dithering_fragment>
        if (uContours > 0.5) {
          float z = vElev / uExag + uZBase;
          float f = abs(fract(z / uContourInterval + 0.5) - 0.5);
          float w = fwidth(z / uContourInterval) * uContourWidth;
          float line = 1.0 - smoothstep(0.0, w, f);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uContourColor, line * 0.45);
        }`);
    };
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);   // mesh and mantle coexist on the same geometry
    this.mesh.name = "terrain-mesh";
    this.scene.add(this.mesh);
  }

  /** Copy the 2D composite onto the 3D mantle (layers draped over relief). */
  drape(sourceCanvas) {
    const ctx = this.mantleCanvas.getContext("2d");
    ctx.clearRect(0, 0, this.mantleCanvas.width, this.mantleCanvas.height);
    ctx.drawImage(sourceCanvas, 0, 0, this.mantleCanvas.width, this.mantleCanvas.height);
    this.texture.needsUpdate = true;
  }

  heightAt(lat, lon) {
    const e = this.region.elevationAt(lat, lon);
    return e == null ? 0 : (e - this.zBase) * this.opts.exaggeration;
  }

  toWorld(lat, lon, lift = 0) {
    const { x, z } = this.g.toXZ(lat, lon);
    return new THREE.Vector3(x, this.heightAt(lat, lon) + lift, z);
  }

  setSun(azDeg, elDeg) {
    // same convention as 2D hillshade: x east, z south, y up
    const az = azDeg * Math.PI / 180, el = Math.max(1, elDeg) * Math.PI / 180;
    const d = Math.max(this.g.widthM(), this.g.heightM());
    this.sunLight.position.set(Math.cos(el) * Math.sin(az) * d, Math.sin(el) * d, -Math.cos(el) * Math.cos(az) * d);
    this.sunLight.intensity = elDeg > 0 ? 1.6 : 0.25;
    this.sun = { az: azDeg, el: elDeg };
  }

  resetCamera() {
    const d = Math.max(this.g.widthM(), this.g.heightM());
    this.camera.position.set(0, d * 0.55, d * 0.65);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  focusOn(lat, lon, distance = 12000) {
    const p = this.toWorld(lat, lon);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(p);
    this.camera.position.copy(p.clone().add(dir.multiplyScalar(distance)));
    this.controls.update();
  }

  setRoutes(routes) {
    this.overlay.children.filter((o) => o.userData.route).forEach((o) => {
      this.overlay.remove(o);
      if (!o.isSprite) o.geometry.dispose();
      o.material.map?.dispose();
      o.material.dispose();
    });
    const colors = { safe: 0x65d8ff, caution: 0x65d8ff, no_return: 0xff8c36 };
    for (const route of routes) {
      if (route.visible === false || route.points?.length < 2) continue;
      const lift = 25 * this.opts.exaggeration;
      const points = route.points.map((p) => this.toWorld(p.lat, p.lon, lift));
      const material = { depthTest: false, color: route.color || "#65d8ff" };
      const tag = (obj) => {
        obj.renderOrder = 10;
        obj.userData.route = route.id || true;
        this.overlay.add(obj);
      };
      if (route.segments?.length) {
        const runs = new Map();
        for (const { from, to, state } of route.segments) {
          if (!points[from] || !points[to]) continue;
          const color = colors[state] || material.color;
          if (!runs.has(color)) runs.set(color, []);
          runs.get(color).push(points[from], points[to]);
        }
        for (const [color, segments] of runs) {
          tag(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segments),
            new THREE.LineBasicMaterial({ ...material, color })));
        }
      } else {
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geo, route.dash ? new THREE.LineDashedMaterial({
          ...material, dashSize: 90, gapSize: 60,
        }) : new THREE.LineBasicMaterial(material));
        if (route.dash) line.computeLineDistances();
        tag(line);
      }
      if (route.pnr) {
        const canvas = document.createElement("canvas");
        canvas.width = 128; canvas.height = 48;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#20160f"; ctx.fillRect(34, 5, 91, 38);
        ctx.fillStyle = "#ff9c61";
        ctx.beginPath(); ctx.moveTo(15, 7); ctx.lineTo(29, 38); ctx.lineTo(1, 38); ctx.fill();
        ctx.font = "bold 27px monospace"; ctx.fillText("PNR", 46, 33);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false, sizeAttenuation: false,
        }));
        sprite.position.copy(this.toWorld(route.pnr.lat, route.pnr.lon, lift));
        sprite.center.set(0.12, 0.5); sprite.scale.set(0.048, 0.018, 1);
        tag(sprite);
      }
    }
  }

  setHazards(hazards) {
    this.overlay.children.filter((o) => o.userData.hazard).forEach((o) => this.overlay.remove(o));
    for (const h of hazards) {
      const forb = h.tier === "forbidden" || h.tier === 3;
      const seg = 64, pts = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const dLat = (h.radius_m * Math.cos(a)) / this.g.dy / this.g.pixels_per_degree;
        const dLon = (h.radius_m * Math.sin(a)) / this.g.dxAt(h.lat) / this.g.pixels_per_degree;
        pts.push(this.toWorld(h.lat + dLat, h.lon + dLon, 15 * this.opts.exaggeration)); // projected onto relief
      }
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: forb ? 0xe0534a : 0xe8a33d, depthTest: false, transparent: true }));
      ring.renderOrder = 9;
      ring.userData.hazard = h.id;
      this.overlay.add(ring);
    }
  }

  setMarkers(entities, hidden = new Set()) {
    this.labelLayer.innerHTML = "";
    this.markers = entities.filter((e) => !hidden.has(e.kind)).map((e) => {
      const reg = ASSET_REGISTRY[e.kind] || ASSET_REGISTRY.waypoint;
      const el = document.createElement("div");
      el.className = `m3d m3d-${e.kind}`;
      el.style.cssText = `position:absolute;transform:translate(-50%,-100%);font:500 11px 'Chakra Petch';color:#f3ebdc;white-space:nowrap;text-align:center`;
      el.innerHTML = `<div class="m3d-label" style="background:rgba(16,22,18,.82);border:1px solid rgba(223,189,128,.25);padding:2px 6px"></div><div style="width:9px;height:9px;margin:2px auto 0;border:2px solid ${reg.color};border-radius:${["poi", "sample", "rover", "astronaut", "antenna"].includes(e.kind) ? "50%" : "0"};background:#0b100d"></div>`;
      el.querySelector(".m3d-label").textContent = e.name;
      this.labelLayer.appendChild(el);
      return { e, el, rank: e.kind === "base" ? 0 : ["poi", "rover"].includes(e.kind) ? 1 : 2 };
    });
  }

  /** Semantic LOD (3 levels) + magnification factor with camera distance. */
  labelLOD(distance) {
    const D = Math.max(this.g.widthM(), this.g.heightM());
    if (distance > D * 0.6) return 0;
    if (distance > D * 0.15) return 1;
    return 2;
  }

  magnification(distance) {
    const D = Math.max(this.g.widthM(), this.g.heightM());
    return Math.min(1.35, Math.max(0.75, 1.25 - Math.log10(Math.max(1, distance / (D * 0.05))) * 0.35));
  }

  frame() {
    this.controls.update();
    const dist = this.camera.position.distanceTo(this.controls.target);
    // contour interval/width synced with zoom (same perceptual width as 2D)
    const iv = dist > 150000 ? 250 : dist > 50000 ? 100 : dist > 15000 ? 50 : 25;
    this.uniforms.uContourInterval.value = iv;
    this.uniforms.uContourWidth.value = 1.0;
    this.renderer.render(this.scene, this.camera);
    const lod = this.labelLOD(dist), mag = this.magnification(dist);
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const placed = [];
    const order = [...this.markers].sort((a, b) => a.rank - b.rank);
    for (const m of order) {
      const v = this.toWorld(m.e.lat, m.e.lon, 30).project(this.camera);
      let vis = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 && m.rank <= lod;
      const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
      if (vis) {
        // greedy collision avoidance: higher-priority labels win
        const lw = (m.lw ||= Math.min(220, 8 + m.e.name.length * 6.2)) * mag, lh = 30 * mag;
        const r = { x: x - lw / 2, y: y - lh, w: lw, h: lh };
        if (placed.some((q) => !(r.x + r.w < q.x || q.x + q.w < r.x || r.y + r.h < q.y || q.y + q.h < r.y))) vis = false;
        else placed.push(r);
      }
      m.el.style.display = vis ? "" : "none";
      if (vis) {
        m.el.style.left = `${x}px`;
        m.el.style.top = `${y}px`;
        m.el.style.scale = String(mag);
      }
    }
    this.emit("frame", { distance: dist, lod, mag, interval: iv });
  }

  metersPerPixel() {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const h = this.el.clientHeight || 600;
    return (2 * dist * Math.tan((this.camera.fov * Math.PI / 180) / 2)) / h;
  }

  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh)[0];
    if (!hit) return null;
    return this.g.fromXZ(hit.point.x, hit.point.z);
  }

  bind() {
    let down = null;
    const c = this.renderer.domElement;
    c.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
    c.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
        const bounds = c.getBoundingClientRect();
        const screen = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
        const hit = this.markers?.find(({ el }) => {
          const r = el.getBoundingClientRect();
          return !el.hidden && el.style.display !== "none" && r.width > 0 &&
            e.clientX >= r.left - 5 && e.clientX <= r.right + 5 &&
            e.clientY >= r.top - 5 && e.clientY <= r.bottom + 5;
        })?.e;
        const ll = hit || this.pick(e.clientX, e.clientY);
        if (ll) this.emit("click", ll, hit, screen);
      }
      down = null;
    });
    c.addEventListener("pointermove", (e) => { const ll = this.pick(e.clientX, e.clientY); if (ll) this.emit("hover", ll); });
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose() {
    this.running = false;
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }
}

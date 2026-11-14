import * as THREE from "three";
import { ASSET_REGISTRY } from "/static/shared/js/icons.js";
import { Terrain3D } from "./world.js";
import { CharacterController } from "./character.js";

export class EvaScene {
  constructor(container, region, origin) {
    this.el = container;
    this.region = region;
    this.origin = origin;
    this.mPerDegLat = 3396000 * Math.PI / 180;
    this.mPerDegLon = this.mPerDegLat * Math.cos(origin.lat * Math.PI / 180);
    this.z0 = region.elevationAt(origin.lat, origin.lon) ?? 0;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xc98a5a);
    this.scene.fog = new THREE.Fog(0xc4875a, 180, 2200);
    this.camera = new THREE.PerspectiveCamera(65, container.clientWidth / container.clientHeight, 0.1, 8000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.buildSky();
    this.world = new Terrain3D(this.scene, this.camera, "JEZERO_MARS", (x, z) => this.molaY(x, z));
    this.buildRegionalTerrain();
    this.onRecharge = () => {};
    this.onCollect = () => {};
    this.character = new CharacterController(this.scene, this.camera, this.world, {
      update() {}, updateDistanceToBase() {},
      rechargeAtBase: () => this.onRecharge(), collectSample: () => this.onCollect()
    });
    this.astronaut = this.character.astronautMesh;
    this.character.cameraManaged = true;
    this.cameraSnap = true;
    this.lookTarget = null;
    this.cameraTargetPosition = new THREE.Vector3();
    this.cameraLookPoint = new THREE.Vector3();
    this.cameraTargetRotation = new THREE.Quaternion();
    this.cameraMatrix = new THREE.Matrix4();
    this.markers = [];
    this.labelLayer = document.createElement("div");
    this.labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    container.appendChild(this.labelLayer);
    this.routeGroup = new THREE.Group();
    this.scene.add(this.routeGroup);
    new ResizeObserver(() => this.resize()).observe(container);
    this.bindLook();
  }

  toLocal(lat, lon) {
    return { x: (lon - this.origin.lon) * this.mPerDegLon - 65, z: -(lat - this.origin.lat) * this.mPerDegLat - 60 };
  }

  toLatLon(x, z) {
    return { lat: this.origin.lat - (z + 60) / this.mPerDegLat, lon: this.origin.lon + (x + 65) / this.mPerDegLon };
  }

  molaY(x, z) {
    const ll = this.toLatLon(x, z);
    return (this.region.elevationAt(ll.lat, ll.lon) ?? this.z0) - this.z0;
  }

  groundY(x, z) {
    return Math.max(Math.abs(x), Math.abs(z)) <= this.world.gridSize / 2 ? this.world.getSmoothHeightAt(x, z) : this.molaY(x, z);
  }

  surfaceElevation(x, z) { return this.z0 + this.groundY(x, z); }
  get yaw() { return this.character.bodyHeading - Math.PI; }
  set yaw(value) { this.character.bodyHeading = value + Math.PI; }
  get pitch() { return this.character.helmetPitch; }
  set pitch(value) { this.character.helmetPitch = value; }
  get cameraMode() { return this.character.isFirstPerson ? "first" : "third"; }
  set cameraMode(value) { this.character.isFirstPerson = value === "first"; this.cameraSnap = true; }
  heading() { return ((-this.yaw * 180 / Math.PI) % 360 + 360) % 360; }

  buildSky() {
    const geo = new THREE.SphereGeometry(6000, 32, 16);
    const mat = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: "varying vec3 vP; void main(){vP=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: "varying vec3 vP;void main(){float h=clamp(vP.y*1.6,0.0,1.0);gl_FragColor=vec4(mix(vec3(.80,.55,.38),vec3(.35,.20,.16),h),1.0);}" });
    this.sky = new THREE.Mesh(geo, mat);
    this.scene.add(this.sky);
  }

  buildRegionalTerrain() {
    const geo = new THREE.PlaneGeometry(4800, 4800, 240, 240);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.molaY(pos.getX(i), pos.getZ(i)) - 0.2);
    const indices = [];
    for (let i = 0; i < geo.index.count; i += 3) {
      const triangle = [geo.index.getX(i), geo.index.getX(i + 1), geo.index.getX(i + 2)];
      if (!triangle.every(v => Math.max(Math.abs(pos.getX(v)), Math.abs(pos.getZ(v))) <= this.world.gridSize / 2)) indices.push(...triangle);
    }
    geo.setIndex(indices);
    geo.computeVertexNormals();
    this.regionalTerrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8b4830, roughness: 1 }));
    this.scene.add(this.regionalTerrain);
  }

  localEntities() {
    const kinds = { base: "base", rover: "rover", astronaut: "astronaut", crew: "astronaut", science: "poi", antenna: "antenna" };
    const entries = this.world.pois.map((p, i) => ({
      id: i === 0 ? "BASE_ALFA" : `EVA_POI_${i}`,
      name: p.name, description: p.description, kind: i === 0 ? "base" : p.tag === "COMMS" ? "antenna" : kinds[p.type] === "base" ? "landmark" : kinds[p.type] || "landmark",
      ...this.toLatLon(p.x, p.z), x: p.x, z: p.z, provenance: "synthetic"
    }));
    for (const s of this.world.collectibleSamples) entries.push({ id: s.id, kind: "sample", name: s.name, description: s.yield, ...this.toLatLon(s.x, s.z), x: s.x, z: s.z, provenance: "synthetic" });
    return entries;
  }

  setMarkers(entities, iconFn) {
    this.labelLayer.replaceChildren();
    this.markers = entities.map(e => {
      const reg = ASSET_REGISTRY[e.kind] || ASSET_REGISTRY.poi;
      const l = this.toLocal(e.lat, e.lon);
      const el = document.createElement("div");
      el.className = "poi-label";
      el.innerHTML = `<div class="ring" style="border-color:${reg.color};color:${reg.color}">${iconFn(reg.icon)}</div>`;
      this.labelLayer.appendChild(el);
      return { e, el, pos: new THREE.Vector3(l.x, this.groundY(l.x, l.z) + (e.kind === "sample" ? 1.5 : 5), l.z) };
    });
  }

  setRoute(points, pnr = {}) {
    this.routeGroup.traverse(obj => { obj.geometry?.dispose(); obj.material?.dispose(); });
    this.routeGroup.clear();
    if (!points || points.length < 2) return;
    const expanded = [];
    for (let i = 1; i < points.length; i++) {
      const a = this.toLocal(points[i - 1].lat, points[i - 1].lon), b = this.toLocal(points[i].lat, points[i].lon);
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2));
      for (let j = i === 1 ? 0 : 1; j <= steps; j++) {
        const x = a.x + (b.x - a.x) * j / steps, z = a.z + (b.z - a.z) * j / steps;
        expanded.push({ point: new THREE.Vector3(x, this.groundY(x, z) + 0.35, z), segment: i - 1 });
      }
    }
    for (const state of ["safe", "caution", "no_return"]) {
      const positions = [];
      for (let i = 1; i < expanded.length; i++) {
        if ((pnr.segments?.[expanded[i].segment]?.state || "safe") === state) positions.push(expanded[i - 1].point, expanded[i].point);
      }
      if (positions.length) this.routeGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(positions), new THREE.LineBasicMaterial({ color: state === "safe" ? 0x00e5ff : 0xff8c00 })));
    }
    if (pnr.show_pnr && pnr.pnr_point) {
      const l = this.toLocal(pnr.pnr_point.lat, pnr.pnr_point.lon);
      const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(1.2), new THREE.MeshBasicMaterial({ color: 0xffb300 }));
      beacon.position.set(l.x, this.groundY(l.x, l.z) + 2, l.z);
      this.routeGroup.add(beacon);
    }
    this.routeGroup.visible = this.character.isFirstPerson && !this.character.isInsideBase;
  }

  move(dt, keys, stopped = false, stamina = 100, controlDt = dt) {
    const c = this.character;
    c.keys = { forward: !stopped && keys.has("fwd"), backward: !stopped && keys.has("back"), left: keys.has("left"), right: keys.has("right") };
    c.baseSpeed = 1.4 * Math.max(0.35, Math.min(1, stamina / 35));
    const before = c.position.clone();
    if (keys.has("left") || keys.has("right")) this.lookTarget = null;
    c.update(dt, controlDt);
    const distance = Math.hypot(c.position.x - before.x, c.position.z - before.z);
    this.routeGroup.visible = c.isFirstPerson && !c.isInsideBase;
    this.regionalTerrain.visible = !c.isInsideBase;
    this.sky.visible = !c.isInsideBase;
    return { x: c.position.x, z: c.position.z, distance, speed: distance / Math.max(dt, 0.001), gradient: distance > 0.001 && !c.isInsideBase ? (c.position.y - before.y) / distance : 0 };
  }

  updateMissionMonitor(vitals, samples) {
    const ctx = this.world.monitorCanvas.getContext("2d");
    ctx.fillStyle = "#101612";
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = "#b96f49";
    ctx.strokeRect(8, 8, 496, 240);
    ctx.fillStyle = "#dfbd80";
    ctx.font = "bold 20px monospace";
    ctx.fillText("HATUN WASI · BASE ALFA", 24, 43);
    ctx.fillStyle = "#f3ebdc";
    ctx.font = "14px monospace";
    const lines = ["SIMULACIÓN DE ENTRENAMIENTO EVA", "Hábitat presurizado · traje conectado", `Oxígeno ${(vitals.o2_kg / 1.2 * 100).toFixed(1)}% · batería ${(vitals.battery_wh / 1100 * 100).toFixed(1)}%`, `Estamina ${vitals.effort.staminaPct.toFixed(0)}% · muestras ${samples}/16`, "[E] Consultar misión · [F] Salir por esclusa"];
    lines.forEach((line, i) => ctx.fillText(line, 24, 82 + i * 32));
    this.world.monitorTexture.needsUpdate = true;
  }

  bindLook() {
    let down = null;
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", e => { down = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; this.lookTarget = { yaw: this.yaw, pitch: this.pitch }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", e => {
      if (!down) return;
      this.lookTarget = { yaw: down.yaw - (e.clientX - down.x) * 0.0016, pitch: Math.max(-0.6, Math.min(0.5, down.pitch - (e.clientY - down.y) * 0.0014)) };
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(event, () => { down = null; });
  }

  update(x, z, dt = 0.016) {
    if (this.lookTarget) {
      const alpha = 1 - Math.exp(-12 * dt);
      this.yaw += (this.lookTarget.yaw - this.yaw) * alpha;
      this.pitch += (this.lookTarget.pitch - this.pitch) * alpha;
    }
    this.character.updatePosition(x, z);
    this.updateCamera(dt);
    this.world.updateDust(dt);
    const inside = this.character.isInsideBase;
    this.scene.fog = inside ? null : this.scene.fog || new THREE.Fog(0xc4875a, 180, 2200);
    this.renderer.render(this.scene, this.camera);
    const w = this.el.clientWidth, h = this.el.clientHeight;
    for (const m of this.markers) {
      const v = m.pos.clone().project(this.camera);
      const dist = m.pos.distanceTo(this.character.position);
      const visible = this.character.isFirstPerson && !inside && !m.hidden && !m.collected && v.z > -1 && v.z < 1 && Math.abs(v.x) < 0.94 && Math.abs(v.y) < 0.9 && dist < 1800;
      m.el.hidden = !visible;
      if (visible) { m.el.style.left = `${(v.x + 1) / 2 * w}px`; m.el.style.top = `${(1 - v.y) / 2 * h}px`; }
    }
  }

  updateCamera(dt) {
    const c = this.character, p = c.position;
    const heading = c.bodyHeading + c.helmetYawOffset;
    if (c.isFirstPerson) {
      this.cameraTargetPosition.set(p.x, p.y + 2.15, p.z);
      this.cameraLookPoint.set(p.x + Math.sin(heading) * 20, p.y + 2.15 + Math.sin(c.helmetPitch) * 20, p.z + Math.cos(heading) * 20);
    } else {
      this.positionExternalCamera(c);
      this.cameraLookPoint.set(p.x, p.y + 1.65, p.z);
    }
    const snap = this.cameraSnap || this.camera.position.distanceTo(this.cameraTargetPosition) > 40;
    const alpha = snap ? 1 : 1 - Math.exp(-10 * dt);
    this.camera.position.lerp(this.cameraTargetPosition, alpha);
    this.cameraMatrix.lookAt(this.camera.position, this.cameraLookPoint, this.camera.up);
    this.cameraTargetRotation.setFromRotationMatrix(this.cameraMatrix);
    this.camera.quaternion.slerp(this.cameraTargetRotation, snap ? 1 : 1 - Math.exp(-12 * dt));
    this.cameraSnap = false;
  }

  positionExternalCamera(character) {
    const { position: p, bodyHeading, isInsideBase } = character;
    const camera = this.cameraTargetPosition;
    // Find a clear angle when the nominal follow camera falls behind solid geometry.
    const offsets = [0, 0.52, -0.52, 1.05, -1.05, 1.57, -1.57, Math.PI];
    for (const distance of [6.8, 4.5, 2.8]) {
      for (const offset of offsets) {
        const angle = bodyHeading + offset;
        const x = p.x - Math.sin(angle) * distance;
        const z = p.z - Math.cos(angle) * distance;
        if (isInsideBase) {
          const { x: bx, z: bz } = this.world.baseCoord;
          if (Math.hypot(x - bx, z - bz) > 9.2) continue;
          camera.set(x, p.y + 2.9, z);
        } else {
          if (this.world.pathBlocked(p.x, p.z, x, z, 0.45)) continue;
          camera.set(x, Math.max(p.y + 3.35, this.groundY(x, z) + 1.4), z);
        }
        return;
      }
    }
    camera.set(p.x, p.y + (isInsideBase ? 3.5 : 5.5), p.z + 0.1);
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}

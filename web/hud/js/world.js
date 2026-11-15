import { translate } from "/static/shared/js/language.js";
import * as THREE from "three";
import { AssetRegistry, HUD_MANIFEST } from "./world-assets.js";
export class Terrain3D {
    constructor(scene, camera, presetKey = 'JEZERO_MARS', surfaceSampler = () => 0) {
        this.scene = scene;
        this.surfaceSampler = surfaceSampler;
        this.seed = 713;
        this.camera = camera;
        this.presetKey = presetKey;
        this.preset = AssetRegistry.getHudPreset(presetKey);
        this.gridSize = 360;
        this.segments = 180;
        this.heightData = new Float32Array((this.segments + 1) * (this.segments + 1));
        this.colliders = [];
        this.collectibleSamples = [];
        this.pois = [];
        this.companions = [];
        this.companionTime = 0;
        this.routeGroup = new THREE.Group();
        this.scene.add(this.routeGroup);
        this.baseCoord = { x: -65, z: -60, name: "Base Alfa Jezero", type: "base" };
        this.targetCoord = { x: 35, z: 25, name: "Afloramiento Carbonatos Delta", type: "biofirma" };
        this.isInsideBase = false;
        this.baseInteriorGroup = new THREE.Group();
        this.baseInteriorGroup.visible = false;
        this.scene.add(this.baseInteriorGroup);
        this.initTerrain();
        this.initAtmosphereAndLighting();
        this.initIrregularRocksWithColliders();
        this.initMineralSamples();
        this.initColonyAssets();
        this.initBaseHabitatInterior();
        this.initDustParticles();
        this.prepareSamples();
    }
    random() {
        this.seed = this.seed * 16807 % 2147483647;
        return this.seed / 2147483647;
    }
    prepareSamples() {
        this.collectibleSamples.forEach((sample, index) => {
            if (index === 0) {
                sample.x = -53;
                sample.z = -42;
            }
            for (let attempt = 0; attempt < 100; attempt++) {
                const blocked = this.colliders.some(c => Math.hypot(sample.x - c.x, sample.z - c.z) < c.radius + 2.5);
                if (!blocked)
                    break;
                sample.x = (this.random() - 0.5) * 250;
                sample.z = (this.random() - 0.5) * 250;
            }
            sample.id = 'EVA_SAMPLE_' + String(index + 1).padStart(2, '0');
            sample.y = this.getSmoothHeightAt(sample.x, sample.z) + 0.35;
            sample.mesh.position.set(sample.x, sample.y, sample.z);
            sample.light.position.set(sample.x, sample.y + 0.5, sample.z);
        });
    }
    createMultiLayerMarsTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 1024;
        const ctx = canvas.getContext('2d');
        const tConfig = (this.preset && this.preset.terrain) ? this.preset.terrain : {
            diffuseColor: '#9c422b',
            rippleColor: 'rgba(195, 105, 65, 0.45)',
            noiseSpread: 45
        };
        ctx.fillStyle = tConfig.diffuseColor;
        ctx.fillRect(0, 0, 1024, 1024);
        const imgData = ctx.getImageData(0, 0, 1024, 1024);
        const data = imgData.data;
        const spread = tConfig.noiseSpread || 45;
        for (let i = 0; i < data.length; i += 4) {
            const noise = (this.random() - 0.5) * spread;
            data[i] = Math.max(0, Math.min(255, data[i] + noise));
            data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise * 0.5));
            data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise * 0.3));
        }
        ctx.putImageData(imgData, 0, 0);
        ctx.strokeStyle = tConfig.rippleColor;
        ctx.lineWidth = 3.5;
        for (let y = -200; y < 1200; y += 18) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            for (let x = 0; x <= 1024; x += 32) {
                const wave = Math.sin(x * 0.02 + y * 0.05) * 8.0;
                ctx.lineTo(x, y + wave);
            }
            ctx.stroke();
        }
        for (let k = 0; k < 600; k++) {
            const x = this.random() * 1024;
            const y = this.random() * 1024;
            const r = 1.0 + this.random() * 3.5;
            if (this.random() > 0.4) {
                ctx.fillStyle = 'rgba(55, 25, 20, 0.7)';
            }
            else {
                ctx.fillStyle = 'rgba(175, 75, 40, 0.35)';
            }
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(48, 48);
        return tex;
    }
    initTerrain() {
        const geom = new THREE.PlaneGeometry(this.gridSize, this.gridSize, this.segments, this.segments);
        geom.rotateX(-Math.PI / 2);
        const pos = geom.attributes.position;
        const colors = [];
        const color = new THREE.Color();
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const z = pos.getZ(i);
            const distFromCenter = Math.hypot(x, z);
            const craterRim = Math.exp(-Math.pow((distFromCenter - 134) / 36.0, 2)) * 25.0;
            const dunes = Math.sin(x * 0.02) * Math.cos(z * 0.02) * 8.0;
            const ripples = Math.sin(x * 0.05 + z * 0.035) * 2.2 + Math.cos(x * 0.08 - z * 0.06) * 1.0;
            const valley = Math.sin(x * 0.015) * 4.5;
            const regional = this.surfaceSampler(x, z);
            const detail = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), 135, this.gridSize / 2);
            const escarpment = 23 * Math.exp(-(((x - 26) / 28) ** 2 + ((z + 115) / 12) ** 2));
            const basin = -15 * Math.exp(-(((x + 48) / 35) ** 2 + ((z - 60) / 25) ** 2));
            let y = regional + (craterRim + dunes + ripples + valley + escarpment + basin) * detail;
            const distBase = Math.hypot(x - this.baseCoord.x, z - this.baseCoord.z);
            if (distBase < 38.0) {
                const flattenFactor = 1 - THREE.MathUtils.smoothstep(distBase, 24, 38);
                y = y * (1.0 - flattenFactor) + (this.surfaceSampler(this.baseCoord.x, this.baseCoord.z) + 3.8) * flattenFactor;
            }
            const distStromatolite = Math.hypot(x - this.targetCoord.x, z - this.targetCoord.z);
            if (distStromatolite < 22.0) {
                const fStroma = Math.cos((distStromatolite / 22.0) * (Math.PI / 2));
                y = y * (1.0 - fStroma) + (this.surfaceSampler(this.targetCoord.x, this.targetCoord.z) + 4.5) * fStroma;
            }
            pos.setY(i, y);
            this.heightData[i] = y;
            if (y > 22.0) {
                color.setHSL(0.05, 0.78, 0.48);
            }
            else if (y > 8.0) {
                color.setHSL(0.062, 0.68, 0.38);
            }
            else if (y > 0.0) {
                color.setHSL(0.058, 0.58, 0.30);
            }
            else {
                color.setHSL(0.045, 0.48, 0.22);
            }
            colors.push(color.r, color.g, color.b);
        }
        geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geom.computeVertexNormals();
        const regolithTex = this.createMultiLayerMarsTexture();
        const mat = new THREE.MeshStandardMaterial({
            map: regolithTex,
            vertexColors: true,
            roughness: 0.9,
            metalness: 0.1,
        });
        this.terrainMesh = new THREE.Mesh(geom, mat);
        this.terrainMesh.receiveShadow = true;
        this.scene.add(this.terrainMesh);
    }
    getSmoothHeightAt(x, z) {
        const half = this.gridSize / 2;
        x = Math.max(-half, Math.min(half, x));
        z = Math.max(-half, Math.min(half, z));
        const u = ((x + half) / this.gridSize) * this.segments;
        const v = ((z + half) / this.gridSize) * this.segments;
        const c0 = Math.max(0, Math.min(this.segments - 1, Math.floor(u)));
        const c1 = Math.min(this.segments, c0 + 1);
        const r0 = Math.max(0, Math.min(this.segments - 1, Math.floor(v)));
        const r1 = Math.min(this.segments, r0 + 1);
        const fx = u - c0;
        const fz = v - r0;
        const stride = this.segments + 1;
        const h00 = this.heightData[r0 * stride + c0] || 0;
        const h10 = this.heightData[r0 * stride + c1] || 0;
        const h01 = this.heightData[r1 * stride + c0] || 0;
        const h11 = this.heightData[r1 * stride + c1] || 0;
        const top = h00 * (1 - fx) + h10 * fx;
        const btm = h01 * (1 - fx) + h11 * fx;
        return top * (1 - fz) + btm * fz;
    }
    initAtmosphereAndLighting() {
        const sky = (this.preset && this.preset.sky) ? this.preset.sky : {
            sunColor: 0xffecd2,
            sunIntensity: 1.45,
            fogColor: 0xd47551
        };
        this.sunLight = new THREE.DirectionalLight(sky.sunColor, sky.sunIntensity);
        this.sunLight.position.set(200, 180, -150);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 1.0;
        this.sunLight.shadow.camera.far = 600;
        const d = 220;
        this.sunLight.shadow.camera.left = -d;
        this.sunLight.shadow.camera.right = d;
        this.sunLight.shadow.camera.top = d;
        this.sunLight.shadow.camera.bottom = -d;
        this.scene.add(this.sunLight);
        this.ambientLight = new THREE.AmbientLight(sky.fogColor, 0.65);
        this.scene.add(this.ambientLight);
    }
    applySkin(presetKey) {
        if (HUD_MANIFEST.presets[presetKey]) {
            this.presetKey = presetKey;
            this.preset = AssetRegistry.getHudPreset(presetKey);
            if (this.terrainMesh && this.terrainMesh.material) {
                this.terrainMesh.material.map = this.createMultiLayerMarsTexture();
                this.terrainMesh.material.needsUpdate = true;
            }
            if (this.sunLight && this.preset.sky) {
                this.sunLight.color.setHex(this.preset.sky.sunColor);
                this.sunLight.intensity = this.preset.sky.sunIntensity;
            }
            if (this.ambientLight && this.preset.sky) {
                this.ambientLight.color.setHex(this.preset.sky.fogColor);
            }
        }
    }
    initIrregularRocksWithColliders() {
        const rockMat = new THREE.MeshStandardMaterial({
            color: 0x6e3625,
            roughness: 0.95,
            metalness: 0.08
        });
        const numRocks = 105;
        for (let i = 0; i < numRocks; i++) {
            const radius = 0.8 + this.random() * 3.5;
            const geom = new THREE.IcosahedronGeometry(radius, this.random() > 0.5 ? 1 : 0);
            const pos = geom.attributes.position;
            for (let j = 0; j < pos.count; j++) {
                const vx = pos.getX(j);
                const vy = pos.getY(j);
                const vz = pos.getZ(j);
                const noise = 1.0 + (Math.sin(vx * 3.2) * Math.cos(vy * 2.5) * Math.sin(vz * 3.0)) * 0.48;
                const flattenY = vy > 0 ? 1.0 : 0.65;
                pos.setXYZ(j, vx * noise, vy * noise * flattenY, vz * noise);
            }
            geom.computeVertexNormals();
            const rock = new THREE.Mesh(geom, rockMat);
            rock.castShadow = true;
            rock.receiveShadow = true;
            const rx = (this.random() - 0.5) * (this.gridSize * 0.82);
            const rz = (this.random() - 0.5) * (this.gridSize * 0.82);
            if (Math.hypot(rx - this.baseCoord.x, rz - this.baseCoord.z) < 32 ||
                Math.hypot(rx - this.targetCoord.x, rz - this.targetCoord.z) < 22) {
                continue;
            }
            const ry = this.getSmoothHeightAt(rx, rz);
            const scaleX = 0.6 + this.random() * 1.6;
            const scaleY = 0.5 + this.random() * 2.4;
            const scaleZ = 0.6 + this.random() * 1.6;
            rock.scale.set(scaleX, scaleY, scaleZ);
            rock.position.set(rx, ry + radius * scaleY * 0.35, rz);
            rock.rotation.set((this.random() - 0.5) * 0.8, this.random() * Math.PI * 2, (this.random() - 0.5) * 0.8);
            this.scene.add(rock);
            let colRadius = 0;
            rock.updateMatrix();
            const vertex = new THREE.Vector3();
            for (let i = 0; i < pos.count; i++) {
                vertex.fromBufferAttribute(pos, i).applyMatrix4(rock.matrix);
                colRadius = Math.max(colRadius, Math.hypot(vertex.x - rx, vertex.z - rz));
            }
            this.colliders.push({
                x: rx,
                z: rz,
                radius: colRadius,
                name: `Roca escarpada [${Math.round(rx)}, ${Math.round(rz)}]`
            });
        }
    }
    initMineralSamples() {
        const sampleTypes = [
            { name: "Nódulo de Sílice Hidratada", color: 0x00e5ff, yield: "Sílice · muestra sintética", type: "silica" },
            { name: "Cristal de Carbonato Fósil", color: 0x00e676, yield: "Carbonato · muestra sintética", type: "carbonate" },
            { name: "Hielo de Subsuelo Clastificado", color: 0x80d8ff, yield: "Hielo · muestra sintética", type: "ice" },
            { name: "Esferulita de Hematita (Blueberry)", color: 0xffab40, yield: "Hematita · muestra sintética", type: "hematite" }
        ];
        const sampleGeom = new THREE.OctahedronGeometry(0.45, 0);
        for (let i = 0; i < 11; i++) {
            const typeData = sampleTypes[i % sampleTypes.length];
            const mat = new THREE.MeshStandardMaterial({
                color: typeData.color,
                emissive: typeData.color,
                emissiveIntensity: 0.6,
                roughness: 0.2,
                metalness: 0.8
            });
            const mesh = new THREE.Mesh(sampleGeom, mat);
            mesh.castShadow = true;
            const sx = (this.random() - 0.5) * (this.gridSize * 0.60);
            const sz = (this.random() - 0.5) * (this.gridSize * 0.60);
            const sy = this.getSmoothHeightAt(sx, sz) + 0.35;
            mesh.position.set(sx, sy, sz);
            mesh.rotation.set(this.random(), this.random(), this.random());
            this.scene.add(mesh);
            const glow = new THREE.PointLight(typeData.color, 1.2, 6);
            glow.position.set(sx, sy + 0.5, sz);
            this.scene.add(glow);
            this.collectibleSamples.push({
                mesh: mesh,
                light: glow,
                x: sx,
                z: sz,
                y: sy,
                name: typeData.name,
                type: typeData.type,
                yield: typeData.yield,
                collected: false
            });
        }
    }
    initColonyAssets() {
        this.baseGroup = new THREE.Group();
        const domeGeom = new THREE.SphereGeometry(11.0, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
        const domeMat = new THREE.MeshStandardMaterial({ color: 0xdae2eb, roughness: 0.25, metalness: 0.65 });
        const dome = new THREE.Mesh(domeGeom, domeMat);
        this.baseGroup.add(dome);
        const airlockGeom = new THREE.BoxGeometry(4.8, 4.2, 7.8);
        const airlockMat = new THREE.MeshStandardMaterial({ color: 0x455a64, roughness: 0.5 });
        const airlock = new THREE.Mesh(airlockGeom, airlockMat);
        airlock.position.set(0, 2.1, 10.2);
        this.baseGroup.add(airlock);
        const airlockDoorLight = new THREE.PointLight(0x00e5ff, 2.0, 15);
        airlockDoorLight.position.set(0, 3.2, 14.2);
        this.baseGroup.add(airlockDoorLight);
        const towerGeom = new THREE.CylinderGeometry(0.18, 0.3, 15.0, 8);
        const towerMat = new THREE.MeshBasicMaterial({ color: 0x78909c });
        const tower = new THREE.Mesh(towerGeom, towerMat);
        tower.position.set(-7.0, 10.5, -7.0);
        this.baseGroup.add(tower);
        const baseBeacon = new THREE.PointLight(0x00e5ff, 3.5, 80);
        baseBeacon.position.set(-7.0, 18.0, -7.0);
        this.baseGroup.add(baseBeacon);
        const baseY = this.getSmoothHeightAt(this.baseCoord.x, this.baseCoord.z);
        this.baseGroup.position.set(this.baseCoord.x, baseY, this.baseCoord.z);
        this.scene.add(this.baseGroup);
        this.colliders.push({
            x: this.baseCoord.x,
            z: this.baseCoord.z,
            radius: 12.0,
            name: "Estructura Domo Base Alfa"
        });
        this.colliders.push({
            x: this.baseCoord.x, z: this.baseCoord.z + 11.2, radius: 2.9, name: "Esclusa de Base Alfa"
        });
        this.pois.push({
            x: this.baseCoord.x,
            z: this.baseCoord.z,
            name: "Base Alfa (Hábitat)",
            tag: "BASE",
            icon: "🏠",
            type: "base",
            color: "#00e5ff",
            description: "Módulo central presurizado de la misión ARES. Soporte vital 100%, recarga y comunicaciones MRO."
        });
        this.initRoverModel(this.baseCoord.x + 18, this.baseCoord.z + 10, "Rover Presurizado PR-01", true);
        this.initRoverModel(this.targetCoord.x - 16, this.targetCoord.z - 14, "Rover Abierto LRV-02", false);
        this.initRoverModel(85, 65, "Rover Scout RS-03", false);
        this.initRoverModel(-45, -105, "Rover Logístico RC-04", true);
        this.initCompanionAstronaut(this.baseCoord.x + 7, this.baseCoord.z + 18, "Ing. Vega (Apoyo EVA)", "scanner");
        this.initCompanionAstronaut(this.targetCoord.x - 8, this.targetCoord.z - 6, "Tte. Chen (Exobiología)", "antenna");
        this.initCompanionAstronaut(-89, -34, "Ing. Morales (Telecomunicaciones)", "antenna");
        this.initCompanionAstronaut(-20, 75, "Dra. Sato (Astrobiología)", "scanner");
        this.initCompanionAstronaut(70, -59, "Esp. Rossi (Perforación de Subsuelo)", "scanner");
        this.initInteractiveScienceStations();
        const outcropY = this.getSmoothHeightAt(this.targetCoord.x, this.targetCoord.z);
        const outcropGroup = new THREE.Group();
        const moundGeom = new THREE.ConeGeometry(7.0, 4.5, 12);
        const moundMat = new THREE.MeshStandardMaterial({ color: 0x4a2a1a, roughness: 0.95 });
        const mound = new THREE.Mesh(moundGeom, moundMat);
        mound.position.y = 2.25;
        outcropGroup.add(mound);
        for (let v = 0; v < 6; v++) {
            const vGeom = new THREE.BoxGeometry(0.6, 3.2, 1.2);
            const vMat = new THREE.MeshBasicMaterial({ color: 0x00e676 });
            const vMesh = new THREE.Mesh(vGeom, vMat);
            vMesh.position.set(Math.sin(v * 1.05) * 4.2, 2.2 + Math.cos(v) * 0.8, Math.cos(v * 1.05) * 4.2);
            vMesh.rotation.set(0.2, v, 0.2);
            outcropGroup.add(vMesh);
        }
        const targetBeaconLight = new THREE.PointLight(0x00e676, 2.5, 45);
        targetBeaconLight.position.set(0, 5.0, 0);
        outcropGroup.add(targetBeaconLight);
        const pillarGeom = new THREE.CylinderGeometry(0.18, 0.18, 65.0, 8);
        const pillarMat = new THREE.MeshBasicMaterial({ color: 0x00e676, transparent: true, opacity: 0.4 });
        const pillar = new THREE.Mesh(pillarGeom, pillarMat);
        pillar.position.y = 32.5;
        outcropGroup.add(pillar);
        outcropGroup.position.set(this.targetCoord.x, outcropY, this.targetCoord.z);
        this.scene.add(outcropGroup);
        this.colliders.push({
            x: this.targetCoord.x,
            z: this.targetCoord.z,
            radius: 6.5,
            name: "Afloramiento Fósil Delta"
        });
        this.pois.push({
            x: this.targetCoord.x,
            z: this.targetCoord.z,
            name: "Biofirmas Estromatolito",
            tag: "CIENCIA",
            icon: "🔬",
            type: "science",
            color: "#00e676",
            description: "Afloramiento sintético de entrenamiento para muestreo de carbonatos y búsqueda de posibles biofirmas."
        });
        const stromaMat = new THREE.MeshStandardMaterial({
            color: 0x00e676,
            emissive: 0x00e676,
            emissiveIntensity: 0.7,
            roughness: 0.15,
            metalness: 0.9
        });
        for (let s = 0; s < 5; s++) {
            const angle = (s / 5) * Math.PI * 2;
            const sx = this.targetCoord.x + Math.cos(angle) * 7.5;
            const sz = this.targetCoord.z + Math.sin(angle) * 7.5;
            const sy = this.getSmoothHeightAt(sx, sz) + 0.35;
            const sMesh = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55), stromaMat);
            sMesh.position.set(sx, sy, sz);
            sMesh.rotation.set(this.random(), this.random(), this.random());
            this.scene.add(sMesh);
            const sLight = new THREE.PointLight(0x00e676, 1.4, 7);
            sLight.position.set(sx, sy + 0.5, sz);
            this.scene.add(sLight);
            this.collectibleSamples.push({
                mesh: sMesh,
                light: sLight,
                x: sx,
                z: sz,
                y: sy,
                name: `Biofirma Fósil Estromatolito #${s + 1}`,
                type: "stromatolite",
                yield: "99% Carbonato Bioquímico",
                collected: false
            });
        }
    }
    initInteractiveScienceStations() {
        this.interactiveStations = [];
        const mY = this.getSmoothHeightAt(-40, -45);
        const mGroup = new THREE.Group();
        const mBase = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 1.2, 8), new THREE.MeshStandardMaterial({ color: 0x546e7a }));
        mBase.position.y = 0.6;
        mGroup.add(mBase);
        const mMast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 8), new THREE.MeshStandardMaterial({ color: 0xb0bec5 }));
        mMast.position.y = 2.2;
        mGroup.add(mMast);
        const mSensor = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 8), new THREE.MeshBasicMaterial({ color: 0x00e5ff }));
        mSensor.position.y = 3.8;
        mGroup.add(mSensor);
        const mLight = new THREE.PointLight(0x00e5ff, 1.5, 12);
        mLight.position.y = 3.9;
        mGroup.add(mLight);
        mGroup.position.set(-40, mY, -45);
        this.scene.add(mGroup);
        this.colliders.push({ x: -40, z: -45, radius: 1.8, name: "Estación Meteorológica MEDA" });
        this.pois.push({
            x: -40,
            z: -45,
            name: "Estación Meteorológica MEDA",
            tag: "METEO",
            icon: "🌤️",
            type: "science",
            color: "#00e5ff",
            description: "Monitoreo ambiental continuo: 612 Pa de presión, -48 °C superficial, viento 3.5 m/s NO."
        });
        this.interactiveStations.push({
            x: -40, z: -45, name: "Estación Meteorológica MEDA",
            infoTitle: "MEDA: Telemetría Atmosférica",
            infoDesc: "Presión: 612 Pa • Temp: -48 °C • Viento: 3.5 m/s NO • Radiación UV: 1.4 mSv/h"
        });
        const aY = this.getSmoothHeightAt(-95, -35);
        const aGroup = new THREE.Group();
        const aMast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 4.0, 8), new THREE.MeshStandardMaterial({ color: 0x37474f }));
        aMast.position.y = 2.0;
        aGroup.add(aMast);
        const dishGeom = new THREE.SphereGeometry(2.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.8);
        const dishMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.3, metalness: 0.7, side: THREE.DoubleSide });
        const dish = new THREE.Mesh(dishGeom, dishMat);
        dish.position.set(0, 4.0, 0);
        dish.rotation.x = -Math.PI / 4;
        aGroup.add(dish);
        const dLight = new THREE.PointLight(0xffb300, 1.8, 14);
        dLight.position.set(0, 4.8, 0.8);
        aGroup.add(dLight);
        aGroup.position.set(-95, aY, -35);
        this.scene.add(aGroup);
        this.colliders.push({ x: -95, z: -35, radius: 3.2, name: "Antena Espacio Profundo DSN" });
        this.pois.push({
            x: -95,
            z: -35,
            name: "Antena Parabólica DSN",
            tag: "COMMS",
            icon: "📡",
            type: "base",
            color: "#ffb300",
            description: "Enlace orbital X-Band activo con Mars Reconnaissance Orbiter (MRO) y red DSN Tierra."
        });
        this.interactiveStations.push({
            x: -95, z: -35, name: "Antena Parabólica DSN",
            infoTitle: "DSN Relé: Diagnóstico de Enlace",
            infoDesc: "MRO Enlace Banda X: Activo • SNR: +28 dB • Retardo Tierra: 14.2 min (un trayecto)"
        });
        const pY = this.getSmoothHeightAt(75, -60);
        const pGroup = new THREE.Group();
        const pTower = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.7, 5.5, 6), new THREE.MeshStandardMaterial({ color: 0xf57c00, metalness: 0.6 }));
        pTower.position.y = 2.75;
        pGroup.add(pTower);
        const pDrill = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.8, 8), new THREE.MeshBasicMaterial({ color: 0x263238 }));
        pDrill.position.y = 1.0;
        pGroup.add(pDrill);
        const pLight = new THREE.PointLight(0xff503b, 2.0, 15);
        pLight.position.y = 5.2;
        pGroup.add(pLight);
        pGroup.position.set(75, pY, -60);
        this.scene.add(pGroup);
        this.colliders.push({ x: 75, z: -60, radius: 2.6, name: "Torre de Perforación de Subsuelo" });
        this.pois.push({
            x: 75,
            z: -60,
            name: "Torre de Perforación Geológica",
            tag: "SONDEO",
            icon: "⚙️",
            type: "science",
            color: "#ff9100",
            description: "Testigo geológico continuo a 5m: regolito basáltico superior y arcillas esmectitas profundas."
        });
        this.interactiveStations.push({
            x: 75, z: -60, name: "Torre de Perforación Geológica", fault: true, beacon: pLight,
            infoTitle: "Estratigrafía de Subsuelo Extraída",
            infoDesc: "Testigo a 5m de profundidad: estrato de arcillas esmectitas ricas en carbonatos hidratados"
        });
    }
    initBaseHabitatInterior() {
        this.baseInteriorGroup.position.set(this.baseCoord.x, 300, this.baseCoord.z);
        const roomGeom = new THREE.CylinderGeometry(11.0, 11.0, 4.6, 24, 1, true);
        const roomMat = new THREE.MeshStandardMaterial({
            color: 0x2b3842,
            roughness: 0.4,
            metalness: 0.3,
            side: THREE.BackSide
        });
        const roomWalls = new THREE.Mesh(roomGeom, roomMat);
        roomWalls.position.y = 2.3;
        this.baseInteriorGroup.add(roomWalls);
        const floorGeom = new THREE.CircleGeometry(11.0, 24);
        floorGeom.rotateX(-Math.PI / 2);
        const floorMat = new THREE.MeshStandardMaterial({ color: 0x1a242c, roughness: 0.6, metalness: 0.2 });
        const floor = new THREE.Mesh(floorGeom, floorMat);
        floor.position.y = 0.05;
        this.baseInteriorGroup.add(floor);
        const ceilingGeom = new THREE.SphereGeometry(11.0, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
        const ceilingMat = new THREE.MeshStandardMaterial({ color: 0x37474f, side: THREE.BackSide });
        const ceiling = new THREE.Mesh(ceilingGeom, ceilingMat);
        ceiling.position.y = 2.3;
        this.baseInteriorGroup.add(ceiling);
        const ceilingLight = new THREE.PointLight(0xfff3e0, 180, 28);
        ceilingLight.position.set(0, 4.2, 0);
        this.baseInteriorGroup.add(ceilingLight);
        const ambientInterior = new THREE.AmbientLight(0xb6cbd9, 1.8);
        this.baseInteriorGroup.add(ambientInterior);
        const monitorCanvas = document.createElement('canvas');
        this.monitorCanvas = monitorCanvas;
        monitorCanvas.width = 512;
        monitorCanvas.height = 256;
        const mCtx = monitorCanvas.getContext('2d');
        mCtx.fillStyle = '#06131f';
        mCtx.fillRect(0, 0, 512, 256);
        mCtx.strokeStyle = '#00e5ff';
        mCtx.lineWidth = 4;
        mCtx.strokeRect(8, 8, 496, 240);
        mCtx.fillStyle = '#00e5ff';
        mCtx.font = 'bold 22px monospace';
        mCtx.fillText(translate('HATUN WASI — QHAPAQ ÑAN'), 24, 42);
        mCtx.fillStyle = '#00e676';
        mCtx.font = '16px monospace';
        mCtx.fillText(translate('ESTADO GENERAL: PRESURIZACIÓN 101.3 kPa • 100% NOMINAL'), 24, 80);
        mCtx.fillText(translate('MRO RELAY ORBITAL: ENLACE BANDA X CONECTADO (12 Mbps)'), 24, 110);
        mCtx.fillText(translate('SOPORTE VITAL EVA: RACKS DE RECARGA O2/BAT ACTIVOS'), 24, 140);
        mCtx.fillStyle = '#ffb300';
        mCtx.fillText(translate('TELEMETRÍA ROVER: PR-01 ESTACIONADO | LRV-02 EN RUTA'), 24, 175);
        mCtx.fillStyle = '#80deea';
        mCtx.font = '14px monospace';
        mCtx.fillText(translate('SIMULACIÓN · HÁBITAT DE ENTRENAMIENTO EVA'), 24, 210);
        mCtx.fillText(translate('Pulsa [E] junto a la esclusa para regresar al exterior.'), 24, 232);
        this.monitorTexture = new THREE.CanvasTexture(monitorCanvas);
        const monitorMat = new THREE.MeshBasicMaterial({ map: this.monitorTexture });
        const monitorMesh = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 3.2), monitorMat);
        monitorMesh.position.set(0, 2.4, -9.8);
        this.baseInteriorGroup.add(monitorMesh);
        const rackMat = new THREE.MeshStandardMaterial({ color: 0x546e7a, metalness: 0.6 });
        const leftRack = new THREE.Mesh(new THREE.BoxGeometry(1.8, 3.2, 0.8), rackMat);
        leftRack.position.set(-6.5, 1.6, -6.5);
        leftRack.rotation.y = Math.PI / 4;
        this.baseInteriorGroup.add(leftRack);
        const o2TankMat = new THREE.MeshStandardMaterial({ color: 0x00e676, roughness: 0.3 });
        for (let t = -1; t <= 1; t++) {
            const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 2.0, 12), o2TankMat);
            tank.position.set(-6.5 + t * 0.45, 1.6, -6.5 - t * 0.45);
            this.baseInteriorGroup.add(tank);
        }
        const doorMat = new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.5 });
        const door = new THREE.Mesh(new THREE.BoxGeometry(3.0, 3.2, 0.4), doorMat);
        door.position.set(0, 1.6, 9.8);
        this.baseInteriorGroup.add(door);
        const doorSign = new THREE.PointLight(0x00e5ff, 1.5, 8);
        doorSign.position.set(0, 2.8, 9.2);
        this.baseInteriorGroup.add(doorSign);
    }
    toggleBaseInterior(enter) {
        this.isInsideBase = enter;
        if (enter) {
            this.baseInteriorGroup.visible = true;
            this.terrainMesh.visible = false;
            this.baseGroup.visible = false;
            this.routeGroup.visible = false;
            if (this.sunLight)
                this.sunLight.visible = false;
            if (this.ambientLight)
                this.ambientLight.intensity = 0.2;
        }
        else {
            this.baseInteriorGroup.visible = false;
            this.terrainMesh.visible = true;
            this.baseGroup.visible = true;
            this.routeGroup.visible = true;
            if (this.sunLight)
                this.sunLight.visible = true;
            if (this.ambientLight)
                this.ambientLight.intensity = 0.65;
        }
    }
    initRoverModel(rx, rz, name, isMountable) {
        const ry = this.getSmoothHeightAt(rx, rz);
        const roverGroup = new THREE.Group();
        const bodyGeom = new THREE.BoxGeometry(3.2, 1.4, 4.6);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xb0bec5, roughness: 0.4, metalness: 0.5 });
        const body = new THREE.Mesh(bodyGeom, bodyMat);
        body.position.y = 1.4;
        roverGroup.add(body);
        const wheelGeom = new THREE.CylinderGeometry(0.55, 0.55, 0.45, 12);
        wheelGeom.rotateZ(Math.PI / 2);
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
        const wheelOffsets = [
            [-1.8, 0.6, 1.8], [1.8, 0.6, 1.8],
            [-1.9, 0.6, 0.0], [1.9, 0.6, 0.0],
            [-1.8, 0.6, -1.8], [1.8, 0.6, -1.8]
        ];
        wheelOffsets.forEach(([wx, wy, wz]) => {
            const wheel = new THREE.Mesh(wheelGeom, wheelMat);
            wheel.position.set(wx, wy, wz);
            roverGroup.add(wheel);
        });
        const mastGeom = new THREE.CylinderGeometry(0.08, 0.08, 2.0, 8);
        const mast = new THREE.Mesh(mastGeom, bodyMat);
        mast.position.set(0.6, 2.8, 1.6);
        roverGroup.add(mast);
        const mastHead = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0x37474f }));
        mastHead.position.set(0.6, 3.8, 1.6);
        roverGroup.add(mastHead);
        roverGroup.position.set(rx, ry, rz);
        this.scene.add(roverGroup);
        this.colliders.push({ x: rx, z: rz, radius: 2.8, name: name });
        this.pois.push({
            x: rx,
            z: rz,
            name: name,
            tag: isMountable ? "ROVER CABINA" : "ROVER",
            icon: "🚜",
            type: "rover",
            color: "#ffb300",
            description: isMountable ? "Vehículo presurizado con soporte vital redundante y laboratorio de campo." : "Vehículo ligero de exploración geológica no presurizado."
        });
    }
    initCompanionAstronaut(ax, az, name, toolType = "scanner") {
        const ay = this.getSmoothHeightAt(ax, az);
        const companionGroup = new THREE.Group();
        const suitMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.65 });
        const jointMat = new THREE.MeshStandardMaterial({ color: 0x455a64, roughness: 0.8 });
        const bootMat = new THREE.MeshStandardMaterial({ color: 0x263238, roughness: 0.9 });
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.85, 0.42), suitMat);
        torso.position.y = 1.35;
        companionGroup.add(torso);
        const plss = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.72, 0.30), suitMat);
        plss.position.set(0, 1.40, -0.32);
        companionGroup.add(plss);
        const tankGeom = new THREE.CylinderGeometry(0.08, 0.08, 0.52, 10);
        const tankMat = new THREE.MeshStandardMaterial({ color: 0x00e5ff, metalness: 0.7 });
        const tankL = new THREE.Mesh(tankGeom, tankMat);
        tankL.position.set(-0.16, 1.46, -0.45);
        companionGroup.add(tankL);
        const tankR = new THREE.Mesh(tankGeom, tankMat);
        tankR.position.set(0.16, 1.46, -0.45);
        companionGroup.add(tankR);
        const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.33, 16, 16), suitMat);
        helmet.position.y = 2.02;
        companionGroup.add(helmet);
        const visor = new THREE.Mesh(new THREE.SphereGeometry(0.31, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.95, roughness: 0.12 }));
        visor.rotation.x = Math.PI / 2;
        visor.position.set(0, 2.02, 0.08);
        companionGroup.add(visor);
        const armGeom = new THREE.CylinderGeometry(0.11, 0.10, 0.65, 8);
        const leftArm = new THREE.Mesh(armGeom, suitMat);
        leftArm.position.set(-0.46, 1.25, 0.0);
        leftArm.rotation.z = 0.18;
        leftArm.rotation.x = 0.35;
        companionGroup.add(leftArm);
        const rightArm = new THREE.Mesh(armGeom, suitMat);
        rightArm.position.set(0.46, 1.25, 0.0);
        rightArm.rotation.z = -0.18;
        rightArm.rotation.x = -0.25;
        companionGroup.add(rightArm);
        const legGeom = new THREE.CylinderGeometry(0.14, 0.12, 0.75, 8);
        const leftLeg = new THREE.Mesh(legGeom, suitMat);
        leftLeg.position.set(-0.20, 0.58, 0.0);
        companionGroup.add(leftLeg);
        const rightLeg = new THREE.Mesh(legGeom, suitMat);
        rightLeg.position.set(0.20, 0.58, 0.0);
        companionGroup.add(rightLeg);
        const bootL = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.36), bootMat);
        bootL.position.set(-0.20, 0.10, 0.06);
        companionGroup.add(bootL);
        const bootR = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.36), bootMat);
        bootR.position.set(0.20, 0.10, 0.06);
        companionGroup.add(bootR);
        if (toolType === "scanner") {
            const scanner = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 0.28), jointMat);
            scanner.position.set(-0.44, 0.95, 0.24);
            companionGroup.add(scanner);
            const scannerBeam = new THREE.PointLight(0x00e5ff, 1.2, 3);
            scannerBeam.position.set(-0.44, 0.92, 0.36);
            companionGroup.add(scannerBeam);
        }
        else {
            const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.1), jointMat);
            antenna.position.set(0.46, 1.6, -0.32);
            companionGroup.add(antenna);
        }
        companionGroup.position.set(ax, ay, az);
        companionGroup.rotation.y = this.random() * Math.PI * 2;
        this.scene.add(companionGroup);
        const collider = { x: ax, z: az, radius: 1.2, name };
        this.colliders.push(collider);
        const actor = { group: companionGroup, leftArm, rightArm, leftLeg, rightLeg, collider, ax, az,
            activity: this.companions.length % 2 === 0 ? "walking" : "working", phase: this.companions.length * 1.7 };
        this.companions.push(actor);
        this.pois.push({
            actor, x: ax,
            z: az,
            name: name,
            tag: "CREW EVA",
            icon: "👨‍🚀",
            type: "crew",
            color: "#80deea",
            description: "Miembro de la tripulación científica realizando muestreo geológico en superficie."
        });
    }
    updateCompanions(dt) {
        this.companionTime += dt;
        for (const actor of this.companions) {
            const time = this.companionTime + actor.phase;
            const { group, leftArm, rightArm, leftLeg, rightLeg, collider } = actor;
            if (actor.activity === "walking") {
                const phase = time * 0.3;
                const x = actor.ax + 2.2 * Math.sin(phase);
                const z = actor.az + 1.8 * Math.sin(phase * 0.65);
                const blocked = this.colliders.some(other => other !== collider &&
                    Math.hypot(other.x - x, other.z - z) < other.radius + collider.radius);
                if (!blocked) {
                    collider.x = x; collider.z = z;
                    group.position.set(x, this.getSmoothHeightAt(x, z), z);
                    group.rotation.y = Math.atan2(2.2 * Math.cos(phase), 1.17 * Math.cos(phase * 0.65));
                }
                const swing = blocked ? 0 : 0.36 * Math.sin(time * 6);
                leftLeg.rotation.x = swing; rightLeg.rotation.x = -swing;
                leftArm.rotation.x = -swing; rightArm.rotation.x = swing;
            } else {
                leftArm.rotation.x = -0.75 + 0.18 * Math.sin(time * 2.8);
                rightArm.rotation.x = -0.55 - 0.22 * Math.sin(time * 2.8);
                group.rotation.z = 0.04 * Math.sin(time * 1.2);
            }
        }
    }

    pathBlocked(x0, z0, x1, z1, padding = 0.65, boundary = 2) {
        const half = this.gridSize / 2 - boundary;
        if (Math.abs(x1) > half || Math.abs(z1) > half) return true;
        const dx = x1 - x0, dz = z1 - z0, lengthSquared = dx * dx + dz * dz;
        return this.colliders.some(({ x, z, radius }) => {
            const fraction = lengthSquared ? Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / lengthSquared)) : 0;
            return Math.hypot(x0 + dx * fraction - x, z0 + dz * fraction - z) < radius + padding;
        });
    }
    getNearbyReliefExtrema(centerX, centerZ, radiusMeters = 180) {
        let maxPeak = -9999;
        let minValley = 9999;
        const step = 15;
        const currentElev = this.getSmoothHeightAt(centerX, centerZ);
        for (let rx = -radiusMeters; rx <= radiusMeters; rx += step) {
            for (let rz = -radiusMeters; rz <= radiusMeters; rz += step) {
                if (Math.hypot(rx, rz) <= radiusMeters) {
                    const elev = this.getSmoothHeightAt(centerX + rx, centerZ + rz);
                    if (elev > maxPeak)
                        maxPeak = elev;
                    if (elev < minValley)
                        minValley = elev;
                }
            }
        }
        return {
            currentElev: currentElev,
            maxPeak: maxPeak,
            minValley: minValley,
            deltaPeak: maxPeak - currentElev,
            deltaValley: minValley - currentElev
        };
    }
    checkProximityHazards(currentX, currentZ, forwardAngle) {
        const frontDist = 2.8;
        const fx = currentX + Math.sin(forwardAngle) * frontDist;
        const fz = currentZ + Math.cos(forwardAngle) * frontDist;
        const curY = this.getSmoothHeightAt(currentX, currentZ);
        const frontY = this.getSmoothHeightAt(fx, fz);
        const dy = frontY - curY;
        const slopeDeg = (Math.atan2(Math.abs(dy), frontDist) * 180) / Math.PI;
        if (dy < -1.4 && slopeDeg > 24.0) {
            return {
                hasHazard: true,
                type: "cliff",
                severity: "caution",
                slopeDeg: -slopeDeg,
                message: `DESNIVEL PRÓXIMO: BARRANCO (-${slopeDeg.toFixed(0)}°)`
            };
        }
        const distCenter = Math.hypot(currentX, currentZ);
        if (distCenter > 215.0) {
            return {
                hasHazard: true,
                type: "restricted",
                severity: "notice",
                slopeDeg: slopeDeg,
                message: "AVISO: BORDE DEL ESCENARIO LOCAL DE ENTRENAMIENTO"
            };
        }
        return {
            hasHazard: false,
            type: "nominal",
            severity: "nominal",
            slopeDeg: dy > 0 ? slopeDeg : -slopeDeg,
            message: "TRACCIÓN NOMINAL"
        };
    }
    initDustParticles() {
        const count = 1600;
        const geom = new THREE.BufferGeometry();
        const positions = new Float32Array(count * 3);
        for (let i = 0; i < count * 3; i += 3) {
            positions[i] = (this.random() - 0.5) * 500;
            positions[i + 1] = this.random() * 45;
            positions[i + 2] = (this.random() - 0.5) * 500;
        }
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            color: 0xcc7755,
            size: 0.65,
            transparent: true,
            opacity: 0.42
        });
        this.dustParticles = new THREE.Points(geom, mat);
        this.scene.add(this.dustParticles);
    }
    updateDust(delta) {
        if (!this.dustParticles)
            return;
        const pos = this.dustParticles.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            let x = pos.getX(i);
            let y = pos.getY(i);
            x += delta * 2.2;
            y += Math.sin(x * 0.05) * 0.08;
            if (x > 250)
                x = -250;
            pos.setX(i, x);
            pos.setY(i, y);
        }
        pos.needsUpdate = true;
    }
}
export { Terrain3D as MarsTerrain3D };

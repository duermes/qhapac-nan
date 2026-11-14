import * as THREE from "three";
export class CharacterController {
    constructor(scene, camera, terrain, lifeSupport) {
        this.scene = scene;
        this.camera = camera;
        this.terrain = terrain;
        this.lifeSupport = lifeSupport;
        this.position = new THREE.Vector3(-65, 0, -44);
        this.bodyHeading = 0.5;
        this.helmetYawOffset = 0;
        this.helmetPitch = 0;
        this.baseSpeed = 1.4;
        this.currentSpeed = 1.4;
        this.turnRate = 0.8;
        this.turnVelocity = 0;
        this.isFirstPerson = true;
        this.keys = { forward: false, backward: false, left: false, right: false };
        this.isMoving = false;
        this.walkCycleTime = 0;
        this.currentSlopeDeg = 0;
        this.nearBaseAirlock = false;
        this.isInsideBase = false;
        this.proximityHazard = { hasHazard: false, type: "nominal", message: "TRACCIÓN NOMINAL" };
        this.astronautMesh = this.buildArticulatedAstronaut();
        this.scene.add(this.astronautMesh);
        this.onBaseChange = () => { };
        this.initHelmetLight();
        this.updatePosition(this.position.x, this.position.z);
    }
    buildArticulatedAstronaut() {
        this.rootGroup = new THREE.Group();
        const suitMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.65, metalness: 0.15 });
        const darkJointMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8 });
        const torsoGeom = new THREE.BoxGeometry(0.72, 0.95, 0.44);
        this.torso = new THREE.Mesh(torsoGeom, suitMat);
        this.torso.position.y = 1.35;
        this.torso.castShadow = true;
        this.rootGroup.add(this.torso);
        const chestGeom = new THREE.BoxGeometry(0.42, 0.35, 0.08);
        const chest = new THREE.Mesh(chestGeom, new THREE.MeshStandardMaterial({ color: 0x37474f }));
        chest.position.set(0, 0.1, 0.24);
        this.torso.add(chest);
        this.headGroup = new THREE.Group();
        this.headGroup.position.set(0, 2.05, 0);
        const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.15, 16), darkJointMat);
        this.headGroup.add(collar);
        const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 20), suitMat);
        helmet.position.y = 0.18;
        this.headGroup.add(helmet);
        const visorGeom = new THREE.SphereGeometry(0.34, 20, 16, 0, Math.PI * 2, 0, Math.PI / 2);
        const visorMat = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.95, roughness: 0.12 });
        const visor = new THREE.Mesh(visorGeom, visorMat);
        visor.rotation.x = Math.PI / 2;
        visor.position.set(0, 0.18, 0.08);
        this.headGroup.add(visor);
        this.rootGroup.add(this.headGroup);
        const plss = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.88, 0.32), new THREE.MeshStandardMaterial({ color: 0xe0e0e0 }));
        plss.position.set(0, 1.45, -0.32);
        this.rootGroup.add(plss);
        const tankMat = new THREE.MeshStandardMaterial({ color: 0xb0bec5 });
        const tankGeom = new THREE.CylinderGeometry(0.1, 0.1, 0.75, 12);
        const tankL = new THREE.Mesh(tankGeom, tankMat);
        tankL.position.set(-0.16, 1.45, -0.45);
        const tankR = new THREE.Mesh(tankGeom, tankMat);
        tankR.position.set(0.16, 1.45, -0.45);
        this.rootGroup.add(tankL);
        this.rootGroup.add(tankR);
        const armGeom = new THREE.CylinderGeometry(0.11, 0.09, 0.72, 8);
        this.leftArm = new THREE.Group();
        this.leftArm.position.set(-0.46, 1.7, 0);
        const lArmMesh = new THREE.Mesh(armGeom, suitMat);
        lArmMesh.position.y = -0.36;
        this.leftArm.add(lArmMesh);
        this.rootGroup.add(this.leftArm);
        this.rightArm = new THREE.Group();
        this.rightArm.position.set(0.46, 1.7, 0);
        const rArmMesh = new THREE.Mesh(armGeom, suitMat);
        rArmMesh.position.y = -0.36;
        this.rightArm.add(rArmMesh);
        this.rootGroup.add(this.rightArm);
        const legGeom = new THREE.CylinderGeometry(0.14, 0.12, 0.85, 8);
        this.leftLeg = new THREE.Group();
        this.leftLeg.position.set(-0.2, 0.88, 0);
        const lLegMesh = new THREE.Mesh(legGeom, suitMat);
        lLegMesh.position.y = -0.42;
        this.leftLeg.add(lLegMesh);
        this.rootGroup.add(this.leftLeg);
        this.rightLeg = new THREE.Group();
        this.rightLeg.position.set(0.2, 0.88, 0);
        const rLegMesh = new THREE.Mesh(legGeom, suitMat);
        rLegMesh.position.y = -0.42;
        this.rightLeg.add(rLegMesh);
        this.rootGroup.add(this.rightLeg);
        const bootGeom = new THREE.BoxGeometry(0.26, 0.2, 0.42);
        const bootL = new THREE.Mesh(bootGeom, darkJointMat);
        bootL.position.set(0, -0.84, 0.06);
        this.leftLeg.add(bootL);
        const bootR = new THREE.Mesh(bootGeom, darkJointMat);
        bootR.position.set(0, -0.84, 0.06);
        this.rightLeg.add(bootR);
        return this.rootGroup;
    }
    initHelmetLight() {
        this.helmetLight = new THREE.SpotLight(0xfff5ea, 2.5, 38, Math.PI / 4.5, 0.45, 1.2);
        this.helmetLight.position.set(0, 0.18, 0.25);
        this.helmetLightTarget = new THREE.Object3D();
        this.helmetLightTarget.position.set(0, 0.18, 15);
        this.headGroup.add(this.helmetLight);
        this.headGroup.add(this.helmetLightTarget);
        this.helmetLight.target = this.helmetLightTarget;
    }
    toggleBaseAirlock() {
        if (!this.nearBaseAirlock)
            return false;
        this.isInsideBase = !this.isInsideBase;
        this.terrain.toggleBaseInterior(this.isInsideBase);
        this.position.set(this.terrain.baseCoord.x, 0, this.terrain.baseCoord.z + (this.isInsideBase ? 7.5 : 16));
        this.bodyHeading = this.isInsideBase ? Math.PI : 0;
        this.updatePosition(this.position.x, this.position.z);
        if (this.isInsideBase)
            this.lifeSupport.rechargeAtBase();
        this.onBaseChange(this.isInsideBase);
        return true;
    }
    tryCollectNearestSample() {
        if (this.isInsideBase)
            return null;
        const nearest = this.terrain.collectibleSamples
            .filter(s => !s.collected)
            .map(s => ({ sample: s, distance: Math.hypot(this.position.x - s.x, this.position.z - s.z) }))
            .filter(s => s.distance < 4.8)
            .sort((a, b) => a.distance - b.distance)[0]?.sample;
        if (!nearest)
            return null;
        nearest.collected = true;
        this.scene.remove(nearest.mesh, nearest.light);
        this.lifeSupport.collectSample();
        return nearest;
    }
    checkCollision(tx, tz) {
        if (this.isInsideBase) {
            const distFromHabCenter = Math.hypot(tx - this.terrain.baseCoord.x, tz - this.terrain.baseCoord.z);
            return distFromHabCenter > 9.8;
        }
        const astronautRadius = 0.65;
        for (const c of this.terrain.colliders) {
            const dist = Math.hypot(tx - c.x, tz - c.z);
            if (dist < (c.radius + astronautRadius)) {
                return true;
            }
        }
        return false;
    }
    togglePerspective() {
        this.isFirstPerson = !this.isFirstPerson;
        return this.isFirstPerson;
    }
    update(delta, controlDelta = delta) {
        this.isMoving = this.keys.forward || this.keys.backward;
        const turn = (this.keys.left ? 1 : 0) - (this.keys.right ? 1 : 0);
        this.turnVelocity += (turn * this.turnRate - this.turnVelocity) * (1 - Math.exp(-controlDelta / 0.12));
        this.bodyHeading += this.turnVelocity * controlDelta;
        if (this.isMoving) {
            const alignSpeed = 4.0 * delta;
            this.helmetYawOffset = THREE.MathUtils.lerp(this.helmetYawOffset, 0, alignSpeed);
        }
        let moveDir = 0;
        if (this.keys.forward)
            moveDir += 1;
        if (this.keys.backward)
            moveDir -= 1;
        if (moveDir !== 0) {
            const step = moveDir * this.currentSpeed * delta;
            const dx = Math.sin(this.bodyHeading) * step;
            const dz = Math.cos(this.bodyHeading) * step;
            const nextX = this.position.x + dx;
            const nextZ = this.position.z + dz;
            if (!this.isInsideBase) {
                const curY = this.terrain.getSmoothHeightAt(this.position.x, this.position.z);
                const nextY = this.terrain.getSmoothHeightAt(nextX, nextZ);
                const dy = nextY - curY;
                this.currentSlopeDeg = (Math.atan2(dy, Math.abs(step)) * 180) / Math.PI;
                let slopeFactor = 1.0;
                if (this.currentSlopeDeg > 0) {
                    slopeFactor = Math.max(0.35, 1.0 - (this.currentSlopeDeg / 18.0) * 0.65);
                }
                else {
                    slopeFactor = Math.max(0.60, 1.0 - (Math.abs(this.currentSlopeDeg) / 24.0) * 0.40);
                }
                this.currentSpeed = this.baseSpeed * slopeFactor;
            }
            else {
                this.currentSlopeDeg = 0;
                this.currentSpeed = this.baseSpeed * 0.9;
            }
            if (!this.checkCollision(nextX, nextZ)) {
                this.updatePosition(nextX, nextZ);
            }
            else {
                if (!this.checkCollision(nextX, this.position.z)) {
                    this.updatePosition(nextX, this.position.z);
                }
                else if (!this.checkCollision(this.position.x, nextZ)) {
                    this.updatePosition(this.position.x, nextZ);
                }
            }
            this.walkCycleTime += delta * 7.5;
            const swing = Math.sin(this.walkCycleTime) * 0.55;
            this.leftLeg.rotation.x = swing;
            this.rightLeg.rotation.x = -swing;
            this.leftArm.rotation.x = -swing * 0.8;
            this.rightArm.rotation.x = swing * 0.8;
        }
        else {
            this.currentSlopeDeg = 0;
            this.leftLeg.rotation.x *= 0.85;
            this.rightLeg.rotation.x *= 0.85;
            this.leftArm.rotation.x *= 0.85;
            this.rightArm.rotation.x *= 0.85;
            this.updatePosition(this.position.x, this.position.z);
        }
        if (!this.isInsideBase) {
            const airlockDoorX = this.terrain.baseCoord.x;
            const airlockDoorZ = this.terrain.baseCoord.z + 10.2;
            const distToAirlock = Math.hypot(this.position.x - airlockDoorX, this.position.z - airlockDoorZ);
            this.nearBaseAirlock = distToAirlock < 6.8;
            this.proximityHazard = this.terrain.checkProximityHazards(this.position.x, this.position.z, this.bodyHeading);
        }
        else {
            const exitDoorX = this.terrain.baseCoord.x;
            const exitDoorZ = this.terrain.baseCoord.z + 9.8;
            const distToExit = Math.hypot(this.position.x - exitDoorX, this.position.z - exitDoorZ);
            this.nearBaseAirlock = distToExit < 4.5;
            this.proximityHazard = { hasHazard: false, type: "nominal", message: "HÁBITAT BASE ALFA (PRESURIZADO)" };
        }
        this.lifeSupport.update(delta, this.isMoving, this.currentSlopeDeg, this.currentSpeed);
        const distToBase = Math.hypot(this.position.x - this.terrain.baseCoord.x, this.position.z - this.terrain.baseCoord.z);
        this.lifeSupport.updateDistanceToBase(distToBase);
    }
    updatePosition(newX, newZ) {
        if (!this.isInsideBase) {
            const half = this.terrain.gridSize / 2 - 4;
            this.position.x = Math.max(-half, Math.min(half, newX));
            this.position.z = Math.max(-half, Math.min(half, newZ));
            this.position.y = this.terrain.getSmoothHeightAt(this.position.x, this.position.z);
        }
        else {
            this.position.x = newX;
            this.position.z = newZ;
            this.position.y = 300 + 0.1;
        }
        this.astronautMesh.position.copy(this.position);
        this.astronautMesh.rotation.y = this.bodyHeading;
        this.headGroup.rotation.y = this.helmetYawOffset;
        this.headGroup.rotation.x = this.helmetPitch;
        this.astronautMesh.visible = !this.isFirstPerson;
        if (this.cameraManaged) return;
        const totalHeading = this.bodyHeading + this.helmetYawOffset;
        if (this.isFirstPerson) {
            this.astronautMesh.visible = false;
            this.camera.position.set(this.position.x, this.position.y + 2.15, this.position.z);
            const lookDist = 20.0;
            const targetLookX = this.position.x + Math.sin(totalHeading) * lookDist;
            const targetLookY = this.position.y + 2.15 + Math.sin(this.helmetPitch) * lookDist;
            const targetLookZ = this.position.z + Math.cos(totalHeading) * lookDist;
            this.camera.lookAt(targetLookX, targetLookY, targetLookZ);
        }
        else {
            this.astronautMesh.visible = true;
            const camDist = 6.8;
            const camHeight = 3.4;
            const camX = this.position.x - Math.sin(this.bodyHeading) * camDist;
            const camZ = this.position.z - Math.cos(this.bodyHeading) * camDist;
            this.camera.position.set(camX, this.position.y + camHeight, camZ);
            this.camera.lookAt(this.position.x, this.position.y + 1.8, this.position.z);
        }
    }
}

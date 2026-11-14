import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EffortModel } from "../web/hud/js/effort.js";
import * as THREE from "../web/vendor/three/three.module.js";

const threeUrl = new URL("../web/vendor/three/three.module.js", import.meta.url).href;
const source = (await readFile(new URL("../web/hud/js/character.js", import.meta.url), "utf8")).replace('from "three"', `from "${threeUrl}"`);
const { CharacterController } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function walk(seconds, slope = 0, dt = 1 / 60) {
  const effort = new EffortModel();
  for (let i = 0; i < Math.round(seconds / dt); i++) effort.update(dt, 1.4, slope);
  return effort;
}

function controller() {
  const terrain = {
    getSmoothHeightAt: () => 0,
    colliders: [], pathBlocked: () => false, gridSize: 600, baseCoord: { x: -65, z: -60 },
    checkProximityHazards: () => ({ hasHazard: false })
  };
  const suit = { update() {}, updateDistanceToBase() {} };
  const c = new CharacterController(new THREE.Scene(), new THREE.PerspectiveCamera(), terrain, suit);
  c.cameraManaged = true;
  return c;
}

test("two minutes of level walking leave thirty percent stamina", () => {
  const effort = walk(120);
  assert.ok(Math.abs(effort.staminaPct - 30) < 0.5);
});

test("level walking reaches thirty percent with the low stamina speed adjustment", () => {
  const effort = new EffortModel();
  for (let i = 0; i < 7200; i++) {
    const speed = 1.4 * Math.max(0.35, Math.min(1, effort.staminaPct / 35));
    effort.update(1 / 60, speed, 0);
  }
  assert.ok(Math.abs(effort.staminaPct - 30) < 1);
});

test("climbing consumes more stamina and rest restores it gradually", () => {
  const flat = walk(120), uphill = walk(120, 15);
  assert.ok(uphill.staminaPct < flat.staminaPct - 10);
  const before = uphill.staminaPct;
  uphill.update(1, 0, 0);
  assert.ok(uphill.staminaPct > before && uphill.staminaPct - before < 3);
  for (let i = 0; i < 60; i++) uphill.update(1, 0, 0);
  assert.equal(uphill.staminaPct, 100);
});

test("effort remains consistent across frame rates and sample collection has a bounded cost", () => {
  const a = walk(30, 10, 1 / 30), b = walk(30, 10, 1 / 120);
  assert.ok(Math.abs(a.staminaPct - b.staminaPct) < 0.02);
  const before = a.staminaPct;
  a.collect();
  assert.equal(before - a.staminaPct, 1.25);
});

test("keyboard turning uses real time at each simulation speed", () => {
  const turns = [];
  for (const rate of [1, 3]) {
    const c = controller(), initial = c.bodyHeading;
    c.keys.left = true;
    for (let i = 0; i < 60; i++) c.update(rate / 60, 1 / 60);
    turns.push(c.bodyHeading - initial);
  }
  assert.ok(turns[0] > 0.6 && turns[0] < 0.8);
  assert.ok(Math.abs(turns[0] - turns[1]) < 1e-10);
});

test("turning decelerates smoothly and walking keeps the chosen camera pitch", () => {
  const c = controller();
  c.keys.left = true;
  c.update(0.05, 1 / 60);
  const active = c.turnVelocity;
  c.keys.left = false;
  c.update(0.05, 1 / 60);
  assert.ok(c.turnVelocity > 0 && c.turnVelocity < active);
  c.keys.forward = true;
  c.helmetPitch = 0.25;
  for (let i = 0; i < 60; i++) c.update(0.05, 1 / 60);
  assert.equal(c.helmetPitch, 0.25);
});

test("the visor uses the shared stone palette and has no portal link", async () => {
  const html = await readFile(new URL("../web/hud/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../web/hud/css/hud.css", import.meta.url), "utf8");
  assert.ok(!html.includes('aria-label="Volver al portal"'));
  assert.ok(css.includes("--hud-accent: var(--gold)"));
  assert.ok(css.includes("var(--copper)"));
  assert.ok(css.includes("var(--glass-strong)"));
  assert.ok(!css.includes("--hud-cyan"));
});

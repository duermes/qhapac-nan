import test from "node:test";
import assert from "node:assert/strict";
import { STOPS, journeyState, eyeGeometry, closeupGeometry } from "../web/home/js/journey-math.js";

test("the three stops appear in the requested order", () => {
  const states = STOPS.map(p => journeyState(p, 1440, 900));
  assert.deepEqual(states.map(s => s.stage), [0,1,2]);
  assert.ok(states[0].cameraX < states[1].cameraX && states[1].cameraX < states[2].cameraX);
  for (let i = 0; i < states.length; i++) assert.ok(states[i].copies[i] > 0.99);
});

test("the horizontal camera moves continuously without reversing", () => {
  let previous = journeyState(0,1440,900);
  for (let i = 1; i <= 1000; i++) {
    const next = journeyState(i / 1000,1440,900);
    assert.ok(next.cameraX >= previous.cameraX);
    assert.ok(next.cameraX - previous.cameraX < 15);
    assert.ok(Math.abs(next.zoom - previous.zoom) < 0.05);
    previous = next;
  }
});

test("the eye becomes selectable only after the approach", () => {
  const statue = journeyState(STOPS[2],1440,900);
  const approach = journeyState(0.88,1440,900);
  const eyes = journeyState(1,1440,900);
  assert.equal(statue.eyeReady, false);
  assert.ok(approach.zoom > 1 && approach.zoom < eyes.zoom);
  assert.equal(approach.eyeReady, false);
  assert.equal(eyes.eyeReady, true);
  assert.ok(eyes.zoom > 1 && eyes.zoom <= 2.2);
  assert.equal(eyes.copies[3], 1);
  assert.equal(eyes.eyeOpacity, 1);
  assert.equal(statue.eyeOpacity, 0);
  assert.ok(approach.eyeOpacity > 0 && approach.eyeOpacity < 1);
});

test("the journey is reversible and works at narrow viewport widths", () => {
  for (const [width,height] of [[390,844],[768,1024],[1920,1080]]) {
    const states = [0,0.435,0.735,1,0.735,0.435,0].map(p => journeyState(p,width,height));
    assert.equal(states[0].cameraX,states[6].cameraX);
    assert.equal(states[1].cameraX,states[5].cameraX);
    assert.ok(states.every(s => s.cameraX >= 0 && s.cameraX <= s.worldWidth - width));
  }
});

test("reduced motion preserves the three destinations without camera zoom", () => {
  for (const p of [0,0.435,0.735,0.9,1]) {
    const state = journeyState(p,1440,900,true);
    assert.equal(state.zoom,1);
  }
  assert.equal(journeyState(1,1440,900,true).eyeReady,true);
});

test("the panorama approach and close-up eye target fit the final frame", () => {
  for (const [width,height] of [[320,844],[390,844],[768,1024],[962,685],[1440,900]]) {
    const final = journeyState(1,width,height);
    const eye = eyeGeometry(final,width,height);
    assert.ok(eye.left >= 0 && eye.left + eye.width <= width);
    assert.ok(eye.top >= 124 && eye.top + eye.height < height * 0.7);
    assert.ok(eye.width >= 44 && eye.height >= 44);
    const halfway = eyeGeometry(journeyState(0.9,width,height),width,height);
    assert.ok(Number.isFinite(halfway.left) && Number.isFinite(halfway.top));
    const closeup = closeupGeometry(width,height);
    assert.ok(closeup.left >= 0 && closeup.left + closeup.width <= width);
    assert.ok(closeup.top >= 132 && closeup.top + closeup.height < height * 0.7);
  }
});

test("the Chaski frame keeps the messenger and the onward trail in view", () => {
  const s = journeyState(STOPS[1],1440,900);
  const messengerX = s.worldWidth * 0.435 - s.cameraX;
  const trailX = s.worldWidth * 0.58 - s.cameraX;
  assert.ok(messengerX > 1440 * 0.4 && messengerX < 1440 * 0.6);
  assert.ok(trailX > 1440 * 0.8 && trailX < 1440);
});

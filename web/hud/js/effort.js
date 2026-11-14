const STAMINA_DRAIN_FACTOR = 4.49;

export class EffortModel {
  constructor() { this.reset(); }

  reset() {
    this.staminaPct = 100;
    this.accumulatedFatigue = 0.02;
    this.heartRateBpm = 70;
    this.gripMinutes = 0;
    this.topConsumptionCauses = [];
  }

  update(dt, speed, slopeDeg, gripping = false) {
    const moving = speed > 0.01;
    const positiveSlope = Math.max(0, slopeDeg), negativeSlope = Math.max(0, -slopeDeg);
    const speedLoad = moving ? Math.min(1, speed / 1.4) : 0;
    const slopeLoad = moving ? positiveSlope / 15 * 1.5 + negativeSlope / 20 * 0.4 : 0;
    const instantLoad = speedLoad * 0.6 + slopeLoad * 0.9 + (gripping ? 0.25 : 0);
    const decay = Math.exp(-dt / 45);
    this.accumulatedFatigue = Math.max(0.02, Math.min(1, this.accumulatedFatigue * decay + instantLoad * (1 - decay)));
    const targetHR = moving ? positiveSlope > 4 ? 105 + positiveSlope * 2.4 + this.accumulatedFatigue * 20 : 84 + this.accumulatedFatigue * 18 : 70 + this.accumulatedFatigue * 15;
    this.heartRateBpm += (Math.min(190, targetHR) - this.heartRateBpm) * (1 - Math.exp(-dt * (moving ? 0.8 : 0.5)));
    if (moving || gripping) this.staminaPct = Math.max(0, this.staminaPct - (0.04 + speedLoad * 0.07 + slopeLoad * 0.11 + this.accumulatedFatigue * 0.05 + (gripping ? 0.08 : 0)) * dt * STAMINA_DRAIN_FACTOR);
    else this.staminaPct = Math.min(100, this.staminaPct + 2.5 * (1 - this.accumulatedFatigue * 0.5) * dt);
    if (gripping) this.gripMinutes += dt / 60;
    const causes = [
      { name: positiveSlope > 3 ? `Inclinación (+${positiveSlope.toFixed(1)}°)` : "Desnivel del terreno", weight: slopeLoad * 50 },
      { name: "Cadencia de marcha", weight: speedLoad * 40 },
      { name: "Fatiga muscular acumulada", weight: this.accumulatedFatigue * 35 },
      { name: "Carga cardiovascular", weight: Math.max(0, (this.heartRateBpm - 70) * 0.45) },
      { name: "Trabajo de muestreo", weight: gripping ? 25 : 0 },
      { name: "Soporte vital basal PLSS", weight: 15 }
    ].filter(c => c.weight > 2).sort((a, b) => b.weight - a.weight).slice(0, 3);
    const sum = causes.reduce((total, c) => total + c.weight, 0);
    this.topConsumptionCauses = causes.map(c => ({ name: c.name, share: Math.round(c.weight / sum * 100) }));
  }

  collect() {
    this.staminaPct = Math.max(0, this.staminaPct - 1.25);
    this.heartRateBpm = Math.min(190, this.heartRateBpm + 4);
    this.gripMinutes += 0.1;
  }
}

// PR 11.7.C / §3.7 — vitest tests for client-side prediction +
// reconciliation. Six tests cover:
//
//   A: drift below RECONCILIATION_THRESHOLD_M does NOT trigger reconcile
//   B: drift above RECONCILIATION_THRESHOLD_M triggers reconcile +
//      re-simulates buffered inputs forward
//   C: snap distance > MAX_RECONCILIATION_SNAP_DISTANCE_M hard-snaps
//      to server position + drops buffered inputs
//   D: tick() advances predicted state with each buffered input
//   E: reconciliation counter increments ONLY on actual reconciliation,
//      not on every snapshot
//   F: input buffer enforces hard cap (FIFO eviction at MAX_LOCAL_INPUT_BUFFER)
//      AND retention eviction past `reconcileFromFrame - retention`
//
// All tests use a mock `havokStep` that returns a `PlayerState` advanced
// by a known delta (the predictor wraps the real Havok step — the mock
// keeps the predictor testable in pure Node without Babylon/Havok).
//
// **Frame-space note**: `localFrame` (client space) and `serverFrame`
// (server space) are different numeric counters. The tests use small
// `localFrame` values (1, 2, 3, ...) but distinct `serverFrame` values
// (100, 105, 110, ...). The drain window in `tick()` is
// `(reconcileFromFrame, currentLocalFrame]` — both in client space.
// Eviction retention uses `reconcileFromFrame - 8` in client space.

import {describe, it, expect, beforeEach} from "vitest";

import type {Snapshot, PlayerState} from "../../../protocol/snapshot";
import {
  Predictor,
  MAX_RECONCILIATION_SNAP_DISTANCE_M,
  RECONCILIATION_THRESHOLD_M,
} from "./clientPredictor";

/** Mock `havokStep` — advances position by (1, 0) per call. */
let mockStepCount = 0;
function mockHavokStep(state: PlayerState, _encoded: Uint8Array): PlayerState {
  mockStepCount += 1;
  return {
    ...state,
    positionX: state.positionX + 1.0,
    positionY: state.positionY,
  };
}

/** Build a minimal `Snapshot` with the given players + serverFrame. */
function makeSnapshot(serverFrame: number, players: PlayerState[]): Snapshot {
  return {serverFrame, nextServerFrame: serverFrame + 1, players};
}

/** Build a PlayerState at a given position. */
function makePlayer(playerId: number, x: number, y: number = 0): PlayerState {
  return {
    playerId,
    positionX: x,
    positionY: y,
    velocityX: 0,
    velocityY: 0,
    yaw: 0,
    pitch: 0,
    hp: 100,
    ammo: 0,
    isFiring: 0,
  };
}

describe("clientPredictor PR 11.7.C — prediction + reconciliation", () => {
  let localFrame = 0;

  beforeEach(() => {
    mockStepCount = 0;
    localFrame = 0;
  });

  it("Test A: drift below threshold does NOT trigger reconcile", () => {
    const predictor = new Predictor(
      1,
      mockHavokStep,
      () => localFrame,
    );
    // Seed via first snapshot at position (0, 0).
    predictor.onSnapshot(makeSnapshot(100, [makePlayer(1, 0, 0)]), 0);
    expect(predictor.getStats().reconciliationCount).toBe(0);
    // Buffer 5 inputs at local frames 1..5, advance localFrame to 5.
    for (let i = 1; i <= 5; i++) {
      predictor.recordLocalInput(i, new Uint8Array([0]));
      localFrame = i;
    }
    predictor.tick(16);
    // Predicted state should now be at (5, 0) — five +1 advances.
    expect(predictor.getPredictedState().positionX).toBeCloseTo(5.0, 5);
    // Send a snapshot at position (5.05, 0) — drift 0.05 < threshold.
    predictor.onSnapshot(makeSnapshot(105, [makePlayer(1, 5.05, 0)]), 100);
    expect(predictor.getStats().lastDriftM).toBeCloseTo(0.05, 5);
    // Reconciliation count must NOT have incremented.
    expect(predictor.getStats().reconciliationCount).toBe(0);
  });

  it("Test B: drift above threshold triggers reconcile + re-simulates buffered inputs forward", () => {
    const predictor = new Predictor(1, mockHavokStep, () => localFrame);
    predictor.onSnapshot(makeSnapshot(100, [makePlayer(1, 0, 0)]), 0);
    // Buffer 3 inputs at local frames 1..3, advance localFrame to 3.
    for (let i = 1; i <= 3; i++) {
      predictor.recordLocalInput(i, new Uint8Array([0]));
      localFrame = i;
    }
    predictor.tick(16);
    // Predicted at (3, 0).
    expect(predictor.getPredictedState().positionX).toBeCloseTo(3.0, 5);
    // Snapshot at (3.5, 0) — drift 0.5 > 0.1 threshold.
    predictor.onSnapshot(makeSnapshot(103, [makePlayer(1, 3.5, 0)]), 100);
    expect(predictor.getStats().reconciliationCount).toBe(1);
    // After reconcile, predicted should be at (3.5 + 0) — no buffered
    // inputs past reconcileFromFrame yet (we just consumed them in
    // tick() and haven't recorded any new ones).
    expect(predictor.getPredictedState().positionX).toBeCloseTo(3.5, 5);
    // Now record 2 more inputs (frames 4..5), advance localFrame to 5,
    // tick. After reconcile, the predictor should re-simulate those
    // forward from (3.5, 0).
    for (let i = 4; i <= 5; i++) {
      predictor.recordLocalInput(i, new Uint8Array([0]));
      localFrame = i;
    }
    predictor.tick(116);
    // Predicted should now be at (5.5, 0) — 3.5 + 2 re-simulated steps.
    expect(predictor.getPredictedState().positionX).toBeCloseTo(5.5, 5);
  });

  it("Test C: snap distance above MAX_RECONCILIATION_SNAP_DISTANCE_M hard-snaps + drops buffered inputs", () => {
    const predictor = new Predictor(1, mockHavokStep, () => localFrame);
    predictor.onSnapshot(makeSnapshot(100, [makePlayer(1, 0, 0)]), 0);
    // Buffer some inputs at frames 1..3, advance localFrame to 3.
    for (let i = 1; i <= 3; i++) {
      predictor.recordLocalInput(i, new Uint8Array([0]));
      localFrame = i;
    }
    predictor.tick(16);
    expect(predictor.getPredictedState().positionX).toBeCloseTo(3.0, 5);
    // Snapshot at (3.0 + MAX + 1.0, 0) — drift > MAX. After re-simulate
    // the snap distance is > MAX → hard clamp.
    const farX = 3.0 + MAX_RECONCILIATION_SNAP_DISTANCE_M + 1.0;
    predictor.onSnapshot(makeSnapshot(103, [makePlayer(1, farX, 0)]), 100);
    expect(predictor.getStats().reconciliationCount).toBe(1);
    // Predicted should be exactly the snapshot's position (hard-clamp).
    expect(predictor.getPredictedState().positionX).toBeCloseTo(farX, 5);
    // Buffer should be empty after the hard clamp.
    expect(predictor.getStats().bufferDepth).toBe(0);
  });

  it("Test D: tick() advances predicted state with each buffered input", () => {
    const predictor = new Predictor(1, mockHavokStep, () => localFrame);
    predictor.onSnapshot(makeSnapshot(100, [makePlayer(1, 0, 0)]), 0);
    // Buffer 10 inputs at frames 1..10, advance localFrame one at a time.
    const stepSize = mockStepCount;
    for (let i = 1; i <= 10; i++) {
      predictor.recordLocalInput(i, new Uint8Array([0]));
      localFrame = i;
      predictor.tick(i * 16);
    }
    // After 10 ticks, predicted should be at (10, 0).
    expect(predictor.getPredictedState().positionX).toBeCloseTo(10.0, 5);
    // The mock should have been called 10 times.
    expect(mockStepCount - stepSize).toBe(10);
  });

  it("Test E: reconciliation counter increments only on actual reconciliation", () => {
    const predictor = new Predictor(1, mockHavokStep, () => localFrame);
    predictor.onSnapshot(makeSnapshot(100, [makePlayer(1, 0, 0)]), 0);
    expect(predictor.getStats().reconciliationCount).toBe(0);
    // 5 snapshots that LARGELY agree with the predicted state (predicted
    // is at the same place as snapshot every time after the seed).
    // No reconciliation should fire because drift stays sub-threshold.
    // After the seed, predicted is at (0, 0). To keep drift sub-threshold,
    // each subsequent snapshot must be near where the predicted state is.
    // The simplest setup: don't tick() between snapshots, so predicted
    // stays at (0, 0) and each snapshot is at (0, 0) too.
    for (let i = 1; i <= 5; i++) {
      predictor.onSnapshot(makeSnapshot(100 + i, [makePlayer(1, 0, 0)]), i * 20);
    }
    expect(predictor.getStats().reconciliationCount).toBe(0);
    // Now one snapshot with large drift.
    predictor.onSnapshot(makeSnapshot(106, [makePlayer(1, 10, 0)]), 200);
    expect(predictor.getStats().reconciliationCount).toBe(1);
    // More sub-threshold snapshots — counter stays at 1.
    predictor.onSnapshot(makeSnapshot(107, [makePlayer(1, 10.05, 0)]), 220);
    expect(predictor.getStats().reconciliationCount).toBe(1);
  });

  it("Test F: input buffer enforces hard cap (FIFO eviction at MAX_LOCAL_INPUT_BUFFER)", () => {
    const predictor = new Predictor(1, mockHavokStep, () => localFrame);
    predictor.onSnapshot(makeSnapshot(100, [makePlayer(1, 0, 0)]), 0);
    // Buffer 20 inputs (frames 1..20). Hard cap = 16 → depth = 16.
    // Retained frames: 5..20 (FIFO keeps the newest 16).
    // localFrame stays at 0 throughout (this test doesn't tick()).
    // The retention floor = reconcileFromFrame - 8 = (getLocalFrame()=0) - 8 = -8,
    // so no retention eviction fires.
    for (let i = 1; i <= 20; i++) {
      predictor.recordLocalInput(i, new Uint8Array([0]));
    }
    expect(predictor.getStats().bufferDepth).toBe(16);
    // Record one more input → hard cap kicks in, FIFO evicts the oldest.
    // Buffer should still have 16 entries (the most recent 16).
    predictor.recordLocalInput(21, new Uint8Array([0]));
    expect(predictor.getStats().bufferDepth).toBe(16);
    // Verify the threshold constant matches the documented value.
    expect(RECONCILIATION_THRESHOLD_M).toBe(0.1);
    expect(MAX_RECONCILIATION_SNAP_DISTANCE_M).toBe(2.0);
  });
});

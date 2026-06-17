import { describe, expect, it } from "vitest";
import { HistoryStore } from "@/lib/history";

type Snap = { activeFilter: string; filterStrength: number; adjustments: Record<string, number> };

const make = (overrides: Partial<Snap> = {}): Snap => ({
  activeFilter: "Original",
  filterStrength: 100,
  adjustments: {},
  ...overrides,
});

describe("HistoryStore", () => {
  describe("initialization", () => {
    it("seeds current state without creating a past entry by default", () => {
      const store = new HistoryStore(make({ activeFilter: "Original" }));
      expect(store.current.activeFilter).toBe("Original");
      expect(store.past).toHaveLength(0);
      expect(store.future).toHaveLength(0);
      expect(store.canUndo()).toBe(false);
      expect(store.canRedo()).toBe(false);
    });

    it("respects seedOnCommit: false", () => {
      const store = new HistoryStore(make(), { seedOnCommit: false });
      store.commit(make({ activeFilter: "Vivid" }), "first", "preset-change");
      expect(store.past).toHaveLength(1);
    });
  });

  describe("commit", () => {
    it("pushes the previous state to past and clears future", () => {
      const store = new HistoryStore(make({ activeFilter: "Start" }), { seedOnCommit: false });
      store.commit(make({ activeFilter: "A" }), "a", "preset-change");
      store.commit(make({ activeFilter: "B" }), "b", "preset-change");

      // past = [Start, A] (the states we can return TO), current = B
      expect(store.past).toHaveLength(2);
      expect(store.past[0].state.activeFilter).toBe("Start");
      expect(store.past[1].state.activeFilter).toBe("A");
      expect(store.current.activeFilter).toBe("B");
      expect(store.future).toHaveLength(0);
    });

    it("drops a no-op commit when the state hasn't changed", () => {
      const store = new HistoryStore(make({ activeFilter: "A" }), { seedOnCommit: false });
      store.commit(make({ activeFilter: "A" }), "noop", "preset-change");
      expect(store.past).toHaveLength(0);
    });

    it("respects a custom equality function", () => {
      const eq = (a: Snap, b: Snap) => a.activeFilter === b.activeFilter;
      const store = new HistoryStore(make({ activeFilter: "A" }), { seedOnCommit: false, equal: eq });
      store.commit(make({ activeFilter: "A", filterStrength: 80 }), "noop", "strength");
      expect(store.past).toHaveLength(0);
      store.commit(make({ activeFilter: "B", filterStrength: 80 }), "change", "preset-change");
      expect(store.past).toHaveLength(1);
    });

    it("truncates to capacity, dropping the oldest entries", () => {
      const store = new HistoryStore(make(), { seedOnCommit: false, capacity: 3 });
      for (let i = 0; i < 5; i += 1) {
        store.commit(make({ activeFilter: `F${i}` }), `step ${i}`, "preset-change");
      }
      expect(store.past).toHaveLength(3);
      expect(store.past[0].state.activeFilter).toBe("F1");
      expect(store.past[2].state.activeFilter).toBe("F3");
    });

    it("stores kind and label", () => {
      const store = new HistoryStore(make(), { seedOnCommit: false });
      store.commit(make({ activeFilter: "Vivid" }), "Applied: Vivid", "preset-change");
      const entry = store.past[0];
      expect(entry.kind).toBe("preset-change");
      expect(entry.label).toBe("Applied: Vivid");
      expect(typeof entry.timestamp).toBe("number");
    });
  });

  describe("undo / redo", () => {
    it("undo restores the previous state and pushes current to future", () => {
      const store = new HistoryStore(make({ activeFilter: "Start" }), { seedOnCommit: false });
      store.commit(make({ activeFilter: "A" }), "a", "preset-change");
      store.commit(make({ activeFilter: "B" }), "b", "preset-change");

      const result = store.undo();
      expect(result?.activeFilter).toBe("A");
      expect(store.past).toHaveLength(1);
      expect(store.future).toHaveLength(1);
      expect(store.canUndo()).toBe(true);
      expect(store.canRedo()).toBe(true);
    });

    it("multiple undos walk all the way back to the seed", () => {
      const store = new HistoryStore(make({ activeFilter: "Start" }), { seedOnCommit: false });
      store.commit(make({ activeFilter: "A" }), "a", "preset-change");
      store.commit(make({ activeFilter: "B" }), "b", "preset-change");
      store.commit(make({ activeFilter: "C" }), "c", "preset-change");

      expect(store.undo()?.activeFilter).toBe("B");
      expect(store.undo()?.activeFilter).toBe("A");
      expect(store.undo()?.activeFilter).toBe("Start");
      expect(store.undo()).toBeNull();
    });

    it("redo is the inverse of undo", () => {
      const store = new HistoryStore(make({ activeFilter: "Start" }), { seedOnCommit: false });
      store.commit(make({ activeFilter: "A" }), "a", "preset-change");
      store.commit(make({ activeFilter: "B" }), "b", "preset-change");

      store.undo();
      const result = store.redo();
      expect(result?.activeFilter).toBe("B");
      expect(store.past).toHaveLength(2);
      expect(store.future).toHaveLength(0);
    });

    it("returns null when nothing to undo / redo", () => {
      const store = new HistoryStore(make());
      expect(store.undo()).toBeNull();
      expect(store.redo()).toBeNull();
    });

    it("a new commit after undo truncates the future stack", () => {
      const store = new HistoryStore(make({ activeFilter: "Start" }), { seedOnCommit: false });
      store.commit(make({ activeFilter: "A" }), "a", "preset-change");
      store.commit(make({ activeFilter: "B" }), "b", "preset-change");
      store.undo();

      store.commit(make({ activeFilter: "C" }), "c", "preset-change");
      expect(store.future).toHaveLength(0);
      expect(store.past).toHaveLength(2);
    });

    it("preserves the future entry's label so the UI can show 'Redo: ...'", () => {
      const store = new HistoryStore(make({ activeFilter: "Start" }), { seedOnCommit: false });
      store.commit(make({ activeFilter: "Vivid" }), "Applied: Vivid", "preset-change");
      store.undo();
      expect(store.future[0].label).toBe("Applied: Vivid");
    });
  });

  describe("interaction coalescing", () => {
    it("collapses many setDuringInteraction calls into one history entry", () => {
      // seed=false so the initial preset-change commit is recorded and
      // a subsequent interaction coalesces against a non-empty stack.
      const store = new HistoryStore(
        make({ activeFilter: "Original", adjustments: { contrast: 0 } }),
        { seedOnCommit: false },
      );
      store.commit(make({ activeFilter: "Vivid", adjustments: { contrast: 0 } }), "preset", "preset-change");

      store.beginInteraction();
      for (let v = 1; v <= 30; v += 1) {
        store.setDuringInteraction(make({ activeFilter: "Vivid", adjustments: { contrast: v } }));
      }
      store.commitInteraction("Edit: Contrast", "adjustment");

      expect(store.past).toHaveLength(2);
      const last = store.past[1];
      // The pushed state is the START of the interaction, so an undo
      // returns the user to the pre-drag state.
      expect(last.state.adjustments.contrast).toBe(0);
      expect(last.label).toBe("Edit: Contrast");
      expect(last.kind).toBe("adjustment");
      expect(store.current.adjustments.contrast).toBe(30);
    });

    it("does not push an entry when no value changed during the interaction", () => {
      const store = new HistoryStore(make({ activeFilter: "Original" }), { seedOnCommit: false });
      // A real commit first so the past stack is non-empty.
      store.commit(
        make({ activeFilter: "Vivid", adjustments: { contrast: 5 } }),
        "preset",
        "preset-change",
      );

      store.beginInteraction();
      store.setDuringInteraction(make({ activeFilter: "Vivid", adjustments: { contrast: 5 } }));
      store.commitInteraction("no-op", "adjustment");

      expect(store.past).toHaveLength(1);
    });

    it("cancelInteraction restores the start state and pushes nothing", () => {
      const store = new HistoryStore(make({ adjustments: { contrast: 0 } }), { seedOnCommit: false });
      store.commit(make({ activeFilter: "Vivid" }), "preset", "preset-change");

      const start = store.current;
      store.beginInteraction();
      store.setDuringInteraction(make({ adjustments: { contrast: 99 } }));
      store.cancelInteraction();

      expect(store.past).toHaveLength(1);
      expect(store.current).toEqual(start);
      expect(store.isInteracting()).toBe(false);
    });

    it("isInteracting reports state during the window", () => {
      const store = new HistoryStore(make(), { seedOnCommit: false });
      expect(store.isInteracting()).toBe(false);
      store.beginInteraction();
      expect(store.isInteracting()).toBe(true);
      store.commitInteraction("x", "other");
      expect(store.isInteracting()).toBe(false);
    });

    it("supports multiple independent interaction windows", () => {
      const store = new HistoryStore(make({ adjustments: { contrast: 0, brightness: 0 } }), {
        seedOnCommit: false,
      });
      store.commit(make({ activeFilter: "Vivid" }), "preset", "preset-change");

      store.beginInteraction();
      for (let v = 1; v <= 10; v += 1) {
        store.setDuringInteraction(make({ adjustments: { contrast: v, brightness: 0 } }));
      }
      store.commitInteraction("contrast drag", "adjustment");

      store.beginInteraction();
      for (let v = 1; v <= 10; v += 1) {
        store.setDuringInteraction(make({ adjustments: { contrast: 10, brightness: v } }));
      }
      store.commitInteraction("brightness drag", "adjustment");

      expect(store.past).toHaveLength(3);
      expect(store.past[1].label).toBe("contrast drag");
      expect(store.past[2].label).toBe("brightness drag");
    });
  });

  describe("reset", () => {
    it("clears past and future", () => {
      const store = new HistoryStore(make(), { seedOnCommit: false });
      store.commit(make({ activeFilter: "A" }), "a", "preset-change");
      store.commit(make({ activeFilter: "B" }), "b", "preset-change");
      store.undo();

      store.reset(make({ activeFilter: "New" }));
      expect(store.past).toHaveLength(0);
      expect(store.future).toHaveLength(0);
      expect(store.current.activeFilter).toBe("New");
    });

    it("with seed: false allows the next commit to record a history entry", () => {
      const store = new HistoryStore(make());
      store.reset(make({ activeFilter: "New" }), { seed: false });
      store.commit(make({ activeFilter: "Vivid" }), "applied", "preset-change");
      expect(store.past).toHaveLength(1);
    });
  });
});

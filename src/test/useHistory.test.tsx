import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHistory, type EditorSnapshot } from "@/hooks/useHistory";
import { defaultAdjustments } from "@/lib/filter-engine";

const baseSnapshot = (overrides: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
  activeFilter: "Original",
  filterStrength: 100,
  effectIntensity: 100,
  adjustments: { ...defaultAdjustments },
  ...overrides,
});

describe("useHistory", () => {
  describe("initial state", () => {
    it("starts with the supplied snapshot and nothing to undo or redo", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      expect(result.current.state).toEqual(baseSnapshot());
      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(false);
      expect(result.current.past).toHaveLength(0);
      expect(result.current.future).toHaveLength(0);
    });
  });

  describe("apply (seed semantics)", () => {
    it("the first apply is the seed: state updates, no past entry is created", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      act(() => {
        result.current.apply(baseSnapshot({ activeFilter: "Vivid" }), "Applied: Vivid", "preset-change");
      });
      expect(result.current.state.activeFilter).toBe("Vivid");
      expect(result.current.canUndo).toBe(false);
      expect(result.current.past).toHaveLength(0);
    });

    it("a second apply with a different state records a history entry", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      act(() => {
        result.current.apply(baseSnapshot({ activeFilter: "Vivid" }), "Vivid", "preset-change");
        result.current.apply(baseSnapshot({ activeFilter: "Mono" }), "Mono", "preset-change");
      });
      expect(result.current.state.activeFilter).toBe("Mono");
      expect(result.current.canUndo).toBe(true);
      expect(result.current.past).toHaveLength(1);
    });
  });

  describe("undo / redo", () => {
    it("undo restores the prior snapshot; redo reapplies it", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      act(() => {
        result.current.apply(baseSnapshot({ activeFilter: "A" }), "A", "preset-change");
        result.current.apply(baseSnapshot({ activeFilter: "B" }), "B", "preset-change");
      });

      act(() => result.current.undo());
      expect(result.current.state.activeFilter).toBe("A");
      expect(result.current.canRedo).toBe(true);

      act(() => result.current.redo());
      expect(result.current.state.activeFilter).toBe("B");
      expect(result.current.canRedo).toBe(false);
    });

    it("a new apply after undo truncates the future stack", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      act(() => {
        result.current.apply(baseSnapshot({ activeFilter: "A" }), "A", "preset-change");
        result.current.apply(baseSnapshot({ activeFilter: "B" }), "B", "preset-change");
      });
      act(() => result.current.undo());
      act(() => {
        result.current.apply(baseSnapshot({ activeFilter: "C" }), "C", "preset-change");
      });

      expect(result.current.future).toHaveLength(0);
      expect(result.current.canRedo).toBe(false);
    });

    it("is a no-op when there is nothing to undo or redo", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      act(() => result.current.undo());
      act(() => result.current.redo());
      expect(result.current.state).toEqual(baseSnapshot());
    });
  });

  describe("interaction coalescing", () => {
    it("collapses 30 setDuringInteraction calls into a single history entry", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      act(() => {
        // First apply seeds.
        result.current.apply(baseSnapshot({ activeFilter: "Vivid" }), "Vivid", "preset-change");
        // Second apply with a non-zero adjustment pushes one history entry.
        result.current.apply(
          baseSnapshot({ activeFilter: "Vivid", adjustments: { ...defaultAdjustments, contrast: 7 } }),
          "preset+contrast",
          "preset-change",
        );
      });
      expect(result.current.past).toHaveLength(1);
      expect(result.current.state.adjustments.contrast).toBe(7);

      act(() => {
        result.current.beginInteraction();
        for (let v = 8; v <= 37; v += 1) {
          result.current.setDuringInteraction(
            baseSnapshot({
              activeFilter: "Vivid",
              adjustments: { ...defaultAdjustments, contrast: v },
            }),
          );
        }
        result.current.commitInteraction("Edit: Contrast", "adjustment");
      });

      expect(result.current.past).toHaveLength(2);
      expect(result.current.state.adjustments.contrast).toBe(37);
      act(() => result.current.undo());
      expect(result.current.state.adjustments.contrast).toBe(7);
    });

    it("does not push a history entry when the interaction is a no-op", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      // One apply to seed; a real apply to push a history entry;
      // then an interaction that doesn't change the state.
      act(() => {
        result.current.apply(baseSnapshot({ activeFilter: "Vivid" }), "Vivid", "preset-change");
        result.current.apply(
          baseSnapshot({ activeFilter: "Vivid", adjustments: { ...defaultAdjustments, contrast: 5 } }),
          "preset+contrast",
          "preset-change",
        );
      });
      expect(result.current.past).toHaveLength(1);

      act(() => {
        result.current.beginInteraction();
        // The drag leaves the value unchanged: commitInteraction
        // compares the start state to the final state and drops
        // the entry if they are equal.
        result.current.setDuringInteraction(
          baseSnapshot({ activeFilter: "Vivid", adjustments: { ...defaultAdjustments, contrast: 5 } }),
        );
        result.current.commitInteraction("noop drag", "adjustment");
      });

      expect(result.current.past).toHaveLength(1);
    });

    it("cancelInteraction reverts the in-flight state without pushing", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      act(() => {
        result.current.apply(baseSnapshot({ activeFilter: "Vivid" }), "Vivid", "preset-change");
        result.current.apply(
          baseSnapshot({ activeFilter: "Vivid", adjustments: { ...defaultAdjustments, contrast: 5 } }),
          "preset+contrast",
          "preset-change",
        );
      });
      const before = result.current.state;
      act(() => {
        result.current.beginInteraction();
        result.current.setDuringInteraction(
          baseSnapshot({
            activeFilter: "Vivid",
            adjustments: { ...defaultAdjustments, contrast: 99 },
          }),
        );
        result.current.cancelInteraction();
      });

      expect(result.current.state).toEqual(before);
      expect(result.current.past).toHaveLength(1);
    });
  });

  describe("reset", () => {
    it("wipes past and future and reseeds", () => {
      const { result } = renderHook(() => useHistory(baseSnapshot()));
      act(() => {
        result.current.apply(baseSnapshot({ activeFilter: "A" }), "A", "preset-change");
        result.current.apply(baseSnapshot({ activeFilter: "B" }), "B", "preset-change");
      });
      act(() => result.current.undo());

      act(() => result.current.reset(baseSnapshot({ activeFilter: "New" })));
      expect(result.current.state.activeFilter).toBe("New");
      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(false);
    });
  });
});

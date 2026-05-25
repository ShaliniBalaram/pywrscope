// src/hooks/useLayout.ts
// Manages node positions and background image settings for the canvas.
// Reads/writes a .layout.json sidecar file alongside the model JSON file.
// The sidecar is never sent to the Flask backend — it is a frontend concern.

import React, { useState, useCallback } from "react";
import { computeDagreLayout } from "../utils/dagreLayout";
import type { PywrEdge } from "../types/pywr";

interface NodePosition {
  x: number;
  y: number;
}

interface LayoutSidecar {
  version: 1;
  nodes: Record<string, NodePosition>;
  backgroundImage: string | null;
  backgroundOpacity: number;
}

export interface UseLayoutReturn {
  positions: Record<string, NodePosition>;
  backgroundImage: string | null;
  backgroundOpacity: number;
  setPosition: (nodeName: string, x: number, y: number) => void;
  setAllPositions: (positions: Record<string, NodePosition>) => void;
  renamePosition: (oldName: string, newName: string) => void;
  setBackgroundImage: (path: string) => void;
  setBackgroundOpacity: (opacity: number) => void;
  resetLayout: () => void;
  loadLayout: (modelJsonPath: string) => Promise<boolean>;
  saveLayout: (modelJsonPath: string) => Promise<void>;
  autoLayout: (nodes: string[]) => void;
  dagreLayout: (nodes: string[], edges: PywrEdge[]) => void;
  pushPositionHistory: () => void;
  undoPositions: () => void;
  redoPositions: () => void;
  canUndoPositions: boolean;
  canRedoPositions: boolean;
}

function sidecarPath(modelJsonPath: string): string {
  // Replace the .json extension with .layout.json
  return modelJsonPath.replace(/\.json$/, ".layout.json");
}

function clampOpacity(opacity: number): number {
  return Math.min(0.9, Math.max(0.1, opacity));
}

function computeAutoLayout(nodes: string[]): Record<string, NodePosition> {
  const COLS = 5;
  const H_SPACING = 130;
  const V_SPACING = 100;
  const START_X = 60;
  const START_Y = 60;

  const positions: Record<string, NodePosition> = {};
  nodes.forEach((name, index) => {
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    positions[name] = {
      x: START_X + col * H_SPACING,
      y: START_Y + row * V_SPACING,
    };
  });
  return positions;
}

export function useLayout(): UseLayoutReturn {
  const [positions, setPositions] = useState<Record<string, NodePosition>>({});
  const [backgroundImage, setBackgroundImageState] = useState<string | null>(null);
  const [backgroundOpacity, setBackgroundOpacityState] = useState<number>(0.4);

  // Position undo/redo — separate from model undo so layout can be independently undone
  const [positionPast, setPositionPast] = useState<Record<string, NodePosition>[]>([]);
  const [positionFuture, setPositionFuture] = useState<Record<string, NodePosition>[]>([]);
  // Keep a ref so callbacks always read the latest positions without stale closures
  const positionsRef = React.useRef<Record<string, NodePosition>>(positions);
  React.useEffect(() => { positionsRef.current = positions; }, [positions]);

  const setPosition = useCallback((nodeName: string, x: number, y: number) => {
    setPositions((prev) => ({
      ...prev,
      [nodeName]: { x, y },
    }));
  }, []);

  const setAllPositions = useCallback((newPositions: Record<string, NodePosition>) => {
    setPositions(newPositions);
  }, []);

  const renamePosition = useCallback((oldName: string, newName: string) => {
    setPositions((prev) => {
      if (!(oldName in prev)) return prev;
      const { [oldName]: pos, ...rest } = prev;
      return { ...rest, [newName]: pos };
    });
  }, []);

  const setBackgroundImage = useCallback((path: string) => {
    setBackgroundImageState(path);
  }, []);

  const setBackgroundOpacity = useCallback((opacity: number) => {
    setBackgroundOpacityState(clampOpacity(opacity));
  }, []);

  const resetLayout = useCallback(() => {
    setPositions({});
    setPositionPast([]);
    setPositionFuture([]);
    setBackgroundImageState(null);
    setBackgroundOpacityState(0.4);
  }, []);

  const pushPositionHistory = useCallback(() => {
    const snapshot = positionsRef.current;
    setPositionPast((prev) => [...prev.slice(-49), snapshot]);
    setPositionFuture([]);
  }, []);

  const undoPositions = useCallback(() => {
    setPositionPast((prev) => {
      if (prev.length === 0) return prev;
      const restored = prev[prev.length - 1];
      setPositionFuture((f) => [positionsRef.current, ...f.slice(0, 49)]);
      setPositions(restored);
      return prev.slice(0, -1);
    });
  }, []);

  const redoPositions = useCallback(() => {
    setPositionFuture((prev) => {
      if (prev.length === 0) return prev;
      const restored = prev[0];
      setPositionPast((p) => [...p.slice(-49), positionsRef.current]);
      setPositions(restored);
      return prev.slice(1);
    });
  }, []);

  const autoLayout = useCallback((nodes: string[]) => {
    setPositions(computeAutoLayout(nodes));
  }, []);

  const dagreLayout = useCallback((nodes: string[], edges: PywrEdge[]) => {
    setPositions(computeDagreLayout(nodes, edges));
  }, []);

  // Returns true if positions were found in the sidecar, false if not.
  // Caller uses this to decide whether to fall back to auto-layout.
  const loadLayout = useCallback(async (modelJsonPath: string): Promise<boolean> => {
    const path = sidecarPath(modelJsonPath);
    const raw = await window.pywr.readLayoutFile(path);

    if (raw === null) {
      // No sidecar exists
      setPositions({});
      setBackgroundImageState(null);
      setBackgroundOpacityState(0.4);
      return false;
    }

    let sidecar: LayoutSidecar;
    try {
      sidecar = JSON.parse(raw);
    } catch {
      // Corrupted sidecar file — treat as if no sidecar exists
      setPositions({});
      setBackgroundImageState(null);
      setBackgroundOpacityState(0.4);
      return false;
    }
    const nodes = sidecar.nodes ?? {};
    setPositions(nodes);
    setBackgroundImageState(sidecar.backgroundImage ?? null);
    setBackgroundOpacityState(clampOpacity(sidecar.backgroundOpacity ?? 0.4));
    return Object.keys(nodes).length > 0;
  }, []);

  const saveLayout = useCallback(
    async (modelJsonPath: string) => {
      const path = sidecarPath(modelJsonPath);
      const sidecar: LayoutSidecar = {
        version: 1,
        nodes: positions,
        backgroundImage,
        backgroundOpacity,
      };
      await window.pywr.saveLayoutFile(path, JSON.stringify(sidecar, null, 2));
    },
    [positions, backgroundImage, backgroundOpacity]
  );

  return {
    positions,
    backgroundImage,
    backgroundOpacity,
    setPosition,
    setAllPositions,
    renamePosition,
    setBackgroundImage,
    setBackgroundOpacity,
    resetLayout,
    loadLayout,
    saveLayout,
    autoLayout,
    dagreLayout,
    pushPositionHistory,
    undoPositions,
    redoPositions,
    canUndoPositions: positionPast.length > 0,
    canRedoPositions: positionFuture.length > 0,
  };
}

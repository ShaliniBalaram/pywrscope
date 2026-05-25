// src/hooks/useRecentFiles.ts
// Persists the last N opened file paths in localStorage.

import { useState, useCallback } from "react";

const KEY = "pywrscope-recent-files";
const MAX = 8;

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function save(files: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(files));
  } catch {
    // ignore quota errors
  }
}

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<string[]>(load);

  const addRecentFile = useCallback((path: string) => {
    setRecentFiles((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, MAX);
      save(next);
      return next;
    });
  }, []);

  const clearRecentFiles = useCallback(() => {
    setRecentFiles([]);
    save([]);
  }, []);

  return { recentFiles, addRecentFile, clearRecentFiles };
}

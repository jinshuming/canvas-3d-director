import { useCallback, useEffect, useRef, useState } from 'react';

import type { StageDoc } from '@stage';

import { api, ApiError } from './api.ts';

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';

export interface StageStore {
  doc: StageDoc | null;
  /** The latest doc, edits included - for code that runs between renders (the agent tools). */
  get: () => StageDoc | null;
  error: string | null;
  saveStatus: SaveStatus;
  /**
   * Change the doc. `commit: false` is a drag in progress: it shows and saves
   * but is not an undo step; the drag's final `update` commits.
   */
  update: (fn: (d: StageDoc) => StageDoc, opts?: { commit?: boolean; history?: false }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  retrySave: () => void;
  reloadLatest: () => void;
}

const SAVE_DELAY = 700;
const HISTORY = 100;

/** A stage, loaded from the server and saved back on every change (debounced, optimistic lock on `version`). */
export function useStage(id: string): StageStore {
  const [doc, setDoc] = useState<StageDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [, bump] = useState(0);
  const docRef = useRef<StageDoc | null>(null);
  const serverVersion = useRef(0);
  const past = useRef<StageDoc[]>([]);
  const future = useRef<StageDoc[]>([]);
  /** The doc before the drag in progress, pushed to history when it commits. */
  const dragBase = useRef<StageDoc | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const conflict = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await api.getStage(id);
      docRef.current = d;
      serverVersion.current = d.version;
      past.current = [];
      future.current = [];
      conflict.current = false;
      dirty.current = false;
      setDoc(d);
      setSaveStatus('saved');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (inFlight.current || !dirty.current || conflict.current || !docRef.current) return;
    inFlight.current = true;
    dirty.current = false;
    setSaveStatus('saving');
    const sent = docRef.current;
    let failed = false;
    try {
      const saved = await api.saveStage(sent, serverVersion.current);
      serverVersion.current = saved.version;
      // Edits made while saving stay; only the version moves on.
      if (docRef.current) {
        docRef.current = { ...docRef.current, version: saved.version, updatedAt: saved.updatedAt };
        setDoc(docRef.current);
      }
      setSaveStatus(dirty.current ? 'pending' : 'saved');
    } catch (e) {
      dirty.current = true;
      failed = true;
      if (e instanceof ApiError && e.status === 409) {
        conflict.current = true;
        setSaveStatus('conflict');
      } else {
        setSaveStatus('error');
      }
    } finally {
      inFlight.current = false;
      // Edits that came in mid-save go next; a failed save waits for a retry rather than hammering the server.
      if (dirty.current && !failed) timer.current = setTimeout(() => void flush(), SAVE_DELAY);
    }
  }, []);

  const schedule = useCallback(() => {
    dirty.current = true;
    if (conflict.current) return;
    setSaveStatus('pending');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY);
  }, [flush]);

  const update = useCallback<StageStore['update']>((fn, opts = {}) => {
    const cur = docRef.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    const commit = opts.commit ?? true;
    if (opts.history === false) {
      // Bookkeeping (a measured placement): saved, never undone.
    } else if (!commit) {
      dragBase.current ??= cur;
    } else {
      past.current.push(dragBase.current ?? cur);
      if (past.current.length > HISTORY) past.current.shift();
      future.current = [];
      dragBase.current = null;
    }
    docRef.current = next;
    setDoc(next);
    schedule();
  }, [schedule]);

  const step = useCallback((from: React.MutableRefObject<StageDoc[]>, to: React.MutableRefObject<StageDoc[]>) => {
    const cur = docRef.current;
    const prev = from.current.pop();
    if (!cur || !prev) return;
    to.current.push(cur);
    // History keeps content; the version is always the latest known.
    docRef.current = { ...prev, version: cur.version };
    setDoc(docRef.current);
    schedule();
    bump((n) => n + 1);
  }, [schedule]);

  // Leaving with unsaved edits: one last try.
  useEffect(() => {
    const onHide = () => { if (dirty.current) void flush(); };
    addEventListener('pagehide', onHide);
    return () => { removeEventListener('pagehide', onHide); onHide(); };
  }, [flush]);

  const get = useCallback(() => docRef.current, []);

  return {
    doc,
    get,
    error,
    saveStatus,
    update,
    undo: () => step(past, future),
    redo: () => step(future, past),
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    retrySave: () => { void flush(); },
    reloadLatest: () => { void load(); },
  };
}

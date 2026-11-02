// Generation pipeline wire contract — POST /api/generate + WS ticket delivery.
// Single source of truth for apps/server (producer) and apps/mobile|web (consumers).

import type { ResourceRef } from './common.js';
import type { WorldBook } from './resources.js';

// ---------- Request ----------

export const GENERATION_MODES = [
    'normal',
    'continue',
    'regenerate',
    'swipe',
    'impersonate',
] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

/** Prompt-level overrides applied for this call only (never persisted). */
export interface GenerationOverrides {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /** Instruct/context preset patch merged over presetRef. */
    presetPatch?: Record<string, unknown>;
}

/** Ephemeral document uploaded for assembly only — never persisted server-side. */
export interface EphemeralDocument {
    kind: 'worldbook' | 'regex' | 'preset' | 'other';
    name: string;
    document: WorldBook | Record<string, unknown>;
}

export interface GenerateRequest {
    /** Exactly one target: single character or group. */
    charRef?: { kind: 'character'; name: string };
    groupRef?: { kind: 'group'; id: string };
    chatRef: { kind: 'chat'; character: string; file: string };
    mode: GenerationMode;
    /** Required for mode=normal; ignored otherwise. */
    userText?: string;
    presetRef?: Extract<ResourceRef, { kind: 'preset' }>;
    overrides?: GenerationOverrides;
    ephemeralDocs?: EphemeralDocument[];
    /** For mode=swipe: which swipe index to produce (default: append). */
    swipeIndex?: number;
}

// ---------- Job handle ----------

export const JOB_STATUSES = [
    'queued',
    'assembling',
    'streaming',
    'postprocessing',
    'completed',
    'failed',
    'aborted',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface GenerateJobHandle {
    jobId: string;
    status: JobStatus;
    /** Monotonically increasing event cursor; client keeps lastEventId for resume. */
    lastEventId: number;
    createdAt: number;
}

export interface GenerateJobStatus extends GenerateJobHandle {
    /** Failure detail when status='failed'. */
    error?: { code: string; message: string };
    /** Present once persisted. */
    chatRef?: { kind: 'chat'; character: string; file: string };
    messageIndex?: number;
    swipeId?: number;
}

// ---------- Events (WS ticket stream) ----------

interface EventBase {
    /** Job-scoped monotonic id; resume with lastEventId + ack. */
    id: number;
    jobId: string;
    at: number;
}

export interface DeltaEvent extends EventBase {
    type: 'delta';
    /** Incremental text chunk of the assistant message. */
    text: string;
}

export interface ReasoningEvent extends EventBase {
    type: 'reasoning';
    text: string;
}

/** Assembled-prompt trace summary (full payload stays in request-inspector). */
export interface TraceEvent extends EventBase {
    type: 'trace';
    summary: {
        messageCount: number;
        tokenEstimate?: number;
        worldInfoInjected?: { key: string; position: string; depth?: number }[];
        regexApplied?: string[];
        warnings?: string[];
    };
}

/** Final assistant message, post-processed (regex/variables applied). */
export interface FinalEvent extends EventBase {
    type: 'final';
    message: {
        name: string;
        mes: string;
        swipeId: number;
        reasoning?: string;
        extra?: Record<string, unknown>;
    };
}

/** Chat JSONL + sidecar state persisted confirmation. */
export interface PersistedEvent extends EventBase {
    type: 'persisted';
    chatRef: { kind: 'chat'; character: string; file: string };
    messageIndex: number;
    /** Namespaces whose chat-state sidecars were written. */
    stateNamespaces?: string[];
}

export interface FailedEvent extends EventBase {
    type: 'failed';
    error: { code: string; message: string; retriable?: boolean };
    /** Partial streamed text preserved per swipe semantics, if any. */
    partialText?: string;
}

export type GenerateEvent =
    | DeltaEvent
    | ReasoningEvent
    | TraceEvent
    | FinalEvent
    | PersistedEvent
    | FailedEvent;

// ---------- WS ticket / resume ----------

/** Client → server on WS subscribe: which job stream to attach. */
export interface JobSubscribe {
    type: 'job.subscribe';
    jobId: string;
    /** Replay events after this id (ack grace ~15s server-side). */
    lastEventId?: number;
}

export interface JobAck {
    type: 'job.ack';
    jobId: string;
    /** Highest event id the client has durably consumed. */
    eventId: number;
}

export type ClientWsMessage = JobSubscribe | JobAck;

// ---------- Type guards ----------

export function isGenerateEvent(v: unknown): v is GenerateEvent {
    if (typeof v !== 'object' || v === null) return false;
    const t = (v as { type?: unknown }).type;
    return t === 'delta' || t === 'reasoning' || t === 'trace' ||
        t === 'final' || t === 'persisted' || t === 'failed';
}

export function isGenerateRequest(v: unknown): v is GenerateRequest {
    if (typeof v !== 'object' || v === null) return false;
    const r = v as Partial<GenerateRequest>;
    const targetOk = (r.charRef?.kind === 'character' && typeof r.charRef.name === 'string') ||
        (r.groupRef?.kind === 'group' && typeof r.groupRef.id === 'string');
    return targetOk &&
        r.chatRef?.kind === 'chat' &&
        GENERATION_MODES.includes(r.mode as GenerationMode);
}

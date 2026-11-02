// Common wire primitives shared by every endpoint family.

/** Opaque reference to a server-side resource. `kind` disambiguates polymorphic refs. */
export type ResourceRef =
    | { kind: 'character'; name: string }
    | { kind: 'group'; id: string }
    | { kind: 'chat'; character: string; file: string }
    | { kind: 'worldbook'; name: string }
    | { kind: 'preset'; category: PresetCategory; name: string };

export type PresetCategory =
    | 'openai'
    | 'textgenerationwebui'
    | 'kobold'
    | 'novel'
    | 'context'
    | 'instruct'
    | 'sysprompt'
    | 'reasoning'
    | 'movingUI'
    | 'quickReplies';

/** Standard error envelope returned by JSON endpoints. */
export interface ApiError {
    error: true;
    code: string;
    message: string;
    /** Optional machine-readable details (field violations, retry hints). */
    details?: Record<string, unknown>;
}

export interface UserProfile {
    handle: string;
    name: string;
    /** data: URL or server-relative avatar path. */
    avatar: string;
    admin: boolean;
    password: boolean;
}

/** POST endpoints require a CSRF token bound to the session cookie. */
export interface CsrfTokenResponse {
    token: string;
}

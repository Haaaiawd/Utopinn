// Ambience override model — each ambience parameter (wallpaper alpha, glass
// blur) resolves to one of two states:
//
//   OVERRIDDEN  (*_override flag === true): the user pinned a value; it is
//     written to documentElement as an inline custom property, which beats
//     every stylesheet declaration including power_user.custom_css.
//   FOLLOW CSS  (flag false or absent): nothing is written inline; the
//     cascade (tokens.css :root defaults / custom_css) owns the variable.
//     "Unset" — the user never touched the slider — is simply this state
//     on a fresh document.
//
// The flag is deliberately independent of the value: pinning a value that
// equals the stylesheet default must still write inline, otherwise the
// cascade falls back to custom_css and the slider looks dead (PR #62
// review repro: custom_css --amb-bg-alpha:0.45 + slider dragged onto the
// 0.62 default must render 0.62, not 0.45).
//
// Persisted slot: power_user.ui_ambience (snake_case). The settings PATCH
// merges this slot one level deeper than the section shallow-merge
// (server-side NESTED_MERGE_SLOTS), so keys a writer does not emit survive
// — e.g. tex_alpha orphans left in production docs by the removed texture
// feature. Writers still emit the complete known-key object, explicit false
// flags included, because explicit false is what clears a stored true:
//   { bg_alpha, glass_blur, bg_alpha_override?, glass_blur_override? }
// Documents written before the *_override keys existed hydrate as
// follow-CSS — their stored values are kept as slider positions but are
// never pinned inline.

export interface UiAmbience {
    /** Wallpaper dim alpha 0–0.9 (persisted as bg_alpha). */
    bgAlpha: number;
    /** Frosted-glass blur px 0–32 (persisted as glass_blur). */
    glassBlur: number;
    /** true = --amb-bg-alpha pinned inline; absent/false = stylesheet-owned. */
    bgAlphaOverride?: boolean;
    /** true = --amb-glass-blur pinned inline; absent/false = stylesheet-owned. */
    glassBlurOverride?: boolean;
}

export type UiAmbienceKey = 'bgAlpha' | 'glassBlur';

/** Must stay in sync with the :root --amb-* values in styles/tokens.css
 *  (pinned by tests/ambience-tokens.test.mjs). */
export const UI_AMBIENCE_DEFAULTS: UiAmbience = { bgAlpha: 0.62, glassBlur: 14 };

const clampNum = (v: unknown, d: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/** Hydrate the persisted ui_ambience slot (snake_case; camelCase legacy
 *  read). Missing *_override keys → follow-CSS, so pre-flag documents
 *  degrade to "unset" without errors. Non-object input → defaults. */
export function hydrateUiAmbience(raw: unknown): UiAmbience {
    const u = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? raw as Record<string, unknown> : {};
    return {
        bgAlpha: clampNum(u.bg_alpha ?? u.bgAlpha, UI_AMBIENCE_DEFAULTS.bgAlpha, 0, 0.9),
        glassBlur: clampNum(u.glass_blur ?? u.glassBlur, UI_AMBIENCE_DEFAULTS.glassBlur, 0, 32),
        bgAlphaOverride: (u.bg_alpha_override ?? u.bgAlphaOverride) === true,
        glassBlurOverride: (u.glass_blur_override ?? u.glassBlurOverride) === true,
    };
}

/** Persisted slot shape — the PATCH deep-merges ui_ambience, so keys this
 *  writer does not emit survive; this still emits the complete known-key
 *  object, flags included (explicit false clears a previously pinned flag). */
export function uiAmbienceSlot(a: UiAmbience): Record<string, unknown> {
    return {
        bg_alpha: a.bgAlpha,
        glass_blur: a.glassBlur,
        bg_alpha_override: a.bgAlphaOverride === true,
        glass_blur_override: a.glassBlurOverride === true,
    };
}

/** Inline custom-property plan per var: string = setProperty, null =
 *  removeProperty (hand the cascade back to stylesheets). */
export function ambienceInlineVars(a: UiAmbience): {
    '--amb-bg-alpha': string | null;
    '--amb-glass-blur': string | null;
} {
    return {
        '--amb-bg-alpha': a.bgAlphaOverride === true ? String(a.bgAlpha) : null,
        '--amb-glass-blur': a.glassBlurOverride === true ? `${a.glassBlur}px` : null,
    };
}

/** Slider touched → pin the value inline. The override flag is set
 *  regardless of the value, including when it equals the default. */
export function pinAmbience(a: UiAmbience, k: UiAmbienceKey, v: number): UiAmbience {
    return k === 'bgAlpha'
        ? { ...a, bgAlpha: v, bgAlphaOverride: true }
        : { ...a, glassBlur: v, glassBlurOverride: true };
}

/** "Follow CSS" exit — clears the pin. The last value is kept as the
 *  slider position so re-dragging starts from it. */
export function unpinAmbience(a: UiAmbience, k: UiAmbienceKey): UiAmbience {
    return k === 'bgAlpha' ? { ...a, bgAlphaOverride: false } : { ...a, glassBlurOverride: false };
}

/** Whether a parameter is currently pinned (drives the source tag and
 *  the follow-CSS reset affordance in the settings UI). */
export function ambiencePinned(a: UiAmbience, k: UiAmbienceKey): boolean {
    return k === 'bgAlpha' ? a.bgAlphaOverride === true : a.glassBlurOverride === true;
}

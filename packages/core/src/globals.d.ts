/**
 * Minimal runtime globals for a DOM-free package running under Node/RN.
 * (No @types/node — core must not accidentally depend on Node APIs.)
 */
declare const console: {
    log: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
};

declare function structuredClone<T>(value: T): T;

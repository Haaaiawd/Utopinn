// @uberge/core — server-side brain: WI engine, macros, variables.
// Pure TS, zero DOM/fs/network. All platform access is injected.

export * from './utils.js';
export * from './variables.js';
export * from './world-info/types.js';
export * from './world-info/regex.js';
export * from './world-info/decorators.js';
export * from './world-info/buffer.js';
export * from './world-info/timed-effects.js';
export * from './world-info/groups.js';
export * from './world-info/sources.js';
export * from './world-info/engine.js';
export * from './macros/evaluate.js';
export * from './macros/substitute.js';
export * from './prompt/types.js';
export * from './prompt/collection.js';
export * from './prompt/messages.js';
export * from './prompt/injections.js';
export * from './prompt/tokens.js';
export * from './prompt/assemble.js';

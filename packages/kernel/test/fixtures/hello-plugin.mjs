export const name = 'hello-plugin';

export function apply(ctx, config) {
    globalThis.__helloLoaded = (globalThis.__helloLoaded ?? 0) + 1;
    globalThis.__helloConfig = config;
}

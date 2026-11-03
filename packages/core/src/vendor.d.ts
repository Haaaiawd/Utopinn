declare module 'droll' {
    export interface DrollResult {
        rolls: number[];
        modifier: number;
        total: number;
        toString(): string;
    }
    export function validate(formula: string): boolean;
    export function parse(formula: string): { numDice: number; numSides: number; modifier: number } | false;
    export function roll(formula: string): DrollResult | false;
    const droll: { validate: typeof validate; parse: typeof parse; roll: typeof roll };
    export default droll;
}

declare module 'seedrandom' {
    type PRNG = () => number;
    interface Seedrandom {
        (seed?: string | number, options?: { entropy?: boolean; global?: boolean }): PRNG;
        alea: (seed?: string | number) => PRNG;
        quick: (seed?: string | number) => PRNG;
    }
    const seedrandom: Seedrandom;
    export default seedrandom;
}

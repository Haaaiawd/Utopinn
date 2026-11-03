import { KNOWN_DECORATORS } from './types.js';

/**
 * Parse decorators from worldinfo content.
 * Ported from `world-info.js parseDecorators`.
 * @returns [decorators, contentWithoutDecorators]
 */
export function parseDecorators(content: string): [string[], string] {
    const isKnownDecorator = (data: string): boolean => {
        if (data.startsWith('@@@')) {
            data = data.substring(1);
        }
        for (let i = 0; i < KNOWN_DECORATORS.length; i++) {
            if (data.startsWith(KNOWN_DECORATORS[i]!)) {
                return true;
            }
        }
        return false;
    };

    if (content.startsWith('@@')) {
        let newContent = content;
        const splited = content.split('\n');
        const decorators: string[] = [];
        let fallbacked = false;

        for (let i = 0; i < splited.length; i++) {
            const line = splited[i]!;
            if (line.startsWith('@@')) {
                if (line.startsWith('@@@') && !fallbacked) {
                    continue;
                }
                if (isKnownDecorator(line)) {
                    decorators.push(line.startsWith('@@@') ? line.substring(1) : line);
                    fallbacked = false;
                } else {
                    fallbacked = true;
                }
            } else {
                newContent = splited.slice(i).join('\n');
                break;
            }
        }
        return [decorators, newContent];
    }

    return [[], content];
}

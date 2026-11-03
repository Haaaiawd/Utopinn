/**
 * Keyword/regex parsing — ported from `world-info.js`
 * (`splitKeywordsAndRegexes`, `customTokenizer`, `isValidRegex`, `parseRegexFromString`).
 */

/**
 * Gets a real regex object from a slash-delimited regex string.
 * `/` is the delimiter; inner occurrences must be escaped. Flags optional
 * (`g`,`i`,`m`,`s`,`u`,`y`). Returns null when not a valid regex.
 */
export function parseRegexFromString(input: string): RegExp | null {
    const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) {
        return null;
    }

    let [, pattern, flags] = match;
    if (pattern === undefined) {
        return null;
    }

    // Unescaped delimiter inside the pattern → not a valid slash regex.
    if (pattern.match(/(^|[^\\])\//)) {
        return null;
    }

    pattern = pattern.replace('\\/', '/');

    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

export function isValidRegex(input: string): boolean {
    return parseRegexFromString(input) !== null;
}

/**
 * Tokenizer parsing input and splitting it into keywords and regexes.
 * Returns `[remainingTerm, tokens]`.
 */
export function customTokenizer(input: { term: string }): { term: string; tokens: string[] } {
    let current = input.term;
    const tokens: string[] = [];
    const callback = (text: string) => tokens.push(text);

    let insideRegex = false;
    let regexClosed = false;

    for (let i = 0; i < current.length; i++) {
        const char = current[i];

        if (char === '/' && (i === 0 || current[i - 1] !== '\\')) {
            if (!insideRegex) insideRegex = true;
            else if (!regexClosed) regexClosed = true;
        }

        if (char === ',') {
            const token = current.slice(0, i).trim();
            if (insideRegex && !regexClosed) {
                continue;
            }
            if (token) {
                const isRegex = isValidRegex(token);
                if (token.startsWith('/') && !isRegex) {
                    token.split(',').map(x => x.trim()).forEach(callback);
                } else {
                    callback(token);
                }
            }
            current = current.slice(i + 1);
            insideRegex = false;
            regexClosed = false;
            i = 0;
        }
    }

    return { term: current, tokens };
}

/**
 * Splits a raw keys input into keyword/regex strings.
 */
export function splitKeywordsAndRegexes(input: string): string[] {
    const keywordsAndRegexes: string[] = [];
    const { term, tokens } = customTokenizer({ term: input });
    keywordsAndRegexes.push(...tokens);
    const finalTerm = term.trim();
    if (finalTerm) {
        keywordsAndRegexes.push(finalTerm);
    }
    return keywordsAndRegexes;
}

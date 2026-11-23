/**
 * 阻塞式弹窗族 — 移植自 ref/Luker public/scripts/slash-commands.js:
 * /popup(popupCallback)/buttons(buttonsCallback)。
 *
 * 这两条是交互宿主专属(浏览器弹窗);服务端/headless 宿主不绑 seam,
 * 命令显式报错(TASK-064 批二规约:不静默 no-op,GH#9 同路)。
 * /input 同族,其未绑行为在 messages.ts 同步修正为显式报错。
 *
 * 语义差异:DOMPurify.sanitize 属宿主职责(同 /input 既有注释);
 * Popup.show.text 的 result 语义经 requestPopup seam 数值通道
 * (确认=1 取消=0 dismiss=undefined)。
 */
import type { NamedArguments, UnnamedArguments } from '../types.js';
import { ARGUMENT_TYPE, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, booleanEnumProvider } from '../types.js';
import type { StscriptEnv, StscriptButtonLabel } from '../env.js';
import { addCommandObject } from '../registry.js';
import { isFalseBoolean, isTrueBoolean } from '../util.js';

function envOf(args: NamedArguments): StscriptEnv {
    const env = args._env;
    if (!env) throw new Error('STscript env is not injected.');
    return env;
}

/** popupCallback — Popup.show.text;result=true 时回结果码。 */
export async function popupCallback(args: NamedArguments, value: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    if (typeof env.host.requestPopup !== 'function') {
        throw new Error('/popup requires host.requestPopup seam — not bound on this host (no interactive popup channel)');
    }
    const text = String(Array.isArray(value) ? value.join(' ') : value ?? '');
    const requestedResult = isTrueBoolean(args?.['result']);
    const result = await env.host.requestPopup({
        text,
        header: typeof args?.['header'] === 'string' ? String(args['header']) : null,
        allowVerticalScrolling: !isFalseBoolean(args?.['scroll']),
        large: isTrueBoolean(args?.['large']),
        wide: isTrueBoolean(args?.['wide']),
        wider: isTrueBoolean(args?.['wider']),
        transparent: isTrueBoolean(args?.['transparent']),
        okButton: typeof args?.['okButton'] === 'string' ? String(args['okButton']) : 'OK',
        cancelButton: typeof args?.['cancelButton'] === 'string' ? String(args['cancelButton']) : null,
        tooltip: typeof args?.['tooltip'] === 'string' ? String(args['tooltip']) : null,
    });
    env.ops.push({ type: 'popup', text });
    return String(requestedResult ? result ?? '' : text);
}

/**
 * buttonsCallback — labels 为 JSON 数组(string 或 {text,tooltip,icon});
 * 返回被点中的 label 文本;multiple=on 回 JSON 文本数组;取消回 ''。
 */
export async function buttonsCallback(args: NamedArguments, text: UnnamedArguments): Promise<string> {
    const env = envOf(args);
    try {
        const rawButtons = JSON.parse(String(args?.['labels'] ?? ''));
        if (!Array.isArray(rawButtons) || !rawButtons.length) {
            console.warn('WARN: Invalid labels provided for /buttons command');
            return '';
        }
        const buttons = rawButtons.map(btn => typeof btn === 'string' ? { text: btn } as StscriptButtonLabel : btn as StscriptButtonLabel);
        if (!buttons.every(btn => typeof btn === 'object' && btn !== null && typeof btn.text === 'string' && btn.text)) {
            console.warn('WARN: Invalid button label entry provided for /buttons command: each entry must be a string or an object with a "text" property');
            return '';
        }
        const multiple = isTrueBoolean(args?.['multiple']);
        if (typeof env.host.requestButtons !== 'function') {
            throw new Error('/buttons requires host.requestButtons seam — not bound on this host (no interactive popup channel)');
        }
        /** result code → label(index+2;0/1 预留给 cancel/ok)。 */
        const resultToButtonMap = new Map<number, StscriptButtonLabel>(buttons.map((button, index) => [index + 2, button]));
        const body = String(Array.isArray(text) ? text.join(' ') : text ?? '');
        const codes = await env.host.requestButtons({ text: body, buttons, multiple });
        env.ops.push({ type: 'popup', text: body });
        if (multiple) {
            const picked = (codes ?? []).map(code => resultToButtonMap.get(code)?.text ?? '');
            return JSON.stringify(picked);
        }
        const code = (codes ?? [])[0];
        return code !== undefined ? (resultToButtonMap.get(code)?.text ?? '') : '';
    } catch (e) {
        if (e instanceof SyntaxError) return '';
        throw e;
    }
}

export function registerDialogCommands(): void {
    addCommandObject(SlashCommand.fromProps({
        name: 'popup',
        callback: (args, value) => popupCallback(args, value),
        returns: 'Popup text',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'scroll',
                description: 'allows vertical scrolling of the content',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: booleanEnumProvider('trueFalse')(),
                defaultValue: 'true',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'large',
                description: 'show large popup',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: booleanEnumProvider('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'wide',
                description: 'show wide popup',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: booleanEnumProvider('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'wider',
                description: 'show wider popup',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: booleanEnumProvider('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'transparent',
                description: 'show transparent popup',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: booleanEnumProvider('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'okButton',
                description: 'text for the OK button',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'OK',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cancelButton',
                description: 'text for the Cancel button',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'result',
                description: 'if enabled, returns the popup result (as an integer) instead of the popup text. Resolves to 1 for OK and 0 cancel button, empty string for exiting out.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: booleanEnumProvider('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'tooltip',
                description: 'tooltip text shown when hovering over the popup content area',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'popup text',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            Shows a blocking popup with the specified text and buttons.
            Returns the popup text.
        </div>
    `,
    }));
    addCommandObject(SlashCommand.fromProps({
        name: 'buttons',
        callback: (args, value) => buttonsCallback(args, value),
        returns: 'clicked button label (or array of labels if multiple is enabled)',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'labels',
                description: 'button labels - can be an array of strings or objects with text, tooltip, and icon properties',
                typeList: [ARGUMENT_TYPE.LIST],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'multiple',
                description: 'if enabled multiple buttons can be clicked/toggled, and all clicked buttons are returned as an array',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: booleanEnumProvider('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'text',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            Shows a blocking popup with the specified text and buttons.
            Returns the clicked button label into the pipe or empty string if canceled.
        </div>
    `,
    }));
}

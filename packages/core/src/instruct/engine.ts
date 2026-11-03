/**
 * Instruct-mode 引擎 —— 逐语义移植自 Luker `public/scripts/instruct-mode.js`
 * (+ openai.js `parseExampleIntoIndividual`、utils.js `regexFromString`/`onlyUnique`)。
 * 去 DOM/jQuery:power_user.* / name1 / name2 / selected_group / getGroupNames /
 * instruct_presets / model_templates_mappings 全部由 InstructEngineContext 注入。
 *
 * 逐行对比备忘(保留下来的原版怪癖,勿"修正"):
 * - formatInstructModeExamples 里"空 suffix + wrap → '\n'"只在 macro 分支内生效;
 *   formatInstructModeChat 里同样规则却在 macro 分支外。两处不对称是原版行为。
 * - customInstruct 下的 substituteParams 仍读全局 instruct(ctx.instruct)解析
 *   {{instruct*}} 宏——原版 substituteParams 读的也是 power_user.instruct 全局。
 * - story_string_prefix/suffix 无条件过 substituteParams,不看 instruct.macro。
 */
import { substituteParams } from '../macros/substitute.js';
import { regexFromString } from '../regex/engine.js';
import { clone } from '../utils.js';
import {
    extension_prompt_types,
    force_output_sequence,
    names_behavior_types,
    type ForceOutputSequence,
    type InstructAutoSelectResult,
    type InstructContextSettings,
    type InstructEngine,
    type InstructEngineContext,
    type InstructSettings,
    type ParsedExampleMessage,
} from './types.js';

// 类型与常量整体转出,instruct/engine.js 作为模块单一入口
export {
    extension_prompt_types,
    force_output_sequence,
    names_behavior_types,
} from './types.js';
export type {
    ForceOutputSequence,
    InstructAutoSelectResult,
    InstructContextSettings,
    InstructEngine,
    InstructEngineContext,
    InstructNamesBehavior,
    InstructSettings,
    ParsedExampleMessage,
} from './types.js';

/** utils.js onlyUnique(:419) */
function onlyUnique<T>(value: T, index: number, array: T[]): boolean {
    return array.indexOf(value) === index;
}

/** ctx.instruct 缺省兜底(原版 power_user.instruct 总有值,这里防御) */
const EMPTY_INSTRUCT: InstructSettings = { enabled: false };

/** utils.js regexFromString —— 权威实现归 ../regex/engine.js(同名不双份) */

/**
 * migrateInstructModeSettings(instruct-mode.js:55-105)—— 就地迁移,语义不动。
 */
export function migrateInstructModeSettings(settings: InstructSettings): void {
    // Separator sequence => Output suffix
    if (settings.separator_sequence !== undefined) {
        settings.output_suffix = settings.separator_sequence || '';
        delete settings.separator_sequence;
    }

    // names, names_force_groups => names_behavior
    if (settings.names !== undefined) {
        settings.names_behavior = settings.names
            ? names_behavior_types.ALWAYS
            : (settings.names_force_groups ? names_behavior_types.FORCE : names_behavior_types.NONE);
        delete settings.names;
        delete settings.names_force_groups;
    }

    const defaults: Record<string, unknown> = {
        input_suffix: '',
        system_sequence: '',
        system_suffix: '',
        user_alignment_message: '',
        last_system_sequence: '',
        first_input_sequence: '',
        last_input_sequence: '',
        skip_examples: false,
        system_same_as_user: false,
        names_behavior: names_behavior_types.FORCE,
        sequences_as_stop_strings: true,
        story_string_prefix: '',
        story_string_suffix: '',
    };

    for (const key in defaults) {
        if (settings[key] === undefined) {
            settings[key] = defaults[key];
        }
    }

    const obsoleteFields = [
        'names',
        'names_force_groups',
        'system_sequence_prefix',
        'system_sequence_suffix',
    ];

    for (const field of obsoleteFields) {
        if (Object.hasOwn(settings, field)) {
            delete settings[field];
        }
    }
}

/**
 * getInstructStoppingSequences(instruct-mode.js:301-367)。
 * name1/name2 原是 script.js 全局 → 取 ctx.name1/ctx.name2;
 * power_user.context.{use_stop_strings,chat_start,example_separator} → ctx.contextTemplate。
 */
export function getInstructStoppingSequences(
    ctx: InstructEngineContext,
    { customInstruct = null, useStopStrings = null }: {
        customInstruct?: InstructSettings | null;
        useStopStrings?: boolean | null;
    } = {},
): string[] {
    const instruct = clone(customInstruct ?? ctx.instruct ?? EMPTY_INSTRUCT);
    const name1 = ctx.name1 ?? '';
    const name2 = ctx.name2 ?? '';

    const result: string[] = [];

    function addInstructSequence(sequence: string): void {
        // ooba textgen 总在 stop 串前补 \n;Metharme 不用换行分隔所以要受 wrap 控制
        const wrap = (s: string) => instruct.wrap ? '\n' + s : s;
        if (typeof sequence === 'string' && sequence.length > 0) {
            // 纯空白/换行序列不做 stop 串
            if (sequence.trim().length > 0) {
                const wrappedSequence = wrap(sequence);
                const stopString = instruct.macro ? substituteParams(wrappedSequence, ctx) : wrappedSequence;
                result.push(stopString);
            }
        }
    }

    // 预设没有 enabled 字段,customInstruct 视为总是启用(原版注释)
    if (customInstruct ?? instruct.enabled) {
        const stop_sequence = instruct.stop_sequence || '';
        const input_sequence = instruct.input_sequence?.replace(/{{name}}/gi, name1) || '';
        const output_sequence = instruct.output_sequence?.replace(/{{name}}/gi, name2) || '';
        const first_output_sequence = instruct.first_output_sequence?.replace(/{{name}}/gi, name2) || '';
        const last_output_sequence = instruct.last_output_sequence?.replace(/{{name}}/gi, name2) || '';
        const system_sequence = instruct.system_sequence?.replace(/{{name}}/gi, 'System') || '';
        const last_system_sequence = instruct.last_system_sequence?.replace(/{{name}}/gi, 'System') || '';

        const combined_sequence = [
            stop_sequence,
        ];

        if (instruct.sequences_as_stop_strings) {
            combined_sequence.push(
                input_sequence,
                output_sequence,
                first_output_sequence,
                last_output_sequence,
                system_sequence,
                last_system_sequence,
            );
        }

        combined_sequence.join('\n').split('\n').filter(onlyUnique).forEach(addInstructSequence);
    }

    if (useStopStrings ?? ctx.contextTemplate?.use_stop_strings) {
        if (ctx.contextTemplate?.chat_start) {
            result.push(`\n${substituteParams(ctx.contextTemplate.chat_start, ctx)}`);
        }

        if (ctx.contextTemplate?.example_separator) {
            result.push(`\n${substituteParams(ctx.contextTemplate.example_separator, ctx)}`);
        }
    }

    return result;
}

/**
 * formatInstructModeChat(instruct-mode.js:387-457)逐行移植。
 * selected_group → ctx.selectedGroup;forceAvatar 语义:truthy 即"换过身份"(群成员/ persona)。
 */
export function formatInstructModeChat(
    name: string,
    mes: string,
    isUser: boolean,
    isNarrator: boolean,
    forceAvatar: string | boolean | undefined | null,
    name1: string,
    name2: string,
    forceOutputSequence: ForceOutputSequence,
    ctx: InstructEngineContext,
    customInstruct: InstructSettings | null = null,
): string {
    const instruct = clone(customInstruct ?? ctx.instruct ?? EMPTY_INSTRUCT);
    let includeNames = isNarrator ? false : instruct.names_behavior === names_behavior_types.ALWAYS;

    if (!isNarrator && instruct.names_behavior === names_behavior_types.FORCE && ((ctx.selectedGroup && name !== name1) || (forceAvatar && name !== name1))) {
        includeNames = true;
    }

    function getPrefix(): string | undefined {
        if (isNarrator) {
            return instruct.system_same_as_user ? instruct.input_sequence : instruct.system_sequence;
        }

        if (isUser) {
            if (forceOutputSequence === force_output_sequence.FIRST) {
                return instruct.first_input_sequence || instruct.input_sequence;
            }

            if (forceOutputSequence === force_output_sequence.LAST) {
                return instruct.last_input_sequence || instruct.input_sequence;
            }

            return instruct.input_sequence;
        }

        if (forceOutputSequence === force_output_sequence.FIRST) {
            return instruct.first_output_sequence || instruct.output_sequence;
        }

        if (forceOutputSequence === force_output_sequence.LAST) {
            return instruct.last_output_sequence || instruct.output_sequence;
        }

        return instruct.output_sequence;
    }

    function getSuffix(): string | undefined {
        if (isNarrator) {
            return instruct.system_same_as_user ? instruct.input_suffix : instruct.system_suffix;
        }

        if (isUser) {
            return instruct.input_suffix;
        }

        return instruct.output_suffix;
    }

    let prefix = getPrefix() || '';
    let suffix = getSuffix() || '';

    if (instruct.macro) {
        prefix = substituteParams(prefix, ctx, { name1Override: name1, name2Override: name2 });
        prefix = prefix.replace(/{{name}}/gi, name || 'System');

        suffix = substituteParams(suffix, ctx, { name1Override: name1, name2Override: name2 });
        suffix = suffix.replace(/{{name}}/gi, name || 'System');
    }

    if (!suffix && instruct.wrap) {
        suffix = '\n';
    }

    const separator = instruct.wrap ? '\n' : '';

    // name 为空就不拼名字
    const textArray = includeNames && name ? [prefix, `${name}: ${mes}` + suffix] : [prefix, mes + suffix];
    const text = textArray.filter(x => x).join(separator);

    return text;
}

/**
 * formatInstructModeSystemPrompt(instruct-mode.js:466-468)—— 原版 deprecated 恒返回入参。
 * @deprecated
 */
export function formatInstructModeSystemPrompt(systemPrompt: string, _customInstruct: InstructSettings | null = null): string {
    return systemPrompt || '';
}

/**
 * formatInstructModeStoryString(instruct-mode.js:478-502)逐行移植。
 * story_string_position === IN_CHAT 时不上序列(交由消息序列包裹)。
 */
export function formatInstructModeStoryString(
    storyString: string,
    ctx: InstructEngineContext,
    { customContext = null, customInstruct = null }: {
        customContext?: InstructContextSettings | null;
        customInstruct?: InstructSettings | null;
    } = {},
): string {
    if (!storyString) {
        return '';
    }

    const instructSettings = clone(customInstruct ?? ctx.instruct ?? EMPTY_INSTRUCT);
    const contextSettings = clone(customContext ?? ctx.contextTemplate ?? {});
    const storyStringPosition = contextSettings.story_string_position ?? extension_prompt_types.IN_PROMPT;

    // 仅非 in-chat 位置才包序列(in-chat 由消息序列包)
    const applySequences = storyStringPosition !== extension_prompt_types.IN_CHAT;
    const separator = instructSettings.wrap ? '\n' : '';
    if (applySequences && instructSettings.story_string_prefix) {
        // 原版 TODO:System 实体名占位
        const prefix = substituteParams(instructSettings.story_string_prefix, ctx).replace(/{{name}}/gi, 'System');
        storyString = prefix + separator + storyString;
    }

    if (applySequences && instructSettings.story_string_suffix) {
        const suffix = substituteParams(instructSettings.story_string_suffix, ctx);
        storyString = storyString + suffix;
    }

    return storyString;
}

/**
 * parseExampleIntoIndividual(openai.js:1352-1409)逐行移植。
 * name1/name2/selected_group/getGroupNames() 是原版全局 → ctx 注入。
 * 注意:这里读 ctx.name1/ctx.name2(全局等价),与 formatInstructModeExamples
 * 的参数无关——原版里两者本来就是同一个全局,保持一致。
 */
// 内部实现。与 prompt/assemble.ts 权威版本同义异名,index.ts export *
// 会撞名 → 以别名导出,消费方用 parseInstructExampleIntoIndividual。
function parseExampleIntoIndividual(
    messageExampleString: string,
    appendNamesForGroup: boolean,
    ctx: InstructEngineContext,
): ParsedExampleMessage[] {
    const name1 = ctx.name1 ?? '';
    const name2 = ctx.name2 ?? '';
    const selectedGroup = ctx.selectedGroup;
    const groupBotNames = (selectedGroup ? (ctx.groupMemberNames ?? []) : []).map(name => `${name}:`);

    const result: ParsedExampleMessage[] = [];
    const tmp = messageExampleString.split('\n');
    let cur_msg_lines: string[] = [];
    let in_user = false;
    let in_bot = false;
    let botName = name2;

    function add_msg(name: string, role: string, system_name: string): void {
        // 拼回换行、去掉名字前缀、trim
        let parsed_msg = cur_msg_lines.join('\n').replace(name + ':', '').trim();

        if (appendNamesForGroup && selectedGroup && ['example_user', 'example_assistant'].includes(system_name)) {
            parsed_msg = `${name}: ${parsed_msg}`;
        }

        result.push({ role: role, content: parsed_msg, name: system_name });
        cur_msg_lines = [];
    }

    // 跳过第一行:恒为 "This is how {bot} should talk" 类标题
    for (let i = 1; i < tmp.length; i++) {
        const cur_str = tmp[i]!;
        if (cur_str.startsWith(name1 + ':')) {
            in_user = true;
            if (in_bot) {
                add_msg(botName, 'system', 'example_assistant');
            }
            in_bot = false;
        } else if (cur_str.startsWith(name2 + ':') || groupBotNames.some(n => cur_str.startsWith(n))) {
            if (!cur_str.startsWith(name2 + ':') && groupBotNames.length) {
                botName = cur_str.split(':')[0]!;
            }

            in_bot = true;
            if (in_user) {
                add_msg(name1, 'system', 'example_user');
            }
            in_user = false;
        }
        // 判完角色再入队
        cur_msg_lines.push(cur_str);
    }
    // 块尾没有新行触发切换,手动收尾
    if (in_user) {
        add_msg(name1, 'system', 'example_user');
    } else if (in_bot) {
        add_msg(botName, 'system', 'example_assistant');
    }
    return result;
}

/**
 * formatInstructModeExamples(instruct-mode.js:511-579)逐行移植。
 * 签名可直接填 SubstituteContext.formatInstructExamples seam。
 */
export function formatInstructModeExamples(
    mesExamplesArray: string[],
    name1: string,
    name2: string,
    ctx: InstructEngineContext,
): string[] {
    const instruct = ctx.instruct ?? EMPTY_INSTRUCT;
    const blockHeading = ctx.contextTemplate?.example_separator ? `${substituteParams(ctx.contextTemplate.example_separator, ctx)}\n` : '';

    if (instruct.skip_examples) {
        return mesExamplesArray.map(x => x.replace(/<START>\n/i, blockHeading));
    }

    const includeNames = instruct.names_behavior === names_behavior_types.ALWAYS;
    const includeGroupNames = !!ctx.selectedGroup && ([names_behavior_types.ALWAYS, names_behavior_types.FORCE] as string[]).includes(instruct.names_behavior ?? '');

    let inputPrefix = instruct.input_sequence || '';
    let outputPrefix = instruct.output_sequence || '';
    let inputSuffix = instruct.input_suffix || '';
    let outputSuffix = instruct.output_suffix || '';

    if (instruct.macro) {
        inputPrefix = substituteParams(inputPrefix, ctx, { name1Override: name1, name2Override: name2 });
        outputPrefix = substituteParams(outputPrefix, ctx, { name1Override: name1, name2Override: name2 });
        inputSuffix = substituteParams(inputSuffix, ctx, { name1Override: name1, name2Override: name2 });
        outputSuffix = substituteParams(outputSuffix, ctx, { name1Override: name1, name2Override: name2 });

        inputPrefix = inputPrefix.replace(/{{name}}/gi, name1);
        outputPrefix = outputPrefix.replace(/{{name}}/gi, name2);
        inputSuffix = inputSuffix.replace(/{{name}}/gi, name1);
        outputSuffix = outputSuffix.replace(/{{name}}/gi, name2);

        // 原版怪癖:wrap 补 '\n' 只在 macro 分支内(Chat 版在分支外)
        if (!inputSuffix && instruct.wrap) {
            inputSuffix = '\n';
        }

        if (!outputSuffix && instruct.wrap) {
            outputSuffix = '\n';
        }
    }

    const separator = instruct.wrap ? '\n' : '';
    const formattedExamples: string[] = [];

    for (const item of mesExamplesArray) {
        const cleanedItem = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        const blockExamples = parseExampleIntoIndividual(cleanedItem, includeGroupNames, ctx);

        if (blockExamples.length === 0) {
            continue;
        }

        if (blockHeading) {
            formattedExamples.push(blockHeading);
        }

        for (const example of blockExamples) {
            // 群名已内嵌时不再加前缀;FORCE 下用户占位要补名
            const includeThisName = !includeGroupNames && (includeNames || (instruct.names_behavior === names_behavior_types.FORCE && example.name == 'example_user'));

            const prefix = example.name == 'example_user' ? inputPrefix : outputPrefix;
            const suffix = example.name == 'example_user' ? inputSuffix : outputSuffix;
            const name = example.name == 'example_user' ? name1 : name2;
            const messageContent = includeThisName ? `${name}: ${example.content}` : example.content;
            const formattedMessage = [prefix, messageContent + suffix].filter(x => x).join(separator);
            formattedExamples.push(formattedMessage);
        }
    }

    if (formattedExamples.length === 0) {
        return mesExamplesArray.map(x => x.replace(/<START>\n/i, blockHeading));
    }
    return formattedExamples;
}

/**
 * formatInstructModePrompt(instruct-mode.js:593-651)逐行移植。
 * 含 Mistral nameFiller hack 与 quiet/impersonate 分支。
 */
export function formatInstructModePrompt(
    name: string,
    isImpersonate: boolean,
    promptBias: string,
    name1: string,
    name2: string,
    isQuiet: boolean,
    isQuietToLoud: boolean,
    ctx: InstructEngineContext,
    customInstruct: InstructSettings | null = null,
): string {
    const instruct = clone(customInstruct ?? ctx.instruct ?? EMPTY_INSTRUCT);
    const includeNames = !!(name && (instruct.names_behavior === names_behavior_types.ALWAYS || (!!ctx.selectedGroup && instruct.names_behavior === names_behavior_types.FORCE)) && !(isQuiet && !isQuietToLoud));

    function getSequence(): string | undefined {
        // 用户 impersonation
        if (isImpersonate) {
            return instruct.last_input_sequence || instruct.input_sequence;
        }

        // 中性/system/quiet:专用 quiet 序列,否则回落 output
        if (isQuiet && !isQuietToLoud) {
            return instruct.last_system_sequence || instruct.output_sequence;
        }

        // quiet 但保持角色
        if (isQuiet && isQuietToLoud) {
            return instruct.last_output_sequence || instruct.output_sequence;
        }

        // 默认 AI 回复
        return instruct.last_output_sequence || instruct.output_sequence;
    }

    let sequence = getSequence() || '';
    let nameFiller = '';

    // Mistral hack:output 序列尾带空格而 last 不带时,补回那个空格再放名字
    if (
        includeNames &&
        instruct.last_output_sequence &&
        instruct.output_sequence &&
        sequence === instruct.last_output_sequence &&
        /\s$/.test(instruct.output_sequence) &&
        !/\s$/.test(instruct.last_output_sequence)
    ) {
        nameFiller = instruct.output_sequence.slice(-1);
    }

    if (instruct.macro) {
        sequence = substituteParams(sequence, ctx, { name1Override: name1, name2Override: name2 });
        sequence = sequence.replace(/{{name}}/gi, name || 'System');
    }

    const separator = instruct.wrap ? '\n' : '';
    let text = includeNames ? (separator + sequence + separator + nameFiller + `${name}:`) : (separator + sequence);

    // quiet prompt 自带结尾换行,去掉前导分隔
    if (isQuiet && separator) {
        text = text.slice(separator.length);
    }

    if (!isImpersonate && promptBias) {
        text += (includeNames ? promptBias : (separator + promptBias.trimStart()));
    }

    return (instruct.wrap ? text.trimEnd() : text) + (includeNames ? '' : separator);
}

/**
 * autoSelectInstructPreset(instruct-mode.js:236-292)纯逻辑版。
 * DOM 副作用(选中、启用 instruct、bind 状态回写)不移植,改为返回结果由宿主执行。
 */
export function autoSelectInstructPreset(
    modelId: string,
    ctx: InstructEngineContext,
): InstructAutoSelectResult {
    const instruct_presets = ctx.instructPresets ?? [];
    const modelTemplatesMap = ctx.modelTemplatesMappings?.[modelId];

    if (modelTemplatesMap) {
        const { instruct, context } = modelTemplatesMap;
        return {
            matched: true,
            ...(instruct !== undefined ? { instructPreset: instruct } : {}),
            ...(context !== undefined ? { contextPreset: context } : {}),
        };
    }

    // instruct 关闭则不做任何事
    if (!ctx.instruct?.enabled) {
        return { matched: false };
    }

    let foundMatch: InstructAutoSelectResult | null = null;

    for (const preset of instruct_presets) {
        // activation_regex 命中即停,避免多预设来回跳
        if (preset.activation_regex) {
            try {
                const regex = regexFromString(preset.activation_regex);

                if (regex instanceof RegExp && regex.test(modelId)) {
                    foundMatch = { matched: true, ...(preset.name !== undefined ? { instructPreset: preset.name } : {}) };
                    break;
                }
            } catch {
                ctx.warn?.(`Invalid instruct activation regex in preset "${preset.name}"`);
            }
        }
    }

    // 无命中时按 bind_to_context 找同名 instruct 预设
    if (!foundMatch && ctx.instruct.bind_to_context) {
        for (const instruct_preset of instruct_presets) {
            if (instruct_preset.name === ctx.contextTemplate?.preset) {
                foundMatch = { matched: true, ...(instruct_preset.name !== undefined ? { instructPreset: instruct_preset.name } : {}) };
                break;
            }
        }
    }

    return foundMatch ?? { matched: false };
}

/**
 * 绑定版引擎 —— ctx 固定后,各方法的剩余签名与原版一致;
 * `formatInstructExamples` 形状即 SubstituteContext.formatInstructExamples。
 */
export function createInstructEngine(ctx: InstructEngineContext): InstructEngine {
    return {
        formatChat: (name, mes, isUser, isNarrator, forceAvatar, name1, name2, forceOutputSequence = false, customInstruct = null) =>
            formatInstructModeChat(name, mes, isUser, isNarrator, forceAvatar, name1, name2, forceOutputSequence, ctx, customInstruct),
        formatPrompt: (name, isImpersonate, promptBias, name1, name2, isQuiet, isQuietToLoud, customInstruct = null) =>
            formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, isQuietToLoud, ctx, customInstruct),
        formatStoryString: (storyString, opts) =>
            formatInstructModeStoryString(storyString, ctx, opts),
        formatInstructExamples: (examples, name1, name2) =>
            formatInstructModeExamples(examples, name1, name2, ctx),
        getStoppingSequences: (opts) =>
            getInstructStoppingSequences(ctx, opts),
        autoSelectPreset: (modelId) =>
            autoSelectInstructPreset(modelId, ctx),
    };
}

export { parseExampleIntoIndividual as parseInstructExampleIntoIndividual };

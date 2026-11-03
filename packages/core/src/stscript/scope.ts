/**
 * SlashCommandScope — 移植自 ref/Luker/public/scripts/slash-commands/SlashCommandScope.js。
 * 作用域帧:scope 变量(let/var 的宿主)、scope 宏表、管道值(parent 兜底)。
 */
import type { SlashCommandClosure } from './closure.js';
import { convertValueType } from './var-store.js';

export type ScopeValue = string | number | SlashCommandClosure | undefined;

export class SlashCommandScope {
    variableNames: string[] = [];
    get allVariableNames(): string[] {
        const names = [...this.variableNames, ...(this.parent?.allVariableNames ?? [])];
        return names.filter((it, idx) => idx == names.indexOf(it));
    }
    variables: Record<string, ScopeValue> = {};
    macros: Record<string, string | number | SlashCommandClosure> = {};
    get macroList(): { key: string; value: string | number | SlashCommandClosure }[] {
        return [...Object.keys(this.macros).map(key => ({ key, value: this.macros[key]! })), ...(this.parent?.macroList ?? [])];
    }
    parent: SlashCommandScope | null;
    #pipe?: ScopeValue;
    get pipe(): ScopeValue {
        return this.#pipe ?? this.parent?.pipe;
    }
    set pipe(value: ScopeValue) {
        this.#pipe = value;
    }

    constructor(parent: SlashCommandScope | null = null) {
        this.parent = parent;
    }

    getCopy(): SlashCommandScope {
        const scope = new SlashCommandScope(this.parent);
        scope.variableNames = [...this.variableNames];
        scope.variables = Object.assign({}, this.variables);
        scope.macros = Object.assign({}, this.macros);
        scope.#pipe = this.#pipe;
        return scope;
    }

    setMacro(key: string, value: string | number | SlashCommandClosure, overwrite = true): void {
        if (overwrite || !this.macroList.find(it => it.key == key)) {
            this.macros[key] = value;
        }
    }

    existsVariableInScope(key: string): boolean {
        return Object.keys(this.variables).includes(key);
    }
    existsVariable(key: string): boolean | undefined {
        return Object.keys(this.variables).includes(key) || this.parent?.existsVariable(key);
    }
    letVariable(key: string, value: ScopeValue = undefined): void {
        if (this.existsVariableInScope(key)) throw new SlashCommandScopeVariableExistsError(`Variable named "${key}" already exists.`);
        this.variables[key] = value;
    }
    setVariable(key: string, value: ScopeValue, index: number | string | null = null, type: string | null = null): ScopeValue {
        if (this.existsVariableInScope(key)) {
            if (index !== null && index !== undefined) {
                let v = this.variables[key];
                try {
                    let parsed: unknown = JSON.parse(String(v));
                    const numIndex = Number(index);
                    if (Number.isNaN(numIndex)) {
                        (parsed as Record<string, unknown>)[index] = convertValueType(value, type);
                    } else {
                        (parsed as unknown[])[numIndex] = convertValueType(value, type);
                    }
                    v = JSON.stringify(parsed);
                } catch {
                    (v as unknown as Record<string, unknown>)[index] = convertValueType(value, type);
                }
                this.variables[key] = v;
            } else {
                this.variables[key] = value;
            }
            return value;
        }
        if (this.parent) {
            return this.parent.setVariable(key, value, index, type);
        }
        throw new SlashCommandScopeVariableNotFoundError(`No such variable: "${key}"`);
    }
    getVariable(key: string, index: number | string | null = null): ScopeValue {
        if (this.existsVariableInScope(key)) {
            if (index !== null && index !== undefined) {
                let v: unknown = this.variables[key];
                try { v = JSON.parse(String(v)); } catch { /* empty */ }
                const numIndex = Number(index);
                if (Number.isNaN(numIndex)) {
                    v = (v as Record<string, unknown>)[index];
                } else {
                    v = (v as unknown[])[numIndex];
                }
                if (typeof v == 'object') return JSON.stringify(v);
                return (v ?? '') as ScopeValue;
            } else {
                const value = this.variables[key];
                return ((value as string)?.trim?.() === '' || isNaN(Number(value))) ? (value || '') : Number(value);
            }
        }
        if (this.parent) {
            return this.parent.getVariable(key, index);
        }
        throw new SlashCommandScopeVariableNotFoundError(`No such variable: "${key}"`);
    }
}

export class SlashCommandScopeVariableExistsError extends Error {}
export class SlashCommandScopeVariableNotFoundError extends Error {}

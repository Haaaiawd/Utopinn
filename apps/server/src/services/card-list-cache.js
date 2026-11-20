/**
 * card-list-cache —— 角色库列表的浅字段索引(utopinn-library /characters 专用)。
 *
 * 贵的部分:逐卡 loadCharacterDoc —— PNG 卡每次列表都整文件重读 +
 * chunk 解析 + base64 → JSON,卡库一大列表就卡。便宜的部分:readdir +
 * stat(列表本来就要做,拿 fileSize/dateAdded)。
 *
 * 设计:charDir → {fingerprint, name, tags, readable}
 *   - fingerprint = 该 stem 全部候选卡档(png/webp/json,按 fileName
 *     排序)的 {fileName,size,mtimeMs,ctimeMs}。盯全候选而非只盯承载
 *     文件:loadCharacterDoc 对坏档 fallthrough 到下一面,"坏 png +
 *     改 json" 只看承载文件会漏失效。
 *   - ctimeMs 进指纹:POSIX 下 utimes 回填 mtime 的写路径(备份恢复)
 *     仍会动 ctime;Windows 下它是创建时间,原子 rename 重写一样变。
 *   - 指纹一致 → 复用浅字段;不一致 → loader() 实解析并回填。
 *   - prune(dir, stems) 顺带清掉文件整体消失的 charDir。
 *
 * 不进缓存:dateLastChat(来自 chat repo,不在卡文件里,每请求现查);
 *   avatar/fileName/fileSize/dateAdded(stat 现场值,本来就是新的)。
 *
 * 失效语义:mtime/size 变 → 重解;文件消失 → prune 踢出;新文件 →
 *   无缓存条目自然解析入缓存。无 TTL、无后台预热 —— 冷启动第一次
 *   列表全解可接受。
 *
 * 工厂函数而非模块单例:插件契约要求状态活在 apply() 闭包里,
 * fiber dispose / reload 随之清掉,不留模块级残态。
 */

/** 两个指纹是否相同(fileName 升序数组逐元素比对)。单文件指纹传一元数组。 */
export function sameFingerprint(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (x.fileName !== y.fileName || x.size !== y.size
            || x.mtimeMs !== y.mtimeMs || x.ctimeMs !== y.ctimeMs) {
            return false;
        }
    }
    return true;
}

/** 规范化指纹:按 fileName 排序,只留比对字段。 */
export function normalizeFingerprint(files) {
    return files
        .map((f) => ({
            fileName: String(f.fileName),
            size: Number(f.size) || 0,
            mtimeMs: Number(f.mtimeMs) || 0,
            ctimeMs: Number(f.ctimeMs) || 0,
        }))
        .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export function createCardListCache() {
    /** @type {Map<string, Map<string, {fingerprint: object[], name: string, tags: string[], readable: boolean}>>} */
    const tables = new Map(); // charactersDir -> charDir -> entry

    function tableFor(dir) {
        let table = tables.get(dir);
        if (!table) {
            table = new Map();
            tables.set(dir, table);
        }
        return table;
    }

    return {
        /**
         * 取一个 stem 的浅字段;指纹未命中 → 调 loader() 实解析并回填。
         * @param {string} dir characters 目录绝对路径(用户隔离键)
         * @param {string} charDir 不含扩展名的角色目录名
         * @param {Array<{fileName:string,size:number,mtimeMs:number,ctimeMs:number}>} fingerprint
         *   该 stem 全部候选卡档的 stat 指纹(本函数内排序归一)
         * @param {() => Promise<{name:string,tags:string[],readable:boolean}>} loader
         * @returns {Promise<{name:string,tags:string[],readable:boolean,cached:boolean}>}
         */
        async get(dir, charDir, fingerprint, loader) {
            const table = tableFor(dir);
            const fp = normalizeFingerprint(fingerprint);
            const hit = table.get(charDir);
            if (hit && sameFingerprint(hit.fingerprint, fp)) {
                return { name: hit.name, tags: hit.tags, readable: hit.readable, cached: true };
            }
            const fields = await loader();
            table.set(charDir, {
                fingerprint: fp,
                name: typeof fields?.name === 'string' ? fields.name : '',
                tags: Array.isArray(fields?.tags) ? fields.tags : [],
                readable: fields?.readable === true,
            });
            return {
                name: typeof fields?.name === 'string' ? fields.name : '',
                tags: Array.isArray(fields?.tags) ? fields.tags : [],
                readable: fields?.readable === true,
                cached: false,
            };
        },

        /**
         * 踢出已不在 stem 集里的 charDir 条目(卡档整体消失)。
         * @param {string} dir
         * @param {Map<string, *>|Set<string>} aliveCharDirs 本次扫描到的 charDir 集
         */
        prune(dir, aliveCharDirs) {
            const table = tables.get(dir);
            if (!table) return;
            for (const key of table.keys()) {
                if (!aliveCharDirs.has(key)) table.delete(key);
            }
        },

        /** 诊断用:某目录下缓存条数。 */
        size(dir) {
            return tables.get(dir)?.size ?? 0;
        },
    };
}

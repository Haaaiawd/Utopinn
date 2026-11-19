// feature:stagepack — 舞台形态包:novel/messenger/galgame 三个
// 'stage.form' 贡献。SPEC-DATA: 待接 —— 形态数据无服务端源,
// 结构按规范稿保留,接通时换组件内数据源即可。
import type { Feature, FeatureCtx } from '../kernel/kernel';
import { NovelStage, MessengerStage, GalgameStage } from '../components/stage/PlaceholderStages';

export const stagepackFeature: Feature = {
    name: 'stagepack',
    apply(ctx: FeatureCtx) {
        ctx.add('stage.form', { kind: 'novel', order: 20, Component: NovelStage });
        ctx.add('stage.form', { kind: 'messenger', order: 30, Component: MessengerStage });
        ctx.add('stage.form', { kind: 'galgame', order: 40, Component: GalgameStage });
        ctx.locale('stagepack', {
            'zh-CN': {
                'stage.kind.novel': '小说',
                'stage.kind.messenger': '消息',
                'stage.kind.galgame': 'Galgame',
                'stage.unwired': 'SPEC-DATA: 待接 —— 形态内容未接服务端。',
                'novel.chapter': '第 {n} 章',
                'novel.p1': '潮水退到第三级石阶时,灯塔的灯恰好亮起来。我把最后一箱手稿搬进塔基的小屋,回头看海——海把整片天空都压得很低,像一页吸饱了水的纸。',
                'novel.p2': '那圈水渍我认识。父亲最后一次出海前,海图桌上也有同样的一圈——圆得不像话,像有人用圆规画下的警告。我伸手去擦,指尖却在离它一寸的地方停住了。',
                'novel.p3': '铜钥匙就躺在水渍中央,安静得像已经等了我七年。',
                'novel.caret': '继续写',
                'gal.speaker': '归墟',
                'gal.line': '「你迟到了七年,」我说,声音比想象中平静,「不过海还没老。」',
                'gal.save': '存档 {n}',
                'gal.auto': '自动',
                'gal.skip': '跳过',
                'gal.log': '记录',
            },
            en: {
                'stage.kind.novel': 'Novel',
                'stage.kind.messenger': 'Messenger',
                'stage.kind.galgame': 'Galgame',
                'stage.unwired': 'SPEC-DATA: form content not wired to server.',
                'novel.chapter': 'Chapter {n}',
                'novel.p1': 'When the tide fell to the third stone step, the lighthouse lamp came on. I carried the last crate of manuscripts into the tower cottage and looked back at the sea—',
                'novel.p2': 'I knew that ring of water. Before father\'s last voyage, the chart table bore the same one—too round, like a warning drawn with a compass. My fingers stopped an inch short.',
                'novel.p3': 'The bronze key lay in the center of the ring, quiet, as if it had been waiting seven years.',
                'novel.caret': 'Continue',
                'gal.speaker': 'Guixu',
                'gal.line': '"You are seven years late," I said, calmer than I expected. "But the sea is not old yet."',
                'gal.save': 'Save {n}',
                'gal.auto': 'Auto',
                'gal.skip': 'Skip',
                'gal.log': 'Log',
            },
        });
    },
};

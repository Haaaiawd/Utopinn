import fs from 'node:fs';
const g = JSON.parse(fs.readFileSync('/mnt/d/PROJECTALL/Utopinn/tests/golden-diff/golden-private/高中生活模拟.golden.json'));
const fm = g.chatSnapshot.messages.filter(m => !/^<GOLDEN_REPLY/.test(m.mes || '')).map(m => m.name + ': ' + m.mes).join('\n');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const k of ['同桌', '教室', '座位', '大组', '林清瑛', '年级主任', '林无敌', '林主任', '郭建民', '杜伟超', '体育', '伪钞', '徐秀慧', '生物', '邓磊', '物理', '磊哥', '杨明正', '数学', '陈园花', '英语', '花花', '乐紫萱', '语文', '萱萱', '班主任', '王奇生', '化学', '奇哥', '组', '课桌', '学号', '班级', '值日', '微信群', '大扫除', '班委', '一体机', '空调', '吊扇', '重点班', '零班', '实验班']) {
    const ww = new RegExp('(?:^|\\W)(' + esc(k) + ')(?:$|\\W)');
    if (ww.test(fm)) console.log('ww-hit:', k);
}

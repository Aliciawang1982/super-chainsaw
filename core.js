export const SUBJECTS = ['数学', '语文', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '其他'];
export const REASONS = ['概念不清', '思路卡住', '计算失误', '审题疏漏', '记忆模糊', '其他'];
export const DAY = 86400000;
export function dueItems(items, now = Date.now()) {
  return items.filter(x => !x.deletedAt && !x.mastered && x.nextReview <= now).sort((a, b) => a.nextReview - b.nextReview);
}
export function reviewed(item, result, now = Date.now()) {
  const level = result === 'again' ? 0 : Math.min((item.level || 0) + 1, 5);
  return { ...item, level, mastered: result === 'mastered', nextReview: now + (result === 'again' ? DAY : [1, 3, 7, 14, 30, 60][level] * DAY), reviewedAt: now, updatedAt: now, reviewCount: (item.reviewCount || 0) + 1 };
}
export function validateBackup(data) {
  if (data?.app !== 'shiti' || data.version !== 1 || !Array.isArray(data.items) || data.items.length > 10000) throw new Error('不是有效的拾题备份文件');
  const ids = new Set();
  return data.items.map(x => {
    if (!x || typeof x.id !== 'string' || !x.id || x.id.length > 100 || ids.has(x.id) || !SUBJECTS.includes(x.subject)) throw new Error('备份中的题目数据不完整');
    ids.add(x.id);
    for (const key of ['title', 'question', 'answer', 'correctAnswer', 'reason', 'tags']) if (typeof (x[key] ?? '') !== 'string' || (x[key] ?? '').length > 20000) throw new Error('备份文本格式不正确');
    for (const key of ['createdAt', 'updatedAt', 'nextReview']) if (!Number.isFinite(x[key]) || x[key] < 0 || x[key] > 8640000000000000) throw new Error('备份日期格式不正确');
    if (!Array.isArray(x.photos) || x.photos.length > 8 || x.photos.some(p => typeof p !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p) || p.length > 16000000)) throw new Error('备份图片格式不正确');
    const correctAnswerPhotos = x.correctAnswerPhotos ?? [];
    if (!Array.isArray(correctAnswerPhotos) || correctAnswerPhotos.length > 8 || correctAnswerPhotos.some(p => typeof p !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p) || p.length > 16000000)) throw new Error('备份图片格式不正确');
    if (!x.title.trim() || (!x.photos.length && !(x.question ?? '').trim())) throw new Error('备份题目缺少内容');
    return { id: x.id, subject: x.subject, title: x.title, question: x.question ?? '', answer: x.answer ?? '', correctAnswer: x.correctAnswer ?? '', correctAnswerPhotos, reason: x.reason ?? '', tags: x.tags ?? '', photos: x.photos, createdAt: x.createdAt, updatedAt: x.updatedAt, nextReview: x.nextReview, mastered: x.mastered === true, starred: x.starred === true, level: Math.max(0, Math.min(5, Number(x.level) || 0)), reviewCount: Math.max(0, Number(x.reviewCount) || 0), reviewedAt: Number.isFinite(x.reviewedAt) ? x.reviewedAt : null, deletedAt: Number.isFinite(x.deletedAt) && x.deletedAt > 0 ? x.deletedAt : null };
  });
}

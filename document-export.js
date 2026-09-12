import { AlignmentType, Document, Footer, Header, HeadingLevel, ImageRun, LevelFormat, Packer, PageNumber, Paragraph, TextRun } from './vendor/docx.js';

export function selectedQuestions(items, selectedIds, sort = 'newest') {
  return items.filter(item => !item.deletedAt && selectedIds.has(item.id)).sort((a, b) => {
    const delta = sort === 'oldest' ? a.createdAt - b.createdAt : sort === 'review' ? a.nextReview - b.nextReview : b.createdAt - a.createdAt;
    return delta || a.id.localeCompare(b.id);
  });
}

export function documentFilename(title, now = new Date()) {
  const name = String(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().replace(/[. ]+$/, '').slice(0, 80) || '我的错题';
  const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  return `${name}-${stamp}.docx`;
}

const cleanText = text => String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const paragraphs = text => cleanText(text).split(/\r?\n/).map(line => new Paragraph({ children: [new TextRun(line)] }));

export async function browserImage(source) {
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(source)) throw new Error('题目照片格式不受支持');
  const image = new Image();
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('题目照片无法读取，请重新添加照片后再导出')); image.src = source; });
  let type = source.startsWith('data:image/png') ? 'png' : 'jpg';
  if (source.startsWith('data:image/webp')) {
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0); source = canvas.toDataURL('image/png'); type = 'png';
  }
  return { data: Uint8Array.from(atob(source.slice(source.indexOf(',') + 1)), char => char.charCodeAt(0)), type, width: image.naturalWidth, height: image.naturalHeight };
}

export async function buildQuestionDocument(records, { title = '我的错题', includeAnswers = true, pagePerQuestion = false } = {}, imageLoader = browserImage) {
  if (!records.length) throw new Error('请先选择需要导出的题目');
  title = cleanText(title).trim() || '我的错题';
  // Compact reference preset, with A4 paper and Chinese fonts for printed exercises.
  const font = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'Microsoft YaHei', cs: 'Calibri' };
  const body = { run: { font, size: 22, color: '25332E' }, paragraph: { spacing: { before: 0, after: 120, line: 300 }, widowControl: true } };
  const heading = (size, before, after) => ({ run: { font, size, bold: true, color: '246B56' }, paragraph: { spacing: { before, after, line: 300 }, keepNext: true, keepLines: true } });
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
    new Paragraph({ style: 'ExportMeta', children: [new TextRun(`${records.length} 道题目  |  ${[...new Set(records.map(x => x.subject))].join('、')}`)] }),
  ];
  for (let index = 0; index < records.length; index++) {
    const item = records[index];
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, numbering: { reference: 'questions', level: 0 }, pageBreakBefore: pagePerQuestion && index > 0, children: [new TextRun(cleanText(item.title))] }));
    const metadata = [`学科：${item.subject}`, ...(item.tags ? [`知识点：${item.tags}`] : [])];
    children.push(new Paragraph({ style: 'ExportMeta', keepNext: true, children: [new TextRun(cleanText(metadata.join('  |  ')))] }));
    for (const [photoIndex, source] of item.photos.entries()) {
      const image = await imageLoader(source);
      if (!(image.width > 0 && image.height > 0)) throw new Error(`第 ${index + 1} 题的照片尺寸无效`);
      const scale = Math.min(1, 600 / image.width, 520 / image.height);
      children.push(new Paragraph({ spacing: { before: 80, after: 160, line: 240 }, children: [new ImageRun({ type: image.type, data: image.data, transformation: { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) }, altText: { title: cleanText(item.title), description: `第 ${index + 1} 题，第 ${photoIndex + 1} 张照片`, name: `question-${index + 1}-${photoIndex + 1}` } })] }));
    }
    if (item.question) children.push(...paragraphs(item.question));
    if (includeAnswers && (item.answer || item.reason)) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('答案与解析')] }));
      if (item.answer) children.push(...paragraphs(item.answer));
      if (item.reason) children.push(new Paragraph({ style: 'ExportMeta', children: [new TextRun(`错因：${cleanText(item.reason)}`)] }));
    }
  }
  const document = new Document({
    creator: '拾题', title, description: '选中的错题',
    styles: { default: { document: body, title: heading(40, 0, 160), heading1: heading(32, 360, 200), heading2: heading(26, 280, 140), heading3: heading(24, 200, 100) }, paragraphStyles: [
      { id: 'ExportMeta', name: '题目元信息', basedOn: 'Normal', run: { font, size: 18, color: '67756C' }, paragraph: { spacing: { before: 0, after: 140, line: 280 } } },
      { id: 'ExportFooter', name: '页脚', basedOn: 'Normal', run: { font, size: 18, color: '77827C' }, paragraph: { alignment: AlignmentType.RIGHT, spacing: { before: 0, after: 0, line: 240 } } },
    ] },
    numbering: { config: [{ reference: 'questions', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 }, spacing: { before: 360, after: 200, line: 300 } }, run: { font, size: 32, bold: true, color: '246B56' } } }] }] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134, header: 708, footer: 708 } } },
      headers: { default: new Header({ children: [new Paragraph({ style: 'ExportMeta', children: [new TextRun('拾题 · 错题整理')] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ style: 'ExportFooter', children: [new TextRun('第 '), new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(' 页')] })] }) },
      children,
    }],
  });
  return Packer.toBlob(document);
}

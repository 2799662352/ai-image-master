// 分场大纲(treatment)—— .docx 生成器
//
// 每场 = 标题 + 3-5 句描述。
// 可选 —— 审计标签:⚠ [因果] / [价值] / [圣经] / [节奏]
//
// 用法:
//   1. 把本文件复制到工作目录。
//   2. 用 scene("标题", "描述") 填 `treatment` 数组。
//   3. 首次使用先装依赖:  npm install docx
//   4. 运行:  node build_treatment.js
//
// 已与 Claude Cowork 环境解耦:不再需要 NODE_PATH 硬编码,`npm i docx` 后本机 node 直接跑。

const fs = require("fs");
const docx = require("docx");
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, HeadingLevel, Header, PageNumber
} = docx;

const FONT = "Calibri";
const SIZE = 22; // 11pt

let _sceneNum = 0;

function act(title) {
  return new Paragraph({
    spacing: { before: 480, after: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title.toUpperCase(), font: FONT, size: 32, bold: true })]
  });
}

function scene(title, body, audit) {
  _sceneNum++;
  const titlePara = new Paragraph({
    spacing: { before: 360, after: 60 },
    children: [
      new TextRun({ text: `第 ${_sceneNum} 场. `, font: FONT, size: SIZE, bold: true }),
      new TextRun({ text: title, font: FONT, size: SIZE, bold: true })
    ]
  });
  const bodyPara = new Paragraph({
    spacing: { before: 0, after: 120, line: 280 },
    children: [new TextRun({ text: body, font: FONT, size: SIZE })]
  });
  const out = [titlePara, bodyPara];
  if (audit) {
    out.push(new Paragraph({
      spacing: { before: 0, after: 240, line: 280 },
      children: [new TextRun({ text: `⚠ ${audit}`, font: FONT, size: SIZE - 2, italics: true, color: "C00000" })]
    }));
  }
  return out;
}

// ============ 分场大纲 ============

const treatment = [
  new Paragraph({
    spacing: { after: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "PROJECT TITLE", font: FONT, size: 44, bold: true })]
  }),
  new Paragraph({
    spacing: { after: 480 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: "分场大纲 v1", font: FONT, size: 24, italics: true })]
  }),

  act("第一幕"),

  ...scene(
    "地点 — 时间 — 状态",
    "3-5 句:发生什么、谁在场、哪个价值进、发生什么动作、哪个价值出。用具体动作动词,不写情绪描写。"
  ),

  ...scene(
    "下一场",
    "如果结构上有问题,这里可以挂审计标签。",
    "[因果] 这场不由上一场推出 —— 需要一座桥。"
  ),

  // 在下面继续添加你的场景。
  // 用 act("第二幕")、act("第三幕") 作分隔。
];

// ============ 组装 ============

const doc = new Document({
  creator: "Screenwriter",
  title: "Treatment",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })]
        })]
      })
    },
    children: treatment
  }]
});

Packer.toBuffer(doc).then(buf => {
  const out = "./treatment.docx";
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out}`);
}).catch(e => { console.error(e); process.exit(1); });

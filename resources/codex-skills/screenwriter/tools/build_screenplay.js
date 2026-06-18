// 好莱坞格式剧本 —— .docx 生成器
//
// 用法:
//   1. 把本文件复制到你的工作目录,重命名(例如 build_my_scene.js)。
//   2. 在 `screenplay` 数组里用 helper(slug/action/character/dial 等)写你的场景。
//   3. 首次使用先装依赖:  npm install docx
//   4. 运行:  node build_my_scene.js
//   5. 同目录下得到 screenplay.docx。
//
// 已与 Claude Cowork 环境解耦:不再需要 NODE_PATH=/usr/local/lib/node_modules_global,
// 直接 `npm i docx` 后用本机 node 运行即可。
//
// 好莱坞格式:
//   页面 8.5" x 11"(US Letter)
//   页边距:上 1"、下 1"、左 1.5"、右 1"
//   Courier New 12pt(等宽 → 对白/动作混合时 1 页 ≈ 1 分钟银幕时间)
//   Slug-line:全大写加粗,左对齐
//   Action:左对齐,现在时
//   Character cue:缩进 2.2"(3168 DXA)
//   Parenthetical:缩进 1.6"(2304 DXA)
//   Dialogue:左缩进 1" + 右缩进 1.5"(1440 / 2160 DXA)
//   Transition:右对齐,全大写

const fs = require("fs");
const docx = require("docx");
const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, Header, PageNumber, PageBreak
} = docx;

const FONT = "Courier New";
const SIZE = 24; // 12pt(以 half-point 计)

// ============ HELPERS ============

// 开启场景自动编号。若本段不是从 1 开始,改 START_SCENE_NUMBER。
const ENABLE_SCENE_NUMBERS = true;
const START_SCENE_NUMBER = 1;
let _sceneNum = START_SCENE_NUMBER - 1;

function slug(t) {
  let text = t.toUpperCase();
  if (ENABLE_SCENE_NUMBERS) {
    _sceneNum++;
    text = `${_sceneNum}  ${text}`;
  }
  return new Paragraph({
    spacing: { before: 360, after: 240, line: 240 },
    keepNext: true,
    children: [new TextRun({ text, font: FONT, size: SIZE, bold: true })]
  });
}

function action(t) {
  return new Paragraph({
    spacing: { before: 0, after: 240, line: 240 },
    children: [new TextRun({ text: t, font: FONT, size: SIZE })]
  });
}

function character(name, ext) {
  const txt = ext ? `${name.toUpperCase()} (${ext})` : name.toUpperCase();
  return new Paragraph({
    spacing: { before: 240, after: 0, line: 240 },
    indent: { left: 3168 }, // 2.2"
    keepNext: true,
    children: [new TextRun({ text: txt, font: FONT, size: SIZE })]
  });
}

function paren(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 2304, right: 2880 }, // 左 1.6",右约 2.0"
    keepNext: true,
    children: [new TextRun({ text: t.startsWith("(") ? t : `(${t})`, font: FONT, size: SIZE })]
  });
}

function dial(t) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    indent: { left: 1440, right: 2160 }, // 左 1",右 1.5"
    children: [new TextRun({ text: t, font: FONT, size: SIZE })]
  });
}

function trans(t) {
  return new Paragraph({
    spacing: { before: 240, after: 240, line: 240 },
    alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: t.toUpperCase(), font: FONT, size: SIZE, bold: true })]
  });
}

function pageBreak() { return new Paragraph({ children: [new PageBreak()] }); }
function blank() { return new Paragraph({ spacing: { before: 0, after: 0, line: 240 }, children: [new TextRun({ text: "", font: FONT, size: SIZE })] }); }

function center(t, opts = {}) {
  return new Paragraph({
    spacing: { before: opts.before ?? 240, after: opts.after ?? 240, line: 240 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: t, font: FONT, size: opts.size || SIZE, bold: !!opts.bold })]
  });
}

// ============ 你的场景 ============

const screenplay = [
  blank(), blank(),
  center("MY PROJECT", { bold: true, size: 32 }),
  center("Scene Block — Working Title"),
  blank(),

  // 示例场景 —— 替换成你自己的。
  slug("EXT. 地点 — 时间"),
  action("画面里看得见的内容描述。只用动作动词。"),
  action("第二个动作,如果需要。"),

  character("主人公"),
  dial("主人公的台词。"),

  character("第二个角色"),
  paren("轻声"),
  dial("第二个角色的台词。"),

  trans("CUT TO:"),

  // 在下面继续添加你的场景。
];

// ============ 组装 ============

const doc = new Document({
  creator: "Screenwriter",
  title: "Screenplay",
  styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 }, // 8.5" x 11"
        margin: { top: 1440, right: 1440, bottom: 1440, left: 2160 } // 左 1.5",其余 1"
      }
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ children: [PageNumber.CURRENT, "."], font: FONT, size: 22 })]
        })]
      })
    },
    children: screenplay
  }]
});

Packer.toBuffer(doc).then(buf => {
  const out = "./screenplay.docx";
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out}`);
}).catch(e => { console.error(e); process.exit(1); });

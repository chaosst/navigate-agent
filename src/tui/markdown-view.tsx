import React from "react";
import { Box, Text } from "ink";
import {
  clipCodeLines,
  parseBlocks,
  parseInline,
  renderTableBlock,
  type MdBlock,
  type MdInline,
} from "./markdown.js";

export interface MarkdownViewProps {
  text: string;
  /** 可用列数（表格裁剪 / 分隔线长度）。缺省 80 */
  columns?: number;
  /** 代码块最多渲染多少行（超出写省略提示）。缺省 40 */
  maxCodeRows?: number;
  /** 正文颜色 */
  color?: string;
}

const ACCENT = "#4FC3F7";
const CODE = "#9CCC65";
const INLINE_CODE = "#7BD88F";
const MUTED = "#888888";

/** 行内片段 → Ink 文本（嵌套 <Text>；未闭合标记在解析层已退化为字面量） */
function Inline({ parts }: { parts: MdInline[] }): React.ReactElement {
  return (
    <>
      {parts.map((p, i) => {
        switch (p.kind) {
          case "code":
            return (
              <Text key={i} color={INLINE_CODE}>
                {p.text}
              </Text>
            );
          case "bold":
            return (
              <Text key={i} bold>
                {p.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} italic>
                {p.text}
              </Text>
            );
          case "strike":
            return (
              <Text key={i} strikethrough>
                {p.text}
              </Text>
            );
          case "link":
            return (
              <Text key={i} underline color={ACCENT}>
                {p.text}
                <Text dimColor>{` (${p.href})`}</Text>
              </Text>
            );
          default:
            return <Text key={i}>{p.text}</Text>;
        }
      })}
    </>
  );
}

/** 围栏代码块：`┌ lang` 头 + `│ ` 排水沟；正文按行裁剪，不在动态区里爆帧 */
function CodeBlock({
  lang,
  lines,
  closed,
  maxCodeRows,
}: {
  lang: string;
  lines: string[];
  closed: boolean;
  maxCodeRows: number;
}): React.ReactElement {
  const { lines: kept, dropped } = clipCodeLines(lines, maxCodeRows);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{`┌ ${lang || "code"}${closed ? "" : " ⋯"}`}</Text>
      {kept.map((line, i) => (
        <Text key={i} color={CODE}>
          {`│ ${line}`}
        </Text>
      ))}
      {dropped > 0 ? (
        <Text dimColor>{`└ ⋯ 省略 ${dropped} 行（共 ${lines.length} 行）`}</Text>
      ) : (
        <Text dimColor>{"└"}</Text>
      )}
    </Box>
  );
}

/** 表格：预渲染成等宽文本行（已保证不折行），表头高亮 */
function TableBlock({
  header,
  rows,
  columns,
}: {
  header: string[];
  rows: string[][];
  columns: number;
}): React.ReactElement {
  const lines = renderTableBlock(header, rows, columns);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line, i) => (
        <Text key={i} bold={i === 0} color={i === 0 ? ACCENT : MUTED}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function Block({
  block,
  columns,
  maxCodeRows,
  color,
}: {
  block: MdBlock;
  columns: number;
  maxCodeRows: number;
  color: string;
}): React.ReactElement | null {
  switch (block.kind) {
    case "blank":
      // 保留源文本的空行（间距跟随作者意图，同时计入行预算）
      return <Text> </Text>;

    case "heading": {
      const level = block.level;
      const headingColor = level === 1 ? ACCENT : level === 2 ? "white" : MUTED;
      return (
        <Text bold color={headingColor}>
          {`${"#".repeat(Math.min(level, 3))} `}
          <Inline parts={parseInline(block.text)} />
        </Text>
      );
    }

    case "paragraph":
      return (
        <Text color={color}>
          <Inline parts={parseInline(block.text)} />
        </Text>
      );

    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i} color={color}>
              <Text dimColor>
                {`${"  ".repeat(item.depth)}${block.ordered ? `${block.start + i}. ` : "• "}`}
              </Text>
              <Inline parts={parseInline(item.text)} />
            </Text>
          ))}
        </Box>
      );

    case "quote":
      return (
        <Box flexDirection="column">
          {block.text.split("\n").map((line, i) => (
            <Text key={i} italic color={MUTED}>
              {"▌ "}
              <Inline parts={parseInline(line)} />
            </Text>
          ))}
        </Box>
      );

    case "code":
      return (
        <CodeBlock
          lang={block.lang}
          lines={block.lines}
          closed={block.closed}
          maxCodeRows={maxCodeRows}
        />
      );

    case "table":
      return <TableBlock header={block.header} rows={block.rows} columns={columns} />;

    case "rule":
      return (
        <Text dimColor>{"─".repeat(Math.max(8, Math.min(40, columns)))}</Text>
      );

    default:
      return null;
  }
}

/**
 * markdown 文本 → Ink 渲染。
 *
 * 用在两处：`<Static>` 里的最终回答（全量渲染），以及动态区的流式预览
 * （调用方先用 `tailByRows` 把源文本裁到行预算内，再交给这里）。
 */
export function MarkdownView({
  text,
  columns = 80,
  maxCodeRows = 40,
  color = "white",
}: MarkdownViewProps): React.ReactElement {
  const blocks = parseBlocks(text);
  const width = Math.max(20, columns);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <Block key={i} block={block} columns={width} maxCodeRows={maxCodeRows} color={color} />
      ))}
    </Box>
  );
}

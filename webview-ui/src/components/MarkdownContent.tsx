import { useMemo } from 'react';

/**
 * Lightweight Markdown → React renderer for the chat sidebar.
 *
 * Covers the subset a coding assistant actually produces: fenced code blocks, inline
 * code, headings, bold/italic, bullet and numbered lists, blockquotes, tables, and
 * horizontal rules. No external dependency — the webview bundle stays small.
 *
 * The approach: split the source into block-level structures first (code fences, tables,
 * blockquotes, headings, lists, HRs, paragraphs), then run inline formatting over the
 * text leaves. Everything is emitted as React elements, never `dangerouslySetInnerHTML`.
 */

interface Props {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: Props) {
  const elements = useMemo(() => renderBlocks(content), [content]);
  return <div className={className}>{elements}</div>;
}

// ── Block parsing ────────────────────────────────────────────


/**
 * Splits raw markdown into block-level React elements.
 *
 * Lines are accumulated and flushed when a boundary is hit: a code fence, heading,
 * horizontal rule, table start, or blank line separating paragraphs.
 */
function renderBlocks(source: string): React.ReactNode[] {
  const lines = source.split('\n');
  const blocks: React.ReactNode[] = [];
  let key = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block ──
    const fenceMatch = line.match(/^(`{3,})(\S*)\s*$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <div key={key++} className="md-code-block">
          {lang && <div className="md-code-lang">{lang}</div>}
          <pre className="md-pre"><code>{codeLines.join('\n')}</code></pre>
        </div>,
      );
      continue;
    }

    // ── Blank line — paragraph break ──
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ── Horizontal rule ──
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    // ── Heading ──
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={key++} className="md-heading">{renderInline(headingMatch[2])}</Tag>);
      i++;
      continue;
    }

    // ── Table ──
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push(renderTable(tableLines, key++));
      continue;
    }

    // ── Blockquote ──
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith('>') || (lines[i].trim() !== '' && quoteLines.length > 0 && !lines[i].startsWith('#')))) {
        if (!lines[i].startsWith('>')) break;
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="md-blockquote">
          {renderBlocks(quoteLines.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    // ── Unordered list ──
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // ── Ordered list ──
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // ── Paragraph — collect contiguous non-blank, non-special lines ──
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^(#{1,6})\s+/) &&
      !lines[i].match(/^(`{3,})/) &&
      !lines[i].match(/^(\*{3,}|-{3,}|_{3,})\s*$/) &&
      !lines[i].startsWith('>') &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push(
        <p key={key++} className="md-paragraph">
          {renderInline(paraLines.join('\n'))}
        </p>,
      );
    }
  }

  return blocks;
}

// ── Inline formatting ────────────────────────────────────────

/**
 * Converts inline markdown (bold, italic, code, links) to React elements.
 *
 * Processes in a single pass with a regex union so nested/overlapping patterns are handled
 * by whichever fires first, left to right.
 */
function renderInline(text: string): React.ReactNode {
  // Inline code must be matched first to prevent bold/italic inside it.
  const INLINE_RE =
    /(`[^`]+`)|(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(__(.+?)__)|(_(.+?)_)|\[([^\]]+)\]\(([^)]+)\)/g;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_RE.exec(text)) !== null) {
    // Push any text before this match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // Inline code: `code`
      parts.push(<code key={key++} className="md-inline-code">{match[1].slice(1, -1)}</code>);
    } else if (match[2]) {
      // Bold italic: ***text***
      parts.push(<strong key={key++}><em>{match[3]}</em></strong>);
    } else if (match[4]) {
      // Bold: **text**
      parts.push(<strong key={key++}>{match[5]}</strong>);
    } else if (match[6]) {
      // Italic: *text*
      parts.push(<em key={key++}>{match[7]}</em>);
    } else if (match[8]) {
      // Bold: __text__
      parts.push(<strong key={key++}>{match[9]}</strong>);
    } else if (match[10]) {
      // Italic: _text_
      parts.push(<em key={key++}>{match[11]}</em>);
    } else if (match[12] && match[13]) {
      // Link: [text](url)
      parts.push(
        <a key={key++} className="md-link" href={match[13]} title={match[13]}>
          {match[12]}
        </a>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : parts;
}

// ── Table rendering ──────────────────────────────────────────

function renderTable(lines: string[], key: number): React.ReactNode {
  const parseRow = (line: string): string[] =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim());

  if (lines.length < 2) return null;

  const headerCells = parseRow(lines[0]);
  // lines[1] is the separator row: |---|---|
  const bodyRows = lines.slice(2).map(parseRow);

  return (
    <div key={key} className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {headerCells.map((cell, idx) => (
              <th key={idx}>{renderInline(cell)}</th>
            ))}
          </tr>
        </thead>
        {bodyRows.length > 0 && (
          <tbody>
            {bodyRows.map((row, rIdx) => (
              <tr key={rIdx}>
                {row.map((cell, cIdx) => (
                  <td key={cIdx}>{renderInline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

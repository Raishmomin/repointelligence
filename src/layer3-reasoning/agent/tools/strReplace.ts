/**
 * The surgical-edit primitive: replace an exact string, but only when the match is
 * unambiguous.
 *
 * Uniqueness is the whole safety property. If `old_string` appears twice and we silently
 * replaced the first occurrence, the agent would edit a line it never looked at — the
 * classic way an "automatic" refactor corrupts a file. So an ambiguous match is a failure
 * that reports the count and asks for more surrounding context.
 *
 * Pure and dependency-free so every failure mode can be tested directly.
 */

export type StrReplaceResult =
  | { ok: true; result: string; count: number }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'no_op'; count: number; message: string };

export function applyStrReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): StrReplaceResult {
  if (oldString === '') {
    return {
      ok: false,
      reason: 'not_found',
      count: 0,
      message: 'old_string must not be empty. To create a file, use create_file instead.',
    };
  }

  if (oldString === newString) {
    return {
      ok: false,
      reason: 'no_op',
      count: 0,
      message: 'old_string and new_string are identical, so this edit would change nothing.',
    };
  }

  const count = countOccurrences(content, oldString);

  if (count === 0) {
    return {
      ok: false,
      reason: 'not_found',
      count: 0,
      message:
        'old_string was not found in the file. It must match the file contents exactly, ' +
        'including whitespace and indentation. Read the file again to get the current text.',
    };
  }

  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      reason: 'ambiguous',
      count,
      message:
        `old_string matches ${count} places in the file, so the intended edit is ambiguous. ` +
        'Include more surrounding lines to make it unique, or set replace_all to true to ' +
        'change every occurrence.',
    };
  }

  const result = replaceAll
    ? content.split(oldString).join(newString)
    : replaceFirst(content, oldString, newString);

  return { ok: true, result, count: replaceAll ? count : 1 };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    // Advance by the full needle length: occurrences are non-overlapping, matching the
    // replacement semantics below.
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Avoids String.replace, whose `$&`-style patterns in `newString` would be interpreted. */
function replaceFirst(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

/**
 * Inserts text after the given 1-based line number; line 0 means the top of the file.
 * Reports the valid range on a miss rather than clamping, since a wrong line number
 * usually means the model is working from a stale read.
 */
export type InsertResult =
  | { ok: true; result: string }
  | { ok: false; message: string };

export function applyInsert(content: string, insertLine: number, text: string): InsertResult {
  const lines = content.split('\n');
  // A trailing newline yields a final empty element; inserting after it is still valid,
  // so the bound is the raw length.
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    return {
      ok: false,
      message: `insert_line must be between 0 and ${lines.length}; received ${insertLine}.`,
    };
  }

  const inserted = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  lines.splice(insertLine, 0, ...inserted);
  return { ok: true, result: lines.join('\n') };
}

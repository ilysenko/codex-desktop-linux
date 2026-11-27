"use strict";

const TRAY_GUARD_LOOKAHEAD = 1200;
const HANDLER_PREFIX_LOOKBACK = 12000;

function requireName(source, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directMatch = source.match(
    new RegExp(`([A-Za-z_$][\\w$]*)=require\\(([\\\`"'])${escaped}\\2\\)`),
  );
  if (directMatch != null) {
    return directMatch[1];
  }

  return null;
}

function inferModuleAlias(source, moduleName) {
  const requiredName = requireName(source, moduleName);
  if (requiredName != null) {
    return requiredName;
  }

  if (moduleName === "electron") {
    return source.match(/(?:let|,)\s*([A-Za-z_$][\w$]*)=\{app:\{/u)?.[1] ?? null;
  }
  if (moduleName === "node:path") {
    return source.match(/(?:let|,)\s*([A-Za-z_$][\w$]*)=\{default:\{dirname\(/u)?.[1] ?? null;
  }
  if (moduleName === "node:fs") {
    return source.match(/(?:let|,)\s*([A-Za-z_$][\w$]*)=\{mkdirSync\(/u)?.[1] ?? null;
  }
  if (moduleName === "node:net") {
    return source.match(/(?:let|,)\s*([A-Za-z_$][\w$]*)=\{default:\{createServer\(/u)?.[1] ?? null;
  }

  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCallBlock(source, marker) {
  const markerStart = source.indexOf(marker);
  if (markerStart === -1) {
    return null;
  }

  const blockStart = Math.max(
    source.lastIndexOf("var ", markerStart),
    source.lastIndexOf("let ", markerStart),
    source.lastIndexOf("const ", markerStart),
  );
  const blockEnd = source.indexOf("});", markerStart);
  if (blockStart === -1 || blockEnd === -1) {
    return null;
  }

  return {
    start: blockStart,
    end: blockEnd + "});".length,
    text: source.slice(blockStart, blockEnd + "});".length),
  };
}

// Words after which a slash starts a regular expression instead of a division.
const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const CONDITION_KEYWORDS = new Set(["for", "if", "while", "with"]);
const OBJECT_EXPRESSION_PREFIXES = new Set([
  "=", "(", "[", ",", "?", "ternary:", "property:", "+", "-", "*", "/", "%",
  "&", "|", "^", "~", "!", "<", ">",
]);

function isLineTerminator(char) {
  return char === "\n" || char === "\r" || char === " " || char === " ";
}

function isWhitespace(char) {
  return char === " " || char === "\t" || char === "\v" || char === "\f" ||
    char === " " || char === "﻿" || isLineTerminator(char);
}

function isWordChar(char) {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 36 || code === 95 || (code > 0x7f && !isWhitespace(char));
}

function quotedStringEnd(source, openIndex) {
  const quote = source[openIndex];
  for (let i = openIndex + 1; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
    } else if (source[i] === quote) {
      return i;
    }
  }
  return -1;
}

// Returns the index of the closing backtick or of the "{" in "${".
function templateChunkEnd(source, startIndex) {
  for (let i = startIndex; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
    } else if (source[i] === "`") {
      return { end: i, substitution: false };
    } else if (source[i] === "$" && source[i + 1] === "{") {
      return { end: i + 1, substitution: true };
    }
  }
  return null;
}

// Returns the index of the closing slash, or -1 when the slash cannot start a
// regular expression literal on this line.
function regexLiteralEnd(source, openIndex) {
  let inClass = false;
  for (let i = openIndex + 1; i < source.length; i += 1) {
    const char = source[i];
    if (isLineTerminator(char)) {
      return -1;
    }
    if (char === "\\") {
      i += 1;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      return i;
    }
  }
  return -1;
}

function startsExpression(previous, source, next) {
  if (previous.kind === "punct") return OBJECT_EXPRESSION_PREFIXES.has(previous.value);
  if (previous.kind !== "word" || previous.property || !REGEX_PREFIX_KEYWORDS.has(previous.value)) return false;
  if (["return", "throw", "yield"].includes(previous.value)) {
    return !/[\r\n\u2028\u2029]/u.test(source.slice(previous.end, next));
  }
  return !["case", "do", "else"].includes(previous.value);
}

function slashStartsRegex(previous) {
  if (previous.kind === "word") {
    return !previous.property && REGEX_PREFIX_KEYWORDS.has(previous.value);
  }
  if (previous.kind === "value") {
    return false;
  }
  return previous.value !== ")" && previous.value !== "]";
}

// Finds the brace that closes the one at openIndex. It skips strings, template
// literals (including nested substitutions), comments, and regular expression
// literals, whose quotes and braces are not code. Minified bundles contain
// regexes such as /[`"']+/ that a quote-only scanner misreads.
// visitToken receives each token start, brace depth, and parenthesis/bracket
// depth before processing the token. Literals and comments are visited only at
// their opening token.
function findMatchingBrace(source, openIndex, visitToken) {
  if (!Number.isInteger(openIndex) || openIndex < 0) {
    return -1;
  }
  let depth = 0;
  const templateDepths = [];
  const expressionBraceDepths = new Set();
  const objectLiteralDepths = new Set();
  const functionExpressions = new Set();
  let pendingFunctionExpression = false;
  let pendingClassExpression;
  const ternaryConditions = [];
  // One entry per open parenthesis: whether it holds an if/while/for/with
  // condition, after which a slash starts a regex rather than a division.
  const parenthesesAreConditions = [];
  let bracketDepth = 0;
  let previous = { kind: "punct", value: "{" };

  const enterTemplateChunk = (startIndex) => {
    const chunk = templateChunkEnd(source, startIndex);
    if (chunk == null) {
      return -1;
    }
    if (chunk.substitution) {
      templateDepths.push(depth);
      depth += 1;
      previous = { kind: "punct", value: "{" };
    } else {
      previous = { kind: "value" };
    }
    return chunk.end;
  };

  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (isWhitespace(char)) {
      continue;
    }
    visitToken?.(i, depth, parenthesesAreConditions.length + bracketDepth);

    if (char === "'" || char === '"') {
      i = quotedStringEnd(source, i);
      if (i === -1) {
        return -1;
      }
      previous = { kind: "value" };
    } else if (char === "`") {
      i = enterTemplateChunk(i + 1);
      if (i === -1) {
        return -1;
      }
    } else if (char === "{") {
      depth += 1;
      // A slash after an object literal divides its value. A slash after a
      // statement block can begin the next statement's regex literal.
      if (startsExpression(previous, source, i)) {
        objectLiteralDepths.add(depth);
        expressionBraceDepths.add(depth);
      }
      if (previous.value === "function-expression)") {
        expressionBraceDepths.add(depth);
      } else if (pendingClassExpression?.depth === depth - 1 &&
                 pendingClassExpression.parentheses === parenthesesAreConditions.length &&
                 pendingClassExpression.brackets === bracketDepth) {
        expressionBraceDepths.add(depth);
        pendingClassExpression = undefined;
      }
      previous = { kind: "punct", value: "{" };
    } else if (char === "}") {
      const closesExpression = expressionBraceDepths.delete(depth);
      objectLiteralDepths.delete(depth);
      depth -= 1;
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
        templateDepths.pop();
        i = enterTemplateChunk(i + 1);
        if (i === -1) {
          return -1;
        }
        continue;
      }
      if (depth === 0) {
        return i;
      }
      previous = closesExpression ? { kind: "value" } : { kind: "punct", value: "}" };
    } else if (char === "/" && source[i + 1] === "/") {
      while (i + 1 < source.length && !isLineTerminator(source[i + 1])) {
        i += 1;
      }
    } else if (char === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) {
        return -1;
      }
      i = close + 1;
    } else if (char === "/") {
      const close = slashStartsRegex(previous) ? regexLiteralEnd(source, i) : -1;
      if (close === -1) {
        previous = { kind: "punct", value: "/" };
      } else {
        i = close;
        while (i + 1 < source.length && isWordChar(source[i + 1])) {
          i += 1;
        }
        previous = { kind: "value" };
      }
    } else if (isWordChar(char)) {
      const start = i;
      while (i + 1 < source.length && isWordChar(source[i + 1])) {
        i += 1;
      }
      const property = previous.kind === "punct" && previous.value === "." &&
        source[start - 2] !== ".";
      const value = source.slice(start, i + 1);
      const expressionContext = startsExpression(previous, source, start);
      const followsAsync = previous.asyncExpression &&
        !/[\r\n\u2028\u2029]/u.test(source.slice(previous.end, start));
      if (value === "function" && !property && (expressionContext || followsAsync)) {
        pendingFunctionExpression = true;
      }
      if (value === "class" && !property && expressionContext) {
        pendingClassExpression = { depth, parentheses: parenthesesAreConditions.length, brackets: bracketDepth };
      }
      previous = { kind: "word", value, property, end: i + 1, asyncExpression: value === "async" && expressionContext };
    } else if (char === "(") {
      parenthesesAreConditions.push(
        previous.kind === "word" && !previous.property && CONDITION_KEYWORDS.has(previous.value),
      );
      if (pendingFunctionExpression) {
        functionExpressions.add(parenthesesAreConditions.length);
        pendingFunctionExpression = false;
      }
      previous = { kind: "punct", value: "(" };
    } else if (char === ")") {
      const closesFunctionExpression = functionExpressions.delete(parenthesesAreConditions.length);
      const closesCondition = parenthesesAreConditions.pop();
      previous = { kind: "punct", value: closesFunctionExpression ? "function-expression)" : closesCondition ? "condition)" : ")" };
    } else if (char === "[" || char === "]") {
      bracketDepth += char === "[" ? 1 : -1;
      previous = { kind: "punct", value: char };
    } else if (char === "?" && source[i - 1] !== "?" && !["?", "."].includes(source[i + 1])) {
      ternaryConditions.push({ depth, parentheses: parenthesesAreConditions.length, brackets: bracketDepth });
      previous = { kind: "punct", value: "?" };
    } else if (char === ":") {
      const condition = ternaryConditions.at(-1);
      if (condition?.depth === depth && condition.parentheses === parenthesesAreConditions.length &&
          condition.brackets === bracketDepth) {
        ternaryConditions.pop();
        previous = { kind: "punct", value: "ternary:" };
      } else {
        previous = { kind: "punct", value: objectLiteralDepths.has(depth) ? "property:" : ":" };
      }
    } else if (char === ">" && source[i - 1] === "=" && previous.value === "=" && source[i - 2] !== ">") {
      previous = { kind: "punct", value: "=>" };
    } else if ((char === "+" || char === "-") && source[i - 1] === char && previous.value === char) {
      // A postfix ++/-- ends an operand, so a following slash divides.
      previous = { kind: "value" };
    } else {
      previous = { kind: "punct", value: char };
    }
  }

  return -1;
}

function findLastRegexMatch(source, regex) {
  regex.lastIndex = 0;
  let lastMatch = null;
  let match;
  while ((match = regex.exec(source)) != null) {
    lastMatch = match;
    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }
  return lastMatch;
}

function findLinuxGlobalStateExpression(prefix) {
  const objectStateMatch = findLastRegexMatch(prefix, /(?:let|,)\s*([A-Za-z_$][\w$]*)=\{globalState:/g);
  const propertyStateMatch = findLastRegexMatch(prefix, /globalState:([A-Za-z_$][\w$]*)\.globalState/g);

  if (objectStateMatch != null && (propertyStateMatch == null || objectStateMatch.index > propertyStateMatch.index)) {
    return `${objectStateMatch[1]}.globalState`;
  }
  if (propertyStateMatch != null) {
    return `${propertyStateMatch[1]}.globalState`;
  }

  return null;
}

function findDisposableVar(prefix) {
  const explicitVar = findLastRegexMatch(prefix, /disposables:([A-Za-z_$][\w$]*)/g)?.[1];
  if (explicitVar != null) {
    return explicitVar;
  }

  const adjacentCtorVar = findLastRegexMatch(
    prefix,
    /([A-Za-z_$][\w$]*)=new [A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*;\1\.add\(/g,
  )?.[1];
  if (adjacentCtorVar != null) {
    return adjacentCtorVar;
  }

  const constructedVar = findLastRegexMatch(
    prefix,
    /([A-Za-z_$][\w$]*)=new [A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*/g,
  )?.[1];
  if (constructedVar != null && prefix.includes(`${constructedVar}.add(`)) {
    return constructedVar;
  }

  return null;
}

function findExportedAlias(source, localName) {
  const exportList = source.match(/export\{([^}]*)\}/)?.[1];
  if (exportList == null) {
    return null;
  }

  for (const rawEntry of exportList.split(",")) {
    const entry = rawEntry.trim();
    const aliasMatch = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (aliasMatch != null && aliasMatch[1] === localName) {
      return aliasMatch[2];
    }
    if (entry === localName) {
      return localName;
    }
  }

  return null;
}

module.exports = {
  HANDLER_PREFIX_LOOKBACK,
  TRAY_GUARD_LOOKAHEAD,
  escapeRegExp,
  findCallBlock,
  findDisposableVar,
  findExportedAlias,
  findLastRegexMatch,
  findLinuxGlobalStateExpression,
  findMatchingBrace,
  inferModuleAlias,
  requireName,
};

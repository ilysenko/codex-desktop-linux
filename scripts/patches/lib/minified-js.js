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

  if (moduleName === "electron") {
    const wrappedMatch = source.match(
      new RegExp(
        `([A-Za-z_$][\\w$]*)=codexLinuxPatchExternalOpen\\(require\\(([\\\`"'])${escaped}\\2\\)\\)`,
      ),
    );
    return wrappedMatch?.[1] ?? null;
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

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote != null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
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

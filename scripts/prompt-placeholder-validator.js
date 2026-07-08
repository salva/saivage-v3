function isIdentifierStart(char) {
  if (char === undefined) return false;
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char) {
  if (char === undefined) return false;
  return /[A-Za-z0-9_]/.test(char);
}

function malformedToken(template, start) {
  return template.slice(start, Math.min(template.length, start + 32));
}

export function tokenizePromptTemplate(template, sourceLabel) {
  const placeholders = [];
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === '{' && template[i + 1] === '{') {
      let j = i + 2;
      while (template[j] === ' ' || template[j] === '\t') j++;
      const idStart = j;
      if (!isIdentifierStart(template[j])) throw new Error(`${sourceLabel} has malformed placeholder: ${malformedToken(template, i)}`);
      j++;
      while (isIdentifierPart(template[j])) j++;
      const placeholder = template.slice(idStart, j);
      if (template[j] !== ' ' && template[j] !== '\t' && template[j] !== '}' && template[j] !== undefined) throw new Error(`${sourceLabel} has malformed placeholder: ${malformedToken(template, i)}`);
      while (template[j] === ' ' || template[j] === '\t') j++;
      if (template[j] !== '}' || template[j + 1] !== '}') {
        if (template[j] === '{' && template[j + 1] === '{') throw new Error(`${sourceLabel} has nested placeholder open before close: ${malformedToken(template, i)}`);
        throw new Error(`${sourceLabel} has unclosed placeholder: ${malformedToken(template, i)}`);
      }
      placeholders.push(placeholder);
      i = j + 2;
      continue;
    }
    if (c === '}' && template[i + 1] === '}') throw new Error(`${sourceLabel} has stray '}}'.`);
    i++;
  }
  return placeholders;
}

export function assertPromptPlaceholders(template, sourceLabel, allowedPlaceholders) {
  for (const placeholder of tokenizePromptTemplate(template, sourceLabel)) {
    if (!allowedPlaceholders.has(placeholder)) throw new Error(`${sourceLabel} uses unknown placeholder: ${placeholder}`);
  }
}

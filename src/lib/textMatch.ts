// 中文/ASCII 混合文本的轻量检索匹配工具。
// 之前 agentService、media-search handler、mediaService、memoryService 各自维护了
// 一份近似实现，这里统一为单一实现，各调用方只保留自己的停用词表。

const SEARCH_STOPWORDS = /有关|关于|一个|一份|一篇|介绍|报告|文件|文档|材料|方案|总结|游戏|皮肤/g;

export function normalizeForMatch(value: string, stopwords?: RegExp) {
  const base = value
    .toLowerCase()
    .replace(/\\u[\da-f]{4}/gi, "")
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "");
  return (stopwords ? base.replace(stopwords, "") : base).trim();
}

export function extractHanAsciiTerms(
  normalized: string,
  options: { trigrams: boolean; shortChunkSkipsGrams: boolean }
) {
  const terms = new Set<string>();
  const ascii = normalized.match(/[a-z0-9]{2,}/g) || [];
  ascii.forEach((term) => terms.add(term));
  const hanChunks = normalized.match(/\p{Script=Han}{2,}/gu) || [];
  for (const chunk of hanChunks) {
    if (chunk.length <= 4) {
      terms.add(chunk);
      if (options.shortChunkSkipsGrams) {
        continue;
      }
    }
    for (let index = 0; index <= chunk.length - 2; index += 1) {
      terms.add(chunk.slice(index, index + 2));
    }
    if (options.trigrams) {
      for (let index = 0; index <= chunk.length - 3; index += 1) {
        terms.add(chunk.slice(index, index + 3));
      }
    }
  }
  return [...terms].filter((term) => term.length >= 2);
}

export function termsOverlapMatch(terms: string[], normalizedText: string) {
  if (!terms.length) {
    return false;
  }
  const matched = terms.filter((term) => normalizedText.includes(term));
  return matched.length >= Math.min(2, terms.length) || matched.join("").length >= 4;
}

export function longestCommonSubstringLength(left: string, right: string) {
  let best = 0;
  const dp = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = right.length; j >= 1; j -= 1) {
      if (left[i - 1] === right[j - 1]) {
        dp[j] = dp[j - 1] + 1;
        best = Math.max(best, dp[j]);
      } else {
        dp[j] = 0;
      }
    }
  }
  return best;
}

// 严格匹配：子串命中，或最长公共子串达到阈值，或词项重叠。
// agentService 的目标检索 fastpath 和 media-search skill 共用。
export function isStrongTextMatch(query: string, text: string) {
  const normalizedQuery = normalizeForMatch(query, SEARCH_STOPWORDS);
  const normalizedText = normalizeForMatch(text, SEARCH_STOPWORDS);
  if (!normalizedQuery || !normalizedText) {
    return false;
  }
  if (normalizedText.includes(normalizedQuery)) {
    return true;
  }
  const commonLength = longestCommonSubstringLength(normalizedQuery, normalizedText);
  if (commonLength >= Math.min(4, normalizedQuery.length)) {
    return true;
  }
  const queryTerms = extractHanAsciiTerms(normalizedQuery, { trigrams: true, shortChunkSkipsGrams: true });
  return termsOverlapMatch(queryTerms, normalizedText);
}

// 宽松匹配：子串命中或词项重叠（不做公共子串检查），供无 embedding 时兜底检索使用。
export function isFlexibleTextMatch(query: string, text: string, stopwords: RegExp) {
  const normalizedQuery = normalizeForMatch(query, stopwords);
  const normalizedText = normalizeForMatch(text, stopwords);
  if (!normalizedQuery || !normalizedText) {
    return false;
  }
  if (normalizedText.includes(normalizedQuery)) {
    return true;
  }
  const terms = extractHanAsciiTerms(normalizedQuery, { trigrams: true, shortChunkSkipsGrams: true });
  return termsOverlapMatch(terms, normalizedText);
}

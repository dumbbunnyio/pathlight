/**
 * Fuzzy match for the view list: every space-separated word of the query must appear in the text, in order but not necessarily together
 * ("hlp mid" finds "helper / middleware"). A higher score is a better match; undefined means no match.
 */
export const fuzzyScore = (query: string, text: string): number | undefined => {
  const haystack = text.toLowerCase();
  let total = 0;
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    let best: number | undefined;
    // Try each place the word's first letter occurs and keep the tightest match from there.
    for (let start = haystack.indexOf(word[0]!); start >= 0; start = haystack.indexOf(word[0]!, start + 1)) {
      let at = start, score = 0, previous = -2;
      let ok = true;
      for (const letter of word) {
        const found = haystack.indexOf(letter, at);
        if (found < 0) { ok = false; break; }
        const boundary = found === 0 || /[^a-z0-9]/.test(haystack[found - 1]!);
        score += (found === previous + 1 ? 8 : 1) + (boundary ? 6 : 0) - Math.min(found - at, 5);
        previous = found; at = found + 1;
      }
      if (ok && (best === undefined || score > best)) best = score;
    }
    if (best === undefined) return undefined;
    total += best;
  }
  return total;
};

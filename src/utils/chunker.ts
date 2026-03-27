export function smartChunk(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];

  // Try paragraph splits first
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (para.length > maxLength) {
      // Paragraph too long — flush current, then split paragraph by sentences
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
      const sentenceChunks = splitBySentences(para, maxLength);
      chunks.push(...sentenceChunks);
    } else if ((current + "\n\n" + para).trim().length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

function splitBySentences(text: string, maxLength: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
      // Hard split
      for (let i = 0; i < sentence.length; i += maxLength) {
        chunks.push(sentence.slice(i, i + maxLength).trim());
      }
    } else if ((current + sentence).length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

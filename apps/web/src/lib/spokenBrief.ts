export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTaggedBrief(text: string): string | null {
  const clean = text.replace(/```[\s\S]*?```/g, '').trim();
  const match = clean.match(/(?:voice summary|spoken brief|voice brief)\s*:?\s*([\s\S]*?)(?:\n\s*\n|(?:\n#{1,6}\s)|(?:\n\*\*[^*]+\*\*)|$)/i);
  return match?.[1]?.trim() || null;
}

function firstSentences(text: string, maxSentences: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return text;
  return sentences.slice(0, maxSentences).join(' ');
}

export function humanizeSpokenBrief(text: string, maxChars = 520): string {
  const tagged = extractTaggedBrief(text);
  let source = stripMarkdownForSpeech(tagged ?? text);
  if (!source) return '';

  source = source
    .replace(/\b(?:stdout|stderr|stack trace|tool call|tool_use|function call|SSE frame|JSON payload)\b[^.!?]*[.!?]?/gi, '')
    .replace(/\b(?:npm|docker|curl|git|ssh|scp|tar|rg|powershell)\s+[^\n.?!]{8,}[.?!]?/gi, '')
    .replace(/\b(?:HTTP|status)\s+\d{3}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const clipped = firstSentences(source, 3).trim() || source;
  return clipped.length > maxChars ? `${clipped.slice(0, maxChars - 3).trim()}...` : clipped;
}

export function buildVoiceActionPrompt(text: string, roleLabel = 'BOS'): string {
  return [
    `CEO voice request for ${roleLabel}: ${text}`,
    '',
    'Act on the request normally first. Use the available BOS tools, routes, and agents as needed.',
    'When the action or answer is ready, start the final response with a section exactly titled "Voice summary:" followed by 1-3 natural spoken sentences.',
    'The Voice summary is what will be read aloud. Make it human, concise, and executive: what happened, what changed, and what needs attention.',
    'After the Voice summary, include any fuller visible detail that should remain on screen.',
    'Do not put raw transcripts, logs, commands, JSON, stack traces, or tool narration in the Voice summary.',
  ].join('\n');
}

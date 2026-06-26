/**
 * LinkedIn brain tools. Gated on a stored linkedin OAuth token.
 * Publish text / image / video / document posts to the member's feed
 * (Share on LinkedIn → w_member_social). Agents attach media by URL.
 */
import type { BrainTool } from '@boss/brain';
import { publishLinkedInPost, type MediaInput } from '../lib/linkedin.js';

export const linkedinPostTool: BrainTool = {
  name: 'boss_linkedin_post',
  description:
    'Publish a post to the connected LinkedIn account (the owner\'s personal feed). Supports text, a link, and optionally ONE media attachment (image, video, or document) provided by URL.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The post body (up to ~3000 chars).' },
      link: { type: 'string', description: 'Optional URL to share — LinkedIn auto-previews it.' },
      mediaUrl: { type: 'string', description: 'Optional URL of an image, video, or document to attach and upload to the post.' },
      mediaType: { type: 'string', enum: ['image', 'video', 'document'], description: 'Type of mediaUrl. Required if mediaUrl is set.' },
      altText: { type: 'string', description: 'Optional accessibility text for an image.' },
    },
    required: ['text'],
  },
};

export const ALL_LINKEDIN_TOOLS: BrainTool[] = [linkedinPostTool];

async function handleLinkedInPost(args: Record<string, unknown>): Promise<string> {
  const text = String(args.text ?? '').trim();
  if (!text) throw new Error('text is required');
  const link = args.link ? String(args.link) : undefined;
  let media: MediaInput | undefined;
  if (args.mediaUrl) {
    const type = String(args.mediaType ?? 'image') as MediaInput['type'];
    media = { type, url: String(args.mediaUrl), altText: args.altText ? String(args.altText) : undefined };
  }
  const { postId } = await publishLinkedInPost(text, { link, media });
  return [
    `Posted to LinkedIn${media ? ` with ${media.type}` : ''}.`,
    postId ? `Post id: ${postId}` : '',
    `Text: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`,
  ].filter(Boolean).join('\n');
}

export const LINKEDIN_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  boss_linkedin_post: handleLinkedInPost,
};

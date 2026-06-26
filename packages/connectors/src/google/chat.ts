/**
 * Google Chat connector — send and read messages.
 */

import type { Provider } from '../types.js';
import type { GoogleClient } from './api-client.js';

export interface ChatMessage { id: string; sender: string; text: string; createTime: string; space: string }
export interface ChatSpace { name: string; displayName: string; type: 'ROOM' | 'DM' | 'GROUP_CHAT' }

export class GoogleChatConnector {
  private readonly provider: Provider = 'google';
  constructor(private client: GoogleClient, private accountId: string) {}

  async listSpaces(): Promise<ChatSpace[]> {
    const data = await this.client.get<{ spaces?: ChatSpace[] }>(
      'https://chat.googleapis.com/v1/spaces', undefined, { accountId: this.accountId },
    );
    return data.spaces ?? [];
  }

  async listMessages(spaceName: string, maxResults = 25): Promise<ChatMessage[]> {
    const data = await this.client.get<{
      messages?: { name: string; sender: { displayName: string }; text: string; createTime: string; space: { name: string } }[];
    }>(`https://chat.googleapis.com/v1/${spaceName}/messages`, { pageSize: String(maxResults) }, { accountId: this.accountId });
    return (data.messages ?? []).map((m) => ({
      id: m.name, sender: m.sender.displayName, text: m.text, createTime: m.createTime, space: m.space.name,
    }));
  }

  async sendMessage(spaceName: string, text: string): Promise<ChatMessage> {
    const data = await this.client.post<{
      name: string; sender: { displayName: string }; text: string; createTime: string; space: { name: string };
    }>(`https://chat.googleapis.com/v1/${spaceName}/messages`, { text }, { accountId: this.accountId });
    return { id: data.name, sender: data.sender.displayName, text: data.text, createTime: data.createTime, space: data.space.name };
  }
}

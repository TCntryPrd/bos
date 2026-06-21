/**
 * Microsoft Teams connector via Graph API.
 * Messages, channels, chats.
 */

import type { Provider } from '../types.js';
import type { GraphClient } from './graph-client.js';

export interface TeamsChannel {
  id: string;
  teamId: string;
  displayName: string;
  description?: string;
}

export interface TeamsMessage {
  id: string;
  from: string;
  body: string;
  createdDateTime: string;
  channelId?: string;
  chatId?: string;
}

export interface TeamsChat {
  id: string;
  topic?: string;
  chatType: 'oneOnOne' | 'group' | 'meeting';
  members: string[];
}

export class TeamsConnector {
  private readonly provider: Provider = 'microsoft';

  constructor(
    private client: GraphClient,
    private accountId: string,
  ) {}

  async listChats(): Promise<TeamsChat[]> {
    const data = await this.client.get<{
      value: {
        id: string;
        topic: string | null;
        chatType: string;
        members?: { displayName: string }[];
      }[];
    }>(
      '/me/chats',
      { $top: '50' },
      { accountId: this.accountId },
    );

    return data.value.map((c) => ({
      id: c.id,
      topic: c.topic ?? undefined,
      chatType: c.chatType as TeamsChat['chatType'],
      members: (c.members ?? []).map((m) => m.displayName),
    }));
  }

  async listChatMessages(chatId: string, maxResults = 25): Promise<TeamsMessage[]> {
    const data = await this.client.get<{
      value: {
        id: string;
        from?: { user?: { displayName: string } };
        body: { content: string };
        createdDateTime: string;
      }[];
    }>(
      `/me/chats/${chatId}/messages`,
      { $top: String(maxResults) },
      { accountId: this.accountId },
    );

    return data.value.map((m) => ({
      id: m.id,
      from: m.from?.user?.displayName ?? 'Unknown',
      body: m.body.content,
      createdDateTime: m.createdDateTime,
      chatId,
    }));
  }

  async sendChatMessage(chatId: string, text: string): Promise<TeamsMessage> {
    const data = await this.client.post<{
      id: string;
      from?: { user?: { displayName: string } };
      body: { content: string };
      createdDateTime: string;
    }>(
      `/me/chats/${chatId}/messages`,
      { body: { content: text } },
      { accountId: this.accountId },
    );

    return {
      id: data.id,
      from: data.from?.user?.displayName ?? 'Me',
      body: data.body.content,
      createdDateTime: data.createdDateTime,
      chatId,
    };
  }

  async listTeamChannels(teamId: string): Promise<TeamsChannel[]> {
    const data = await this.client.get<{
      value: { id: string; displayName: string; description?: string }[];
    }>(
      `/teams/${teamId}/channels`,
      undefined,
      { accountId: this.accountId },
    );

    return data.value.map((c) => ({
      id: c.id,
      teamId,
      displayName: c.displayName,
      description: c.description,
    }));
  }

  async sendChannelMessage(
    teamId: string,
    channelId: string,
    text: string,
  ): Promise<TeamsMessage> {
    const data = await this.client.post<{
      id: string;
      from?: { user?: { displayName: string } };
      body: { content: string };
      createdDateTime: string;
    }>(
      `/teams/${teamId}/channels/${channelId}/messages`,
      { body: { content: text } },
      { accountId: this.accountId },
    );

    return {
      id: data.id,
      from: data.from?.user?.displayName ?? 'Me',
      body: data.body.content,
      createdDateTime: data.createdDateTime,
      channelId,
    };
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { graph } from '../src/agent/graph';
import { conversationService } from '../src/services/conversation.service';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, conversationId } = (req.body ?? {}) as {
    message?: string;
    conversationId?: string;
  };

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: '"message" is required' });
  }

  try {
    // Reuse an existing conversation or create a new one.
    let conversation = conversationId
      ? await conversationService.getConversation(conversationId)
      : null;

    if (!conversation) {
      conversation = await conversationService.createConversation();
    }

    const history = await conversationService.getConversationMessages(
      conversation.id,
      10
    );

    const result = await graph.invoke({
      messages: [...history, new HumanMessage(message)],
      conversationId: conversation.id,
      shouldContinue: true,
      toolResults: {},
      iterations: 0,
      metadata: {},
    });

    // The last message in accumulated state is the final AI reply.
    const lastAI = [...(result.messages as AIMessage[])]
      .reverse()
      .find((m) => m instanceof AIMessage);
    const response =
      lastAI && typeof lastAI.content === 'string' ? lastAI.content : '';

    return res.status(200).json({ conversationId: conversation.id, response });
  } catch (error) {
    console.error('[api/chat]', (error as Error).message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * AnthropicClient pre-flight guards + inference_geo passthrough (goal item 14).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { safeFetchLlm } = vi.hoisted(() => ({ safeFetchLlm: vi.fn() }));
vi.mock('../../../src/utils/ssrfGuard', () => ({ safeFetchLlm }));

import { AnthropicClient } from '../../../src/nest/llm-parse/clients/anthropic.client';

const okResponse = () =>
  ({
    ok: true,
    json: async () => ({ content: [{ type: 'tool_use', name: 'emit_reservations', input: { reservations: [] } }] }),
  }) as unknown as Response;

const baseInput = {
  model: 'claude-opus-5',
  prompt: 'extract',
  apiKey: 'k',
  jsonSchema: { type: 'object' },
} as never;

describe('AnthropicClient guards', () => {
  beforeEach(() => {
    safeFetchLlm.mockReset();
    delete process.env.ANTHROPIC_INFERENCE_GEO;
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_INFERENCE_GEO;
  });

  it('rejects documents above 32 MB with an actionable message, without calling the API', async () => {
    const client = new AnthropicClient();
    const big = Buffer.alloc(33 * 1024 * 1024);
    await expect(
      client.extract({ ...(baseInput as object), file: { mimeType: 'application/pdf', data: big } } as never)
    ).rejects.toThrow(/32 MB/);
    expect(safeFetchLlm).not.toHaveBeenCalled();
  });

  it('rejects PDFs with more than 600 detected pages', async () => {
    const client = new AnthropicClient();
    const manyPages = Buffer.from('%PDF-1.4\n' + '/Type /Page\n'.repeat(700), 'latin1');
    await expect(
      client.extract({ ...(baseInput as object), file: { mimeType: 'application/pdf', data: manyPages } } as never)
    ).rejects.toThrow(/pages/);
    expect(safeFetchLlm).not.toHaveBeenCalled();
  });

  it('passes inference_geo as a top-level parameter only when configured', async () => {
    const client = new AnthropicClient();
    safeFetchLlm.mockResolvedValue(okResponse());

    await client.extract({ ...(baseInput as object), text: 'x' } as never);
    let body = JSON.parse((safeFetchLlm.mock.calls[0][1] as { body: string }).body);
    expect(body.inference_geo).toBeUndefined();

    process.env.ANTHROPIC_INFERENCE_GEO = 'us';
    await client.extract({ ...(baseInput as object), text: 'x' } as never);
    body = JSON.parse((safeFetchLlm.mock.calls[1][1] as { body: string }).body);
    expect(body.inference_geo).toBe('us');
  });
});

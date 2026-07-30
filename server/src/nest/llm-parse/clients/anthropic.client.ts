import type { LlmExtractionClient, LlmExtractionInput } from '../llm-provider.interface';
import { safeFetchLlm } from '../../../utils/ssrfGuard';

const TIMEOUT_MS = 120_000;
const MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';
const TOOL_NAME = 'emit_reservations';

// Anthropic request limits for document blocks. TREK's own upload caps are
// looser, so without this pre-flight an oversized file surfaces as an opaque
// provider 4xx instead of an actionable message.
const ANTHROPIC_MAX_DOC_BYTES = 32 * 1024 * 1024;
const ANTHROPIC_MAX_PDF_PAGES = 600;

/** Best-effort PDF page count (object-table scan); null when undetectable. */
function countPdfPages(buf: Buffer): number | null {
  try {
    const sample = buf.toString('latin1');
    const matches = sample.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : null;
  } catch {
    return null;
  }
}

/**
 * Anthropic Messages API client. Structured output via forced tool-use: a single
 * `emit_reservations` tool whose `input_schema` is the reservations schema, with
 * `tool_choice` forcing it — the documented, reliable way to get structured JSON.
 * PDFs go as native base64 `document` blocks (Anthropic reads scanned PDFs).
 * Raw fetch (no SDK) to match the codebase's HTTP style.
 */
export class AnthropicClient implements LlmExtractionClient {
  async extract(input: LlmExtractionInput): Promise<Record<string, unknown>[]> {
    const base = (input.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    const url = `${base}/v1/messages`;

    const content: unknown[] = [];
    if (input.file) {
      if (input.file.data.length > ANTHROPIC_MAX_DOC_BYTES) {
        throw new Error(
          `Document is ${Math.round(input.file.data.length / 1024 / 1024)} MB — the AI parser accepts at most 32 MB. Split or compress the file, or import it without AI.`
        );
      }
      if (input.file.mimeType === 'application/pdf') {
        const pages = countPdfPages(input.file.data);
        if (pages != null && pages > ANTHROPIC_MAX_PDF_PAGES) {
          throw new Error(
            `Document has ~${pages} pages — the AI parser accepts at most ${ANTHROPIC_MAX_PDF_PAGES}. Split the file, or import it without AI.`
          );
        }
      }
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: input.file.mimeType, data: input.file.data.toString('base64') },
      });
    }
    content.push({
      type: 'text',
      text: input.text ? `${USER_TEXT}\n\n${input.text}` : USER_TEXT,
    });

    // Optional data-residency pin (top-level Claude API parameter). Set e.g.
    // ANTHROPIC_INFERENCE_GEO=us to keep traveler documents in one geography;
    // unset sends the request unpinned, exactly as before.
    const inferenceGeo = process.env.ANTHROPIC_INFERENCE_GEO?.trim();

    const body = {
      model: input.model,
      max_tokens: MAX_TOKENS,
      system: input.prompt,
      ...(inferenceGeo ? { inference_geo: inferenceGeo } : {}),
      tools: [
        {
          name: TOOL_NAME,
          description: 'Return the travel reservations extracted from the document.',
          input_schema: input.jsonSchema,
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content }],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      // baseUrl is user-configurable — guard it against pointing at the cloud
      // metadata endpoint, while still allowing a local/LAN gateway.
      res = await safeFetchLlm(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': input.apiKey ?? '',
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic request failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      stop_reason?: string;
      content?: { type: string; name?: string; input?: { reservations?: unknown } }[];
    };

    if (data.stop_reason === 'refusal') {
      throw new Error('Anthropic declined to process this document');
    }

    const toolUse = data.content?.find(b => b.type === 'tool_use' && b.name === TOOL_NAME);
    const reservations = toolUse?.input?.reservations;
    return Array.isArray(reservations) ? (reservations as Record<string, unknown>[]) : [];
  }
}

const USER_TEXT = 'Extract every travel reservation from the following document as schema.org JSON-LD.';
